import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, test } from "bun:test";

import { main } from "../../scripts/docs/prose-inventory.mjs";
import { runGitFixture } from "../_helpers.mjs";

let dir;
let cwd;
let savedGitDir;
let savedGitWorkTree;
const git = (...args) => runGitFixture(dir, ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args]);
const run = (args) => {
  let out = "";
  let err = "";
  const code = main(args, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
};

beforeAll(() => {
  cwd = process.cwd();
  savedGitDir = process.env.GIT_DIR;
  savedGitWorkTree = process.env.GIT_WORK_TREE;
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  dir = mkdtempSync(path.join(tmpdir(), "prose-inv-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.md"), "<!-- rule: A-ONE -->\nThe actor MUST act now. Other text here.\n");
  writeFileSync(path.join(dir, "same.md"), "<!-- rule: S-ONE -->\nThe actor MUST stay.\n");
  git("add", ".");
  git("commit", "-qm", "base");
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(cwd);
  if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
  if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedGitWorkTree;
  rmSync(dir, { recursive: true, force: true });
});

test("prints the byte table and exits 0 when markers survive", () => {
  const { code, out } = run(["--base", "HEAD", "same.md"]);
  assert.equal(code, 0);
  assert.match(out, /\| path \| base bytes \| base words \| head bytes \| head words \| byte delta \|/);
  assert.match(out, /\| `same\.md` \| \d+ \| \d+ \| \d+ \| \d+ \| 0 \|/);
});

test("an unchanged file has no review required line", () => {
  assert.doesNotMatch(run(["--base", "HEAD", "same.md"]).out, /review required/);
});

test("a reworded MUST sentence is listed as review required", () => {
  writeFileSync(path.join(dir, "a.md"), "<!-- rule: A-ONE -->\nThe actor MUST act soon.\n");
  const { code, out } = run(["--base", "HEAD", "a.md"]);
  assert.equal(code, 0);
  assert.match(out, /review required\): The actor MUST act now\./);
});

test("a missing base marker exits 1", () => {
  writeFileSync(path.join(dir, "a.md"), "The actor MUST act now.\n");
  const { code, out } = run(["--base", "HEAD", "a.md"]);
  assert.equal(code, 1);
  assert.match(out, /error: rule marker A-ONE missing at head/);
});

test("a malformed argument exits 2 with a one-line stderr error and no table", () => {
  const { code, out, err } = run(["a.md"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.equal(err.trim().split("\n").length, 1);
});

test("an unknown revision exits 2", () => {
  const { code, out, err } = run(["--base", "no-such-rev", "a.md"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /unknown revision/);
});

test("an unreadable path exits 2", () => {
  assert.equal(run(["--base", "HEAD", "missing.md"]).code, 2);
});

test("an unreadable working-tree path (committed at base, deleted at head) exits 2", () => {
  writeFileSync(path.join(dir, "gone.md"), "x\n");
  git("add", "gone.md");
  git("commit", "-qm", "gone");
  rmSync(path.join(dir, "gone.md"));
  const { code, err } = run(["--base", "HEAD", "gone.md"]);
  assert.equal(code, 2);
  assert.match(err, /unreadable path/);
});

test("--head <rev> reads the revision, not the working tree", () => {
  const original = readFileSync(path.join(dir, "same.md"), "utf8");
  writeFileSync(path.join(dir, "same.md"), "The marker is gone.\n");
  try {
    assert.equal(run(["--base", "HEAD", "--head", "HEAD", "same.md"]).code, 0);
    assert.equal(run(["--base", "HEAD", "same.md"]).code, 1);
  } finally {
    writeFileSync(path.join(dir, "same.md"), original);
  }
});

test("a directory path with --head exits 2 with empty stdout", () => {
  mkdirSync(path.join(dir, "adir"), { recursive: true });
  writeFileSync(path.join(dir, "adir", "x.md"), "x\n");
  git("add", "adir");
  git("commit", "-qm", "adir");
  const { code, out } = run(["--base", "HEAD", "--head", "HEAD", "adir"]);
  assert.equal(code, 2);
  assert.equal(out, "");
});

test("an absolute path resolves the same on both sides", () => {
  assert.equal(run(["--base", "HEAD", path.join(process.cwd(), "same.md")]).code, 0);
});

test("a cwd-relative path resolves the same on both sides from a subdirectory", () => {
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "s.md"), "<!-- rule: SUB -->\nThe actor MUST sub.\n");
  git("add", "sub");
  git("commit", "-qm", "sub");
  process.chdir(path.join(dir, "sub"));
  try {
    assert.equal(run(["--base", "HEAD", "s.md"]).code, 0);
  } finally {
    process.chdir(dir);
  }
});

test("an empty --head exits 2 with empty stdout", () => {
  const { code, out } = run(["--base", "HEAD", "--head", "", "same.md"]);
  assert.equal(code, 2);
  assert.equal(out, "");
});

test("a dash-leading revision exits 2 and writes no file", () => {
  const target = path.join(dir, "inj");
  for (const arg of [`--base=--output=${target}`, "--base=-p"]) {
    const { code, out } = run([arg, "same.md"]);
    assert.equal(code, 2);
    assert.equal(out, "");
  }
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("inj")), []);
});

test("accepted revision forms exit 0", () => {
  const short = runGitFixture(dir, ["rev-parse", "--short", "HEAD"]);
  for (const rev of ["HEAD", short]) assert.equal(run(["--base", rev, "same.md"]).code, 0);
});
