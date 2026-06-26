import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cleanupWorktree,
  parseCleanupWorktreeCliArgs,
} from "../../scripts/loop/cleanup-worktree.mjs";

// A git stub that logs its args to a file and exits with `exitCode`.
function writeGitStub(dir, { exitCode = 0, logFile } = {}) {
  const gitPath = path.join(dir, "git");
  const lines = [
    "#!/usr/bin/env sh",
    `echo "$@" >> ${JSON.stringify(logFile)}`,
    `exit ${exitCode}`,
  ];
  writeFileSync(gitPath, lines.join("\n"), { mode: 0o755 });
  return gitPath;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

test("parseCleanupWorktreeCliArgs: requires a selector", () => {
  assert.throws(() => parseCleanupWorktreeCliArgs(["--repo-root", "/r"]), /issue|pr|path/);
});

test("parseCleanupWorktreeCliArgs: rejects multiple selectors", () => {
  assert.throws(
    () => parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--issue", "1", "--pr", "2"]),
    /exactly one/,
  );
});

test("parseCleanupWorktreeCliArgs: parses --issue", () => {
  const o = parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--issue", "909"]);
  assert.equal(o.issue, 909);
});

// ---------------------------------------------------------------------------
// Removal under the namespace
// ---------------------------------------------------------------------------

test("cleanup: removes a path under the namespace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = writeGitStub(dir, { logFile });
    const res = cleanupWorktree(
      { repoRoot: dir, issue: 909 },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, true);
    assert.equal(res.removed, path.join(dir, "tmp/worktrees/dev-loops/issue-909"));
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /worktree remove --force .*issue-909/);
    assert.match(log, /worktree prune/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Safety invariant: refuse paths outside the namespace
// ---------------------------------------------------------------------------

test("cleanup: refuses a path outside tmp/worktrees/dev-loops/", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = writeGitStub(dir, { logFile });
    const res = cleanupWorktree(
      { repoRoot: dir, path: path.join(dir, "tmp/worktrees/my-experiment") },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, false);
    assert.equal(res.removed, null);
    assert.match(res.reason, /refused/);
    // git must not have been invoked
    assert.equal(existsSync(logFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-soft on git error
// ---------------------------------------------------------------------------

test("cleanup: fails soft on a git error (ok true, removed null)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-clean-"));
  try {
    const logFile = path.join(dir, "git.log");
    const gitPath = writeGitStub(dir, { logFile, exitCode: 1 });
    const res = cleanupWorktree(
      { repoRoot: dir, pr: 908 },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, true);
    assert.equal(res.removed, null);
    assert.match(res.reason, /git error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
