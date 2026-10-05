import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { initGitFixture, runNode } from "../_helpers.mjs";

// An explicit --tmp-root inside a LINKED worktree is refused: the fixer grant hook reads
// plans only from the main checkout's tmp/gate-fixer/, so such a work order grants nothing.

const SCRIPT = path.resolve("scripts/loop/emit-fixer-work-order.mjs");
const ARGS = ["--harness", "claude", "--repo", "o/r", "--pr", "7", "--head-sha", "a".repeat(40), "--phase", "commit_only", "--threads-file", "missing.json"];

function makeRepo() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "fixer-tmp-root-")));
  const main = path.join(base, "main");
  mkdirSync(main);
  initGitFixture(main);
  const linked = path.join(base, "linked");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", linked], { cwd: main, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  return { base, main, linked };
}

test("--tmp-root inside a linked worktree exits 2, names the main-anchored default, and writes nothing", async () => {
  const { base, main, linked } = makeRepo();
  try {
    const result = await runNode(SCRIPT, [...ARGS, "--tmp-root", path.join(linked, "tmp")], { cwd: linked });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /linked worktree/);
    assert.ok(result.stderr.includes(path.join(main, "tmp")), result.stderr);
    assert.equal(existsSync(path.join(linked, "tmp")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--tmp-root equal to the main checkout tmp/ passes the guard", async () => {
  const { base, main, linked } = makeRepo();
  try {
    const result = await runNode(SCRIPT, [...ARGS, "--tmp-root", path.join(main, "tmp")], { cwd: linked });
    assert.doesNotMatch(result.stderr, /linked worktree/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--help states the linked-worktree rule", async () => {
  const result = await runNode(SCRIPT, ["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /linked worktree/);
});
