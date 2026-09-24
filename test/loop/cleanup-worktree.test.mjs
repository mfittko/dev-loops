import assert from "node:assert/strict";
import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initGitFixture } from "../_helpers.mjs";

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
// Safety invariant: refuse a symlinked namespace that resolves outside repo-root
// ---------------------------------------------------------------------------

test("cleanup: refuses when the namespace dir is a symlink escaping repo-root", () => {
  const base = mkdtempSync(path.join(tmpdir(), "wt-clean-sym-"));
  try {
    const repoRoot = path.join(base, "repo");
    const outside = path.join(base, "outside");
    mkdirSync(path.join(repoRoot, "tmp/worktrees"), { recursive: true });
    // Real target sits OUTSIDE the repo; the namespace dir is a symlink to it.
    mkdirSync(path.join(outside, "issue-909"), { recursive: true });
    symlinkSync(outside, path.join(repoRoot, "tmp/worktrees/dev-loops"));

    const logFile = path.join(base, "git.log");
    const gitPath = writeGitStub(base, { logFile });
    // The lexical path is under the namespace, but its realpath escapes repo-root.
    const res = cleanupWorktree(
      { repoRoot, path: path.join(repoRoot, "tmp/worktrees/dev-loops/issue-909") },
      { gitCommand: gitPath },
    );
    assert.equal(res.ok, false);
    assert.equal(res.removed, null);
    assert.match(res.reason, /refused/);
    // git must NOT have been invoked — nothing outside the namespace removed.
    assert.equal(existsSync(logFile), false);
    assert.ok(existsSync(path.join(outside, "issue-909")), "outside dir untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// --branch selector against a real repo with linked worktrees
// ---------------------------------------------------------------------------

test("parseCleanupWorktreeCliArgs: parses --branch and counts it as a selector", () => {
  assert.equal(parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--branch", "issue-7"]).branch, "issue-7");
  assert.throws(() => parseCleanupWorktreeCliArgs(["--repo-root", "/r", "--branch", "b", "--pr", "2"]), /exactly one/);
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A main checkout with one linked worktree per `{ dir, branch }` under the
// namespace. Returns realpath'd paths.
function makeRepo(worktrees = []) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-branch-")));
  const main = path.join(base, "main");
  mkdirSync(main);
  initGitFixture(main, { branch: "main" });
  const paths = {};
  for (const { dir, branch } of worktrees) {
    const wt = path.join(main, "tmp/worktrees/dev-loops", dir);
    git(main, ["worktree", "add", "-q", "-b", branch, wt]);
    paths[dir] = wt;
  }
  return { base, main, paths };
}

function listedPaths(main) {
  return git(main, ["worktree", "list", "--porcelain"]).split("\n")
    .filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

test("cleanup --branch: resolves issue-<n>, pr-<n>, and a variant-branch worktree by checked-out branch", () => {
  const layouts = [
    { dir: "issue-7", branch: "issue-7" },
    { dir: "pr-12", branch: "feature/pr-work" },
    { dir: "issue-7-b", branch: "issue-7-variant-b" },
  ];
  const { base, main, paths } = makeRepo(layouts);
  try {
    for (const { dir, branch } of layouts) {
      const res = cleanupWorktree({ repoRoot: main, branch });
      assert.equal(res.ok, true, dir);
      assert.equal(res.removed, paths[dir], dir);
      assert.equal(existsSync(paths[dir]), false, `${dir} is gone`);
      assert.ok(!listedPaths(main).includes(paths[dir]), `${dir} is no longer listed`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: no matching worktree is a stated skip that removes nothing", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const before = listedPaths(main);
    const res = cleanupWorktree({ repoRoot: main, branch: "no-such-branch" });
    assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null });
    assert.match(res.reason, /no linked worktree .*no-such-branch/);
    assert.deepEqual(listedPaths(main), before);
    assert.ok(existsSync(paths["issue-7"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup --branch: never selects the main checkout or a worktree outside the namespace", () => {
  const { base, main } = makeRepo();
  try {
    const outside = path.join(main, "tmp/worktrees/my-experiment");
    git(main, ["worktree", "add", "-q", "-b", "experiment", outside]);
    const before = listedPaths(main);
    for (const branch of ["main", "experiment"]) {
      const res = cleanupWorktree({ repoRoot: main, branch });
      assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null }, branch);
      assert.match(res.reason, /skipped/, branch);
    }
    assert.deepEqual(listedPaths(main), before);
    assert.ok(existsSync(outside));
    assert.ok(existsSync(path.join(main, ".git")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cleanup: skips a worktree holding gate findings ledgers, for every selector", () => {
  const { base, main, paths } = makeRepo([{ dir: "issue-7", branch: "issue-7" }]);
  try {
    const ledgerDir = path.join(paths["issue-7"], "tmp/gate-findings");
    const ledger = path.join(ledgerDir, "owner-repo/pr-7/pre_approval_gate-abc.json");
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, "{}\n");
    for (const selector of [{ branch: "issue-7" }, { issue: 7 }, { path: paths["issue-7"] }]) {
      const res = cleanupWorktree({ repoRoot: main, ...selector });
      assert.deepEqual({ ok: res.ok, removed: res.removed }, { ok: true, removed: null }, JSON.stringify(selector));
      assert.ok(res.reason.includes(ledgerDir), res.reason);
    }
    assert.ok(existsSync(ledger), "the ledger survives");
    assert.ok(listedPaths(main).includes(paths["issue-7"]));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
