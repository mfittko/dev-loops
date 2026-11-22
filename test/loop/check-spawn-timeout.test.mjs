import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  computeSpawnTimeout,
  evaluateSpawnTimeout,
  parseAddedLines,
  ESCAPE_MARKER,
} from "../../scripts/loop/check-spawn-timeout.mjs";
import { runGitFixture } from "../_helpers.mjs";

const run = (content, { file = "scripts/loop/thing.mjs", lines } = {}) => {
  const all = content.split("\n").map((_, i) => i + 1);
  return computeSpawnTimeout({ files: [{ path: file, content, addedLines: lines ?? all }] });
};

test("blocks a spawnSync call without a timeout", () => {
  const out = run('const r = spawnSync("git", ["status"]);');
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].call, "spawnSync");
  assert.equal(out.findings[0].line, 1);
});

test("passes a multi-line call that sets timeout or timeoutMs", () => {
  assert.equal(run('execFileSync("git", ["log"], {\n  cwd,\n  timeout: 5000,\n});').outcome, "pass");
  assert.equal(run('runChild("node", args, {\n  timeoutMs: 5000,\n});').outcome, "pass");
});

test("a reasoned allow marker passes and a bare marker blocks", () => {
  assert.equal(run(`// ${ESCAPE_MARKER} interactive editor\nspawnSync("vim");`).outcome, "pass");
  assert.equal(run(`spawnSync("vim"); // ${ESCAPE_MARKER} interactive editor`).outcome, "pass");
  assert.equal(run(`// ${ESCAPE_MARKER}\nspawnSync("vim");`).outcome, "block");
});

test("ignores test files, out-of-scope paths, definitions, imports, member calls and untouched lines", () => {
  const call = 'spawnSync("git");';
  assert.equal(run(call, { file: "scripts/loop/thing.test.mjs" }).outcome, "pass");
  assert.equal(run(call, { file: "test/loop/thing.mjs" }).outcome, "pass");
  assert.equal(run(call, { file: "docs/thing.mjs" }).outcome, "pass");
  assert.equal(run("export function runChild(cmd) {}").outcome, "pass");
  assert.equal(run('import { spawnSync } from "node:child_process";').outcome, "pass");
  assert.equal(run("cp.spawnSync(x);").outcome, "pass");
  assert.equal(run(`${call}\nconst x = 1;`, { lines: [2] }).outcome, "pass");
});

test("parseAddedLines reads added line numbers for in-scope files only", () => {
  const diff = [
    "diff --git a/scripts/a.mjs b/scripts/a.mjs",
    "+++ b/scripts/a.mjs",
    "@@ -1,0 +2,2 @@",
    "@@ -9 +12 @@",
    "@@ -20,3 +30,0 @@",
    "diff --git a/docs/b.mjs b/docs/b.mjs",
    "+++ b/docs/b.mjs",
    "@@ -0,0 +1 @@",
  ].join("\n");
  assert.deepEqual([...parseAddedLines(diff)], [["scripts/a.mjs", [2, 3, 12]]]);
});

test("scans only changed files in a git repo", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-spawn-timeout-"));
  try {
    runGitFixture(dir, ["init", "-q", "-b", "main"]);
    runGitFixture(dir, ["config", "user.email", "t@t"]);
    runGitFixture(dir, ["config", "user.name", "t"]);
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(path.join(dir, "scripts/old.mjs"), 'spawnSync("git");\n');
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-q", "-m", "base"]);
    runGitFixture(dir, ["checkout", "-q", "-b", "feat"]);
    await writeFile(path.join(dir, "scripts/new.mjs"), 'const a = 1;\nspawnSync("git");\n');
    runGitFixture(dir, ["add", "."]);
    runGitFixture(dir, ["commit", "-q", "-m", "feat"]);
    const out = await evaluateSpawnTimeout({ base: "main", head: "HEAD", repoRoot: dir });
    assert.equal(out.outcome, "block");
    assert.deepEqual(out.findings.map((f) => [f.path, f.line]), [["scripts/new.mjs", 2]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
