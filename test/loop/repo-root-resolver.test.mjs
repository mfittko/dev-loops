import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRepoRoot, resolveLedgerCheckouts } from "../../scripts/loop/_repo-root-resolver.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

async function makeRepo() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-repo-root-")));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["commit", "--allow-empty", "-q", "-m", "init"]);
  return dir;
}

test("resolveRepoRoot returns git-toplevel when cwd is a subdir of a repo", async () => {
  const repo = await makeRepo();
  try {
    const sub = path.join(repo, "a", "b");
    await mkdir(sub, { recursive: true });
    assert.equal(resolveRepoRoot(sub), repo);
    assert.equal(resolveRepoRoot(repo), repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveRepoRoot falls back to cwd when cwd is not inside a git repo", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-notrepo-")));
  try {
    assert.equal(resolveRepoRoot(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveRepoRoot falls back to cwd when git is unavailable (exec failure)", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-nogit-")));
  try {
    assert.equal(resolveRepoRoot(dir, { gitCommand: `definitely-not-git-${Date.now()}` }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveLedgerCheckouts includes main checkout and worktree, de-duped, cwd-toplevel first", async () => {
  const repo = await makeRepo();
  const wt = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-wt-")));
  const wtPath = path.join(wt, "worktree");
  try {
    git(repo, ["worktree", "add", "-q", "-b", "feature", wtPath]);
    const wtReal = await realpath(wtPath);

    // From the worktree: cwd-toplevel (worktree) must be first, main must be present.
    const fromWt = resolveLedgerCheckouts(wtReal);
    assert.equal(fromWt[0], wtReal, "cwd-toplevel first");
    assert.ok(fromWt.includes(repo), "main checkout present");
    assert.ok(fromWt.includes(wtReal), "worktree present");
    assert.equal(new Set(fromWt).size, fromWt.length, "de-duplicated");

    // From main: main first, worktree present.
    const fromMain = resolveLedgerCheckouts(repo);
    assert.equal(fromMain[0], repo, "cwd-toplevel first");
    assert.ok(fromMain.includes(wtReal), "worktree present");
    assert.equal(new Set(fromMain).size, fromMain.length, "de-duplicated");
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("resolveLedgerCheckouts falls back to cwd when cwd is not inside a git repo", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-notrepo-ledger-")));
  try {
    const roots = resolveLedgerCheckouts(dir);
    assert.deepEqual(roots, [dir]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveLedgerCheckouts returns [dir] when git is unavailable (exec failure)", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-nogit-ledger-")));
  try {
    const roots = resolveLedgerCheckouts(dir, { gitCommand: `definitely-not-git-${Date.now()}` });
    assert.deepEqual(roots, [dir]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
