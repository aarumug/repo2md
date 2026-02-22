#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage(exitCode = 0) {
  console.log(`
Usage:
  node repo2md.mjs [output.md] [--encoding <enc>] [--max-tokens <n>] [--rev <rev>] [--root <dir>] [--no-tree]
                   [--include <pattern>] [--exclude <pattern>]

  If output.md is not specified, defaults to <reponame>_flattened.md
  If --root is not specified, flattens the current directory
  --include and --exclude accept glob patterns (repeatable); images and binary files are always excluded

Examples:
  node repo2md.mjs                                    # Creates repo2md_flattened.md
  node repo2md.mjs custom.md                          # Creates custom.md
  node repo2md.mjs --encoding o200k_base              # Creates repo2md_flattened.md with specific encoding
  node repo2md.mjs --max-tokens 128000                # Creates repo2md_flattened.md with token limit
  node repo2md.mjs --rev HEAD                         # Flattens at specific revision
  node repo2md.mjs --root src                         # Flattens only the src directory
  node repo2md.mjs --include '**/*.js' --include '**/*.ts'  # Only JS/TS files
  node repo2md.mjs --exclude 'tests/**' --exclude '*.md'    # Exclude tests and markdown
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    out: null,
    encoding: process.env.ENCODING || "o200k_base",
    maxTokens: Number(process.env.MAX_TOKENS || "0"),
    rev: null,
    root: ".",
    includeTree: true,
    include: [],
    exclude: [],
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--encoding") args.encoding = rest[++i];
    else if (a === "--max-tokens") args.maxTokens = Number(rest[++i]);
    else if (a === "--rev") args.rev = rest[++i];
    else if (a === "--root") args.root = rest[++i];
    else if (a === "--no-tree") args.includeTree = false;
    else if (a === "--include") args.include.push(rest[++i]);
    else if (a === "--exclude") args.exclude.push(rest[++i]);
    else if (!a.startsWith("-") && args.out === null) args.out = a;
    else usage(2);
  }
  return args;
}

// Git helpers
function gitBuffer(args, cwd) {
  return execFileSync("git", args, { encoding: "buffer", cwd });
}

function gitString(args, cwd) {
  return execFileSync("git", args, { encoding: "utf8", cwd }).trim();
}

function toPosixPath(p) {
  return p.split(path.sep).join("/");
}

function getRepoRoot() {
  return gitString(["rev-parse", "--show-toplevel"], process.cwd());
}

function getRepoName(repoRoot) {
  return path.basename(repoRoot);
}

function toRepoPathspec(rootArg, repoRoot) {
  const rootAbs = path.resolve(process.cwd(), rootArg || ".");
  const rel = path.relative(repoRoot, rootAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Root directory must be inside repository: ${rootArg}`);
  }
  if (!rel || rel === ".") return null;
  return toPosixPath(rel);
}
function splitNull(buf) {
  // buf is a Buffer; split on NUL (0x00)
  const parts = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  // ignore trailing empty
  return parts.filter((p) => p.length > 0);
}

function listFilesWorkingTree(repoRoot, rootPathspec) {
  // git ls-files -z outputs NUL-separated names [1](https://lunary.ai/openai-tokenizer)
  const cmd = ["ls-files", "-z"];
  if (rootPathspec) cmd.push("--", rootPathspec);
  const buf = gitBuffer(cmd, repoRoot);
  return splitNull(buf);
}

function listFilesAtRev(repoRoot, rev, rootPathspec) {
  // NUL-separated list of files at a given tree-ish
  const cmd = ["ls-tree", "-r", "--name-only", "-z", rev];
  if (rootPathspec) cmd.push("--", rootPathspec);
  const buf = gitBuffer(cmd, repoRoot);
  return splitNull(buf);
}

