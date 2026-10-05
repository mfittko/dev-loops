import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildCarryForwardPlanPath } from "../../scripts/github/write-gate-context.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
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
    assert.equal(existsSync(buildCarryForwardPlanPath({ repo: "o/r", pr: 7, gate: "draft_gate", headSha: HEAD, tmpRoot })), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--tmp-root equal to the main checkout tmp/ carries forward end to end", async () => {
  const { base, main, linked } = makeRepo();
  try {
    const git = (...a) => execFileSync("git", a, { cwd: linked, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
    const prev = git("rev-parse", "HEAD");
    mkdirSync(path.join(linked, "docs"));
    writeFileSync(path.join(linked, "docs", "guide.md"), "# Guide\n");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "delta");
    const head = git("rev-parse", "HEAD");
    const tmpRoot = path.join(main, "tmp");
    const perAngle = [{ angle: "correctness", reviewer: "review-a" }];
    const logPath = buildLogPath({ repo: "o/r", pr: 7, gate: "draft_gate", headSha: prev, tmpRoot });
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, JSON.stringify({ headSha: prev, verdict: "clean", provenance: { distinctReviewers: 1, perAngle } }));
    const argv = ["--repo", "o/r", "--pr", "7", "--gate", "draft_gate", "--prev-head", prev, "--head-sha", head, "--tmp-root", tmpRoot];
    const result = await runNode(SCRIPT, argv, { cwd: linked });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /linked worktree/);
    const planPath = buildCarryForwardPlanPath({ repo: "o/r", pr: 7, gate: "draft_gate", headSha: head, tmpRoot });
    assert.ok(planPath.startsWith(tmpRoot), planPath);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    assert.equal(plan.ok, true);
    assert.equal(plan.headSha, head);
    assert.equal(plan.prevHead, prev);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--help states the linked-worktree rule", async () => {
  const result = await runNode(SCRIPT, ["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /linked worktree/);
});
