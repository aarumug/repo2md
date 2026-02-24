import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve("repo2md.mjs");

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
}

function setupTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo2md-test-"));

  run("git", ["init"], dir);
  run("git", ["config", "user.email", "tests@example.com"], dir);
  run("git", ["config", "user.name", "repo2md-tests"], dir);

  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# Temp Repo\n", "utf8");
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(dir, "untracked.txt"), "not tracked\n", "utf8");

  run("git", ["add", "src/index.js", "README.md", "bin.dat"], dir);
  run("git", ["commit", "-m", "initial"], dir);

  return dir;
}

function setupTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo2md-nongit-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "export const y = 2;\n", "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# Non Git Folder\n", "utf8");
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  return dir;
}

test("CLI writes flattened output and skips binary/untracked files", () => {
  const cwd = setupTempRepo();
  const out = "flat.md";

  run(process.execPath, [scriptPath, out], cwd);

  const text = fs.readFileSync(path.join(cwd, out), "utf8");
  assert.match(text, /# Repository Flattened View/);
  assert.match(text, /## Repository Tree/);
  assert.match(text, /## `src\/index\.js`/);
  assert.match(text, /## `README\.md`/);
  assert.match(text, /bin\.dat/);
  assert.doesNotMatch(text, /## `bin\.dat`/);
  assert.doesNotMatch(text, /untracked\.txt/);
  assert.match(text, /## Token Count/);
});

test("CLI respects --no-tree and --rev", () => {
  const cwd = setupTempRepo();
  const out = "flat-no-tree.md";

  run(process.execPath, [scriptPath, out, "--rev", "HEAD", "--no-tree"], cwd);

  const text = fs.readFileSync(path.join(cwd, out), "utf8");
  assert.doesNotMatch(text, /## Repository Tree/);
  assert.match(text, /> Revision: `HEAD`/);
  assert.match(text, /## `src\/index\.js`/);
});

test("CLI flattens non-git directories from --root", () => {
  const root = setupTempDir();
  const out = path.join(root, "flat.md");

  run(process.execPath, [scriptPath, out, "--root", root], process.cwd());

  const text = fs.readFileSync(out, "utf8");
  assert.match(text, /## `src\/index\.js`/);
  assert.match(text, /## `README\.md`/);
  assert.doesNotMatch(text, /## `bin\.dat`/);
});

test("CLI rejects --rev for non-git --root", () => {
  const root = setupTempDir();
  const out = path.join(root, "flat.md");

  let error = null;
  try {
    run(process.execPath, [scriptPath, out, "--root", root, "--rev", "HEAD"], process.cwd());
  } catch (e) {
    error = e;
  }

  assert.ok(error);
  assert.match(String(error.stderr || error.message), /--rev requires --root to be inside a Git repository/);
});
