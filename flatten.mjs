#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function usage(exitCode = 0) {
  console.log(`
Usage:
  node flatten.mjs [output.md] [--encoding <enc>] [--max-tokens <n>] [--rev <rev>] [--no-tree]

Examples:
  node flatten.mjs flattened.md
  node flatten.mjs flattened.md --encoding o200k_base
  node flatten.mjs flattened.md --max-tokens 128000
  node flatten.mjs flattened.md --rev HEAD
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    out: "flattened.md",
    encoding: process.env.ENCODING || "o200k_base",
    maxTokens: Number(process.env.MAX_TOKENS || "0"),
    rev: null,
    includeTree: true,
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--encoding") args.encoding = rest[++i];
    else if (a === "--max-tokens") args.maxTokens = Number(rest[++i]);
    else if (a === "--rev") args.rev = rest[++i];
    else if (a === "--no-tree") args.includeTree = false;
    else if (!a.startsWith("-") && args.out === "flattened.md") args.out = a;
    else usage(2);
  }
  return args;
}

// Git helpers
function gitBuffer(args) {
  return execFileSync("git", args, { encoding: "buffer" });
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

function listFilesWorkingTree() {
  // git ls-files -z outputs NUL-separated names [1](https://lunary.ai/openai-tokenizer)
  const buf = gitBuffer(["ls-files", "-z"]);
  return splitNull(buf);
}

function listFilesAtRev(rev) {
  // NUL-separated list of files at a given tree-ish
  const buf = gitBuffer(["ls-tree", "-r", "--name-only", "-z", rev]);
  return splitNull(buf);
}

function readFileTextWorkingTree(file) {
  // read as utf8 with replacement; no external deps
  return fs.readFileSync(file, "utf8");
}

function readFileBlobAtRev(rev, file) {
  // Use git show to read file content at a revision
  // Return Buffer so we can do binary detection reliably
  return gitBuffer(["show", `${rev}:${file}`]);
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

  // Collect file list
  const files = args.rev ? listFilesAtRev(args.rev) : listFilesWorkingTree();

  const out = args.out;
  const ws = fs.createWriteStream(out, { encoding: "utf8" });

  const write = (s) => ws.write(s);

  write(`# Repository Flattened View\n\n`);
  write(`> Generated via \`git\` + Node.js\n`);
  write(`> Token encoding target: \`${args.encoding}\`\n`);
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
      const blob = readFileBlobAtRev(args.rev, f);
      isBin = looksBinary(blob);
      if (!isBin) contentText = blob.toString("utf8");
    } else {
      // working tree
      // If file vanished, skip
      if (!fs.existsSync(f)) continue;
      const txt = readFileTextWorkingTree(f);
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

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
