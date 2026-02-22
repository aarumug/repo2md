import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  splitNull,
  looksBinary,
  chooseFence,
  extToLang,
  isImageFile,
  matchesGlob,
  shouldInclude,
} from "../repo2md.mjs";

test("parseArgs returns expected defaults", () => {
  const args = parseArgs(["node", "repo2md.mjs"]);

  assert.equal(args.out, null); // default; actual filename is resolved in main()
  assert.equal(args.encoding, process.env.ENCODING || "o200k_base");
  assert.equal(args.maxTokens, Number(process.env.MAX_TOKENS || "0"));
  assert.equal(args.rev, null);
  assert.equal(args.includeTree, true);
});

test("parseArgs parses output and flags", () => {
  const args = parseArgs([
    "node",
    "repo2md.mjs",
    "out.md",
    "--encoding",
    "cl100k_base",
    "--max-tokens",
    "123",
    "--rev",
    "HEAD",
    "--no-tree",
  ]);

  assert.equal(args.out, "out.md");
  assert.equal(args.encoding, "cl100k_base");
  assert.equal(args.maxTokens, 123);
  assert.equal(args.rev, "HEAD");
  assert.equal(args.includeTree, false);
});

test("splitNull splits NUL-separated git-style output", () => {
  const buf = Buffer.from("a.txt\0b/c.js\0\0", "utf8");
  const parts = splitNull(buf);

  assert.deepEqual(parts, ["a.txt", "b/c.js"]);
});

test("looksBinary detects NUL bytes in buffers", () => {
  assert.equal(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true);
  assert.equal(looksBinary(Buffer.from("plain text", "utf8")), false);
});

test("chooseFence grows past max backtick run", () => {
  assert.equal(chooseFence("no ticks"), "```");
  assert.equal(chooseFence("contains ``` fence"), "````");
});

test("extToLang maps extension or falls back to text", () => {
  assert.equal(extToLang("src/index.js"), "js");
  assert.equal(extToLang("README"), "text");
});

test("parseArgs parses --include and --exclude flags", () => {
  const args = parseArgs([
    "node", "repo2md.mjs",
    "--include", "**/*.js",
    "--include", "**/*.ts",
    "--exclude", "tests/**",
  ]);
  assert.deepEqual(args.include, ["**/*.js", "**/*.ts"]);
  assert.deepEqual(args.exclude, ["tests/**"]);
});

test("parseArgs defaults include/exclude to empty arrays", () => {
  const args = parseArgs(["node", "repo2md.mjs"]);
  assert.deepEqual(args.include, []);
  assert.deepEqual(args.exclude, []);
});

test("isImageFile detects common image extensions", () => {
  assert.equal(isImageFile("photo.png"), true);
  assert.equal(isImageFile("photo.PNG"), true);
  assert.equal(isImageFile("icon.svg"), true);
  assert.equal(isImageFile("img/hero.webp"), true);
  assert.equal(isImageFile("src/index.js"), false);
  assert.equal(isImageFile("README.md"), false);
});

test("matchesGlob: * matches within path segment", () => {
  assert.equal(matchesGlob("*.js", "index.js"), true);
  assert.equal(matchesGlob("*.js", "src/index.js"), true);   // basename match
  assert.equal(matchesGlob("*.js", "index.ts"), false);
});

test("matchesGlob: ** matches across path segments", () => {
  assert.equal(matchesGlob("**/*.js", "index.js"), true);
  assert.equal(matchesGlob("**/*.js", "src/index.js"), true);
  assert.equal(matchesGlob("**/*.js", "src/util/index.js"), true);
  assert.equal(matchesGlob("**/*.js", "src/index.ts"), false);
});

test("matchesGlob: directory prefix pattern", () => {
  assert.equal(matchesGlob("src/**", "src/index.js"), true);
  assert.equal(matchesGlob("src/**", "src/util/index.js"), true);
  assert.equal(matchesGlob("src/**", "lib/index.js"), false);
});

test("matchesGlob: {a,b} alternation", () => {
  assert.equal(matchesGlob("*.{js,ts}", "index.js"), true);
  assert.equal(matchesGlob("*.{js,ts}", "index.ts"), true);
  assert.equal(matchesGlob("*.{js,ts}", "index.py"), false);
});

test("shouldInclude: images always excluded", () => {
  assert.equal(shouldInclude("assets/logo.png", [], []), false);
  assert.equal(shouldInclude("src/index.js", [], []), true);
});

test("shouldInclude: include patterns filter files", () => {
  assert.equal(shouldInclude("src/index.js", ["**/*.js"], []), true);
  assert.equal(shouldInclude("src/index.ts", ["**/*.js"], []), false);
});

test("shouldInclude: exclude patterns remove files", () => {
  assert.equal(shouldInclude("tests/foo.test.js", [], ["tests/**"]), false);
  assert.equal(shouldInclude("src/index.js", [], ["tests/**"]), true);
});

test("shouldInclude: exclude takes precedence over include", () => {
  assert.equal(shouldInclude("src/index.js", ["**/*.js"], ["src/**"]), false);
});
