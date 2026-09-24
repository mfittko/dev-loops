import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";
import { initGitFixture, runNode } from "../_helpers.mjs";

// An explicit --tmp-root inside a LINKED worktree is refused, so a merge-relevant
// ledger can never land where a prune deletes it.

const SCRIPT = path.resolve("scripts/github/write-gate-findings-log.mjs");
const HEAD = "945391c0abcdef1234567890abcdef1234567890";

// `rawBase` keeps the un-realpath'd tmpdir form (macOS /var -> /private/var)
// so the guard's canonicalization is exercised.
function makeRepo() {
  const rawBase = mkdtempSync(path.join(os.tmpdir(), "ledger-tmp-root-"));
  const base = realpathSync(rawBase);
  const main = path.join(base, "main");
  mkdirSync(main);
  initGitFixture(main);
  const linked = path.join(base, "linked");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", linked], { cwd: main, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
  return { rawBase, base, main, linked };
}

function write(cwd, tmpRoot) {
  return runNode(SCRIPT, [
    "--repo", "owner/repo", "--pr", "42", "--gate", "draft_gate", "--head-sha", HEAD,
    "--verdict", "clean", "--findings", "[]", "--tmp-root", tmpRoot,
  ], { cwd });
}

const ledgerPath = (tmpRoot) => buildLogPath({ repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: HEAD, tmpRoot });

test("--tmp-root inside a linked worktree exits non-zero, names the main-anchored default, and writes no file", async () => {
  const { rawBase, base, main, linked } = makeRepo();
  try {
    for (const tmpRoot of [path.join(linked, "tmp"), path.join(rawBase, "linked", "tmp"), "tmp"]) {
      const result = await write(linked, tmpRoot);
      assert.equal(result.code, 1, `${tmpRoot}: ${result.stderr}`);
      assert.ok(result.stderr.includes(path.join(main, "tmp")), result.stderr);
      assert.match(result.stderr, /linked worktree/);
      assert.equal(existsSync(ledgerPath(path.join(linked, "tmp"))), false, tmpRoot);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("with a bare main repo, --tmp-root inside the first linked worktree is still refused", async () => {
  const { base, main } = makeRepo();
  try {
    const bare = path.join(base, "bare.git");
    execFileSync("git", ["clone", "-q", "--bare", main, bare], { stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    const first = path.join(base, "first");
    execFileSync("git", ["worktree", "add", "-q", "-b", "first", first], { cwd: bare, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    const result = await write(first, path.join(first, "tmp"));
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /linked worktree/);
    assert.equal(existsSync(ledgerPath(path.join(first, "tmp"))), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a --tmp-root run from a non-git dir still writes the ledger", async () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ledger-non-git-")));
  try {
    for (const tmpRoot of ["tmp", path.join(dir, "abs-tmp")]) {
      const result = await write(dir, tmpRoot);
      assert.equal(result.code, 0, `${tmpRoot}: ${result.stderr}`);
      assert.ok(existsSync(path.resolve(dir, ledgerPath(tmpRoot))), tmpRoot);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absolute --tmp-root outside any linked worktree still writes the ledger", async () => {
  const { base, main, linked } = makeRepo();
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ledger-outside-")));
  try {
    for (const tmpRoot of [outside, path.join(main, "tmp")]) {
      const result = await write(linked, tmpRoot);
      assert.equal(result.code, 0, `${tmpRoot}: ${result.stderr}`);
      assert.ok(existsSync(ledgerPath(tmpRoot)), tmpRoot);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
