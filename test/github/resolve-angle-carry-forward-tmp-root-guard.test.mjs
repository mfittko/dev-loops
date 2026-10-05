import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildCarryForwardPlanPath } from "../../scripts/github/write-gate-context.mjs";
import { initGitFixture, runNode } from "../_helpers.mjs";

// An explicit --tmp-root inside a LINKED worktree is refused, not read as a missing ledger.

const SCRIPT = path.resolve("scripts/github/resolve-angle-carry-forward.mjs");
const PREV = "a".repeat(40);
const HEAD = "b".repeat(40);
const args = (tmpRoot) => ["--repo", "o/r", "--pr", "7", "--gate", "draft_gate", "--prev-head", PREV, "--head-sha", HEAD, "--tmp-root", tmpRoot];

function makeRepo() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "carry-tmp-root-")));
  const main = path.join(base, "main");
  mkdirSync(main);
  initGitFixture(main);
  const linked = path.join(base, "linked");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", linked], { cwd: main, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  return { base, main, linked };
}

test("--tmp-root inside a linked worktree exits 1, names the main-anchored default, and writes no plan", async () => {
  const { base, main, linked } = makeRepo();
  try {
    const tmpRoot = path.join(linked, "tmp");
    const result = await runNode(SCRIPT, args(tmpRoot), { cwd: linked });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /linked worktree/);
    assert.ok(result.stderr.includes(path.join(main, "tmp")), result.stderr);
    assert.doesNotMatch(result.stderr, /findings-log not found/);
    assert.equal(existsSync(path.join(linked, buildCarryForwardPlanPath({ repo: "o/r", pr: 7, gate: "draft_gate", headSha: HEAD, tmpRoot }))), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--tmp-root equal to the main checkout tmp/ passes the guard", async () => {
  const { base, main, linked } = makeRepo();
  try {
    const result = await runNode(SCRIPT, args(path.join(main, "tmp")), { cwd: linked });
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