function readFileTextWorkingTree(repoRoot, file) {
  // read as utf8 with replacement; no external deps
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

function readFileBlobAtRev(repoRoot, rev, file) {
  // Use git show to read file content at a revision
  // Return Buffer so we can do binary detection reliably
  return gitBuffer(["show", `${rev}:${file}`], repoRoot);
}

// Binary detection (simple + effective): NUL byte in first chunk
function looksBinary(bufferOrString) {
  const buf =
    typeof bufferOrString === "string"
      ? Buffer.from(bufferOrString, "utf8")
      : bufferOrString;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Choose a code fence that won't be closed by content containing ```
// If content has max run of k backticks, use k+1 (min 3)
function chooseFence(content) {
  let maxRun = 0;
  let run = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "`") {
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  const fenceLen = Math.max(3, maxRun + 1);
  return "`".repeat(fenceLen);
}

function extToLang(filePath) {
  const ext = path.extname(filePath).slice(1);
  return ext || "text";
}

// Image extensions — always excluded regardless of include patterns
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp",
  "tiff", "tif", "avif", "heic", "heif", "svg",
  "raw", "cr2", "nef", "psd", "eps", "exr",
]);

function isImageFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// Glob pattern matching without external dependencies.
// Supports: * ? ** {a,b} [abc]
// Patterns without '/' match against the basename; patterns with '/' match the full path.
function globToRegexStr(pattern) {
  let r = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
      i += 2;
      if (i < pattern.length && pattern[i] === "/") {
        i++; // consume the slash
        r += "(?:[^/]+/)*"; // zero or more path segments (each ending with /)
      } else {
        r += ".*"; // ** at end — match everything
      }
    } else if (c === "*") {
      r += "[^/]*";
      i++;
    } else if (c === "?") {
      r += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) {
        r += "\\{";
        i++;
      } else {
        const alts = pattern.slice(i + 1, end).split(",").map(globToRegexStr);
        r += "(?:" + alts.join("|") + ")";
        i = end + 1;
      }
    } else if (c === "[") {
      // Pass character class through verbatim
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      r += pattern.slice(i, j + 1);
      i = j + 1;
    } else {
      if (".+^$|()|\\".includes(c)) r += "\\";
      r += c;
      i++;
    }
  }
  return r;
}

function matchesGlob(pattern, filePath) {
  const fp = filePath.split(path.sep).join("/");
  // Match against basename when pattern has no slash; full path otherwise
  const hasSlash = pattern.includes("/");
  const target = hasSlash ? fp : (fp.split("/").pop() || fp);
  return new RegExp("^" + globToRegexStr(pattern) + "$").test(target);
}

// Returns true if the file should be included in the output
function shouldInclude(file, include, exclude) {
  if (isImageFile(file)) return false;
  if (include.length > 0 && !include.some((p) => matchesGlob(p, file))) return false;
  if (exclude.some((p) => matchesGlob(p, file))) return false;
  return true;
}

// Optional token counting via JS tiktoken implementation
async function countTokens(text, encodingName) {
  // OpenAI notes a community-supported @dbdq/tiktoken package for JS tokenization. [2](https://en.wikipedia.org/wiki/GNU_Core_Utilities)
  // In practice you may see it published as @dqbd/tiktoken as well; we try both.
  const candidates = ["@dqbd/tiktoken", "@dbdq/tiktoken"];
  for (const pkg of candidates) {
    try {
      const mod = await import(pkg);
      // Different builds export differently; support common shapes
      const get_encoding =
        mod.get_encoding || mod.default?.get_encoding || mod.default?.getEncoding;
      if (!get_encoding) continue;

      const enc = get_encoding(encodingName);
      const tokens = enc.encode(text);
      // free() exists in many builds
      if (typeof enc.free === "function") enc.free();
      return { tokens: tokens.length, method: pkg };
    } catch {
      // try next
    }
  }

  // Fallback approximation (clearly labeled)
  const approx = Math.ceil(text.length / 4);
  return { tokens: approx, method: "approx(chars/4)" };
}

