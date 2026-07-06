import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateBriefingPrefixes } from "../../scripts/github/verify-briefing-prefixes.mjs";

const checkerPath = path.resolve("scripts/github/verify-briefing-prefixes.mjs");
const contextGuardPath = path.resolve("scripts/github/verify-fresh-review-context.mjs");

function runChecker(args = [], opts = {}) {
  return spawnSync("node", [checkerPath, ...args], { encoding: "utf8", ...opts });
}

function runContextGuard(args = [], opts = {}) {
  return spawnSync("node", [contextGuardPath, ...args], { encoding: "utf8", ...opts });
}

function makeGit(tmpDir) {
  // Scrub inherited global/system git config so commit signing/hooks on the host
  // cannot make these tests flaky (mirrors verify-fresh-review-context.test.mjs).
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  return (args) => {
    const r = spawnSync("git", args, { cwd: tmpDir, encoding: "utf8", env: gitEnv });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
}

// ---------------------------------------------------------------------------
// Pure function unit tests (no filesystem/subprocess).
// ---------------------------------------------------------------------------

test("evaluateBriefingPrefixes: zero sentinels is trivially verified (nothing to check)", () => {
  assert.deepEqual(evaluateBriefingPrefixes([]), { verified: true, reason: "no sentinels found for this round" });
});

test("evaluateBriefingPrefixes: a single HASHED sentinel verifies (nothing to mismatch)", () => {
  const one = evaluateBriefingPrefixes([{ scope: "a", prefixHash: "h1" }]);
  assert.equal(one.verified, true);
  assert.equal(one.prefixHash, "h1");
});

test("evaluateBriefingPrefixes: a single HASHLESS sentinel fails closed (one-angle retry round, never grandfathered)", () => {
  const result = evaluateBriefingPrefixes([{ scope: "a", prefixHash: null }]);
  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, ["a"]);
});

test("evaluateBriefingPrefixes: identical hashes across distinct scopes verify (positive case)", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "scope-a", prefixHash: "same-hash" },
    { scope: "scope-b", prefixHash: "same-hash" },
    { scope: "scope-c", prefixHash: "same-hash" },
  ]);
  assert.equal(result.verified, true);
  assert.equal(result.prefixHash, "same-hash");
});

test("evaluateBriefingPrefixes: different hashes fail closed (negative case)", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "scope-a", prefixHash: "hash-1" },
    { scope: "scope-b", prefixHash: "hash-2" },
  ]);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("DIFFERENT"));
  assert.equal(result.mismatched.length, 2);
});

test("evaluateBriefingPrefixes: a missing hash fails closed even when other hashes agree (fail-closed, not grandfathered)", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "scope-a", prefixHash: "same-hash" },
    { scope: "scope-b", prefixHash: "same-hash" },
    { scope: "scope-c", prefixHash: null },
  ]);
  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, ["scope-c"]);
});

test("verify-briefing-prefixes --help prints usage and exits 0", () => {
  const result = runChecker(["--help"]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("verify-briefing-prefixes.mjs"));
});

test("verify-briefing-prefixes --head-sha is required", () => {
  const result = runChecker([]);
  assert.equal(result.status, 2);
});

test("verify-briefing-prefixes rejects a malformed --head-sha", () => {
  const result = runChecker(["--head-sha", "not-hex!"]);
  assert.equal(result.status, 2, result.stderr);
});

test("verify-briefing-prefixes exits 0 with reviewerCount 0 when no sentinels exist for the head SHA", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-"));
  try {
    const result = runChecker(["--head-sha", "abc1234"], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, true);
    assert.equal(output.reviewerCount, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Dogfood-style integration (issue #1207 AC3): simulate the exact live flow —
// write two reviewer sentinels via the REAL verify-fresh-review-context.mjs
// CLI (not hand-rolled fixtures), keyed to a real git head SHA, then run the
// checker against that round.
// ---------------------------------------------------------------------------

test("integration: two reviewers seeded from the SAME prefix file via the real CLI verify clean", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-int-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    await writeFile(path.join(tmpDir, "prefix.txt"), "repo/PR/head-sha invariant block", "utf8");

    const r1 = runContextGuard(["--scope", "scope-safety", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runContextGuard(["--scope", "scope-correctness", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r1.stdout.trim()).prefixHash, JSON.parse(r2.stdout.trim()).prefixHash);

    const result = runChecker(["--head-sha", headSha], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, true);
    assert.equal(output.reviewerCount, 2);
    assert.equal(output.prefixHash, JSON.parse(r1.stdout.trim()).prefixHash);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("integration: two reviewers seeded from DIFFERENT prefix content via the real CLI fail closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-int-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    await writeFile(path.join(tmpDir, "prefix-a.txt"), "invariant block, version A", "utf8");
    await writeFile(path.join(tmpDir, "prefix-b.txt"), "invariant block, version B (angle text leaked in!)", "utf8");

    const r1 = runContextGuard(["--scope", "scope-safety", "--prefix-file", "prefix-a.txt"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runContextGuard(["--scope", "scope-correctness", "--prefix-file", "prefix-b.txt"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);

    const result = runChecker(["--head-sha", headSha], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.equal(output.reviewerCount, 2);
    assert.ok(output.reason.includes("DIFFERENT"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("integration: a reviewer sentinel with no recorded prefix hash fails closed even though the others agree", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-int-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    await writeFile(path.join(tmpDir, "prefix.txt"), "shared invariant block", "utf8");

    const r1 = runContextGuard(["--scope", "scope-safety", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    // scope-legacy never records a prefix hash (old-style invocation, no
    // --prefix-hash/--prefix-file) — must NOT be silently grandfathered in.
    const r2 = runContextGuard(["--scope", "scope-legacy"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);

    const result = runChecker(["--head-sha", headSha], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.deepEqual(output.missing, ["scope-legacy"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
