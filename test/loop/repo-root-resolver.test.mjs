import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { TOOLCHAIN_ROOT, isDevLoopsCheckout, resolveRepoRoot, resolveLedgerCheckouts, toolchainRootMismatch } from "../../scripts/loop/_repo-root-resolver.mjs";
import { initGitFixture } from "../_helpers.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

async function makeRepo() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-repo-root-")));
  initGitFixture(dir);
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

test("repo markers make an explicit root authoritative without Git discovery", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-marked-root-")));
  try {
    await writeFile(path.join(dir, ".devloops"), "version: 1\n", "utf8");
    assert.equal(resolveRepoRoot(dir, { gitCommand: "must-not-run" }), dir);
    assert.deepEqual(resolveLedgerCheckouts(dir, { gitCommand: "must-not-run" }), [dir]);
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

// #2506: the toolchain guard. A --repo-root that names another dev-loops source checkout refuses.
async function makeDevLoopsCheckout(name = "dev-loops") {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dev-loops-toolchain-guard-")));
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

test("toolchainRootMismatch: refuses another dev-loops checkout and names the launcher command", async () => {
  const other = await makeDevLoopsCheckout();
  try {
    const message = toolchainRootMismatch(other, "scripts/loop/judge-pass.mjs");
    assert.match(message, /^toolchain_root_mismatch: /);
    assert.ok(message.includes(`dev-loops-run --repo-root ${other} scripts/loop/judge-pass.mjs`), message);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test("toolchainRootMismatch: passes the own checkout, a symlink to it, and a non-dev-loops directory", async () => {
  const foreign = await makeDevLoopsCheckout("some-consumer-app");
  const link = path.join(foreign, "toolchain-link");
  try {
    await symlink(TOOLCHAIN_ROOT, link);
    assert.equal(isDevLoopsCheckout(TOOLCHAIN_ROOT), true);
    assert.equal(toolchainRootMismatch(TOOLCHAIN_ROOT, "x.mjs"), null);
    assert.equal(toolchainRootMismatch(link, "x.mjs"), null);
    assert.equal(toolchainRootMismatch(foreign, "x.mjs"), null);
    assert.equal(toolchainRootMismatch(path.join(foreign, "absent"), "x.mjs"), null);
  } finally {
    await rm(foreign, { recursive: true, force: true });
  }
});

const SHA = "a".repeat(40);
for (const [script, args] of [
  ["scripts/loop/consolidate-fanin.mjs", ["--findings-dir", os.tmpdir()]],
  ["scripts/loop/judge-pass.mjs", ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", SHA, "--findings-file", "f.json", "--judge-verdict", "v.json", "--judge-plan", "p.json"]],
  ["scripts/claude/generate-claude-assets.mjs", ["--check"]],
]) {
  test(`${script}: a --repo-root naming another dev-loops checkout exits non-zero with toolchain_root_mismatch`, async () => {
    const other = await makeDevLoopsCheckout();
    try {
      const r = spawnSync(process.execPath, [path.join(TOOLCHAIN_ROOT, script), ...args, "--repo-root", other], { cwd: other, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /toolchain_root_mismatch/);
      assert.ok(r.stderr.includes(`dev-loops-run --repo-root ${other} ${script}`), r.stderr);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
}
