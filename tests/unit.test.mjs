import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  splitNull,
  looksBinary,
  chooseFence,
  extToLang,
} from "../repo2md.mjs";

test("parseArgs returns expected defaults", () => {
  const args = parseArgs(["node", "repo2md.mjs"]);

  assert.equal(args.out, "flattened.md");
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