async function main() {
  const args = parseArgs(process.argv);
  // Find the git repo that owns the root directory (may differ from CWD's repo)
  const rootAbs = path.resolve(process.cwd(), args.root || ".");
  const repoRoot = gitString(["rev-parse", "--show-toplevel"], rootAbs);
  const rootPathspec = toRepoPathspec(args.root, repoRoot);

  // Set default output filename based on repo name if not provided
  if (!args.out) {
    const repoName = getRepoName(repoRoot);
    args.out = `${repoName}_flattened.md`;
  }

  // Collect file list
  const allFiles = args.rev
    ? listFilesAtRev(repoRoot, args.rev, rootPathspec)
    : listFilesWorkingTree(repoRoot, rootPathspec);

  // Apply include/exclude patterns; images and binaries are always excluded
  const files = allFiles.filter((f) => shouldInclude(f, args.include, args.exclude));

  const out = args.out;
  const ws = fs.createWriteStream(out, { encoding: "utf8" });

  const write = (s) => ws.write(s);

  write(`# Repository Flattened View\n\n`);
  write(`> Generated via \`git\` + Node.js\n`);
  write(`> Token encoding target: \`${args.encoding}\`\n`);
  write(`> Root: \`${rootPathspec || "."}\`\n`);
  if (args.rev) write(`> Revision: \`${args.rev}\`\n`);
  write(`\n`);

  if (args.includeTree) {
    write(`## Repository Tree\n\n`);
    write("```text\n");
    for (const f of files) write(`${f}\n`);
    write("```\n\n");
  }

  for (const f of files) {
    let contentText = "";
    let isBin = false;

    if (args.rev) {
      const blob = readFileBlobAtRev(repoRoot, args.rev, f);
      isBin = looksBinary(blob);
      if (!isBin) contentText = blob.toString("utf8");
    } else {
      // working tree
      // If file vanished, skip
      const fullPath = path.join(repoRoot, f);
      if (!fs.existsSync(fullPath)) continue;
      const txt = readFileTextWorkingTree(repoRoot, f);
      isBin = looksBinary(txt);
      if (!isBin) contentText = txt;
    }

    if (isBin) continue;

    const lang = extToLang(f);
    const fence = chooseFence(contentText);

    write(`## \`${f}\`\n\n`);
    write(`${fence}${lang}\n`);
    write(contentText);
    if (!contentText.endsWith("\n")) write("\n");
    write(`${fence}\n\n`);
  }

  // Finalize stream before reading it back
  await new Promise((resolve) => ws.end(resolve));

  const flattenedText = fs.readFileSync(out, "utf8");
  const { tokens, method } = await countTokens(flattenedText, args.encoding);

  // Append token summary
  fs.appendFileSync(
    out,
    `---\n## Token Count\n\n- Tokens: **${tokens}**\n- Method: \`${method}\`\n- Encoding: \`${args.encoding}\`\n\n`,
    "utf8"
  );

  // Optional enforcement
  if (args.maxTokens && tokens > args.maxTokens) {
    fs.appendFileSync(
      out,
      `> ⚠️ Token limit exceeded: ${tokens} > ${args.maxTokens}\n`,
      "utf8"
    );
    console.error(`ERROR: Token limit exceeded: ${tokens} > ${args.maxTokens}`);
    process.exit(2);
  }

  console.error(`Wrote ${out} (${tokens} tokens, ${method}, ${args.encoding})`);
}

export {
  parseArgs,
  splitNull,
  listFilesWorkingTree,
  listFilesAtRev,
  readFileTextWorkingTree,
  readFileBlobAtRev,
  looksBinary,
  chooseFence,
  extToLang,
  countTokens,
  getRepoRoot,
  getRepoName,
  isImageFile,
  globToRegexStr,
  matchesGlob,
  shouldInclude,
  main,
};

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(1);
  });
}
