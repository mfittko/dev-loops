import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GUARD_OVERRIDE_ENV, installDefaultBranchGuard } from "../../packages/core/src/loop/default-branch-guard.mjs";

// End-to-end: drives a REAL git repository through the REAL installed
// pre-commit hook (no stub, no mock) — the same guard installDefaultBranchGuard
// writes for every ensure-worktree-provisioned worktree. Asserting on the
// generated hook's TEXT would pass while the guard never actually ran; this
// suite lets git invoke it.

const REPO_ROOT = path.resolve(".");

// Fixture literal below is assembled from split fragments at RUNTIME — see
// packages/core/test/secret-scan.test.mjs for why.
function join(...parts) {
  return parts.join("");
}

const BASE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
delete BASE_GIT_ENV[GUARD_OVERRIDE_ENV];

function git(cwd, args, env = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...BASE_GIT_ENV, ...env } });
}

function commitAttempt(dir, file, content, env = {}) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ["add", file]);
  try {
    // No --quiet: a hook's own stdout is what leaks through git commit's
    // stdout, so keeping the commit summary visible alongside it lets the
    // "no scanner JSON noise" assertion below tell the two apart.
    const stdout = git(dir, ["commit", "-m", `add ${file}`], env);
    return { blocked: false, stdout, stderr: "" };
  } catch (err) {
    return { blocked: true, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

/**
 * A throwaway repo carrying a REAL, runnable copy of the scanner CLI plus a
 * node_modules link to the ACTUAL @dev-loops/core package — mirroring what
 * ensure-worktree's own provisioning does for a real worktree, so the
 * installed hook resolves the real detector module rather than a stub.
 */
async function repoFixtureWithScanner() {
  const dir = await mkdtemp(path.join(tmpdir(), "secret-scan-hook-e2e-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@example.test"]);
  git(dir, ["config", "user.name", "Hook E2E"]);
  await writeFile(path.join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "seed.txt"]);
  git(dir, ["commit", "--quiet", "--no-verify", "-m", "seed"]);
  const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();

  await mkdir(path.join(dir, "scripts", "security"), { recursive: true });
  await cp(path.join(REPO_ROOT, "scripts", "security", "scan-staged-diff.mjs"), path.join(dir, "scripts", "security", "scan-staged-diff.mjs"));
  await cp(path.join(REPO_ROOT, "scripts", "_core-helpers.mjs"), path.join(dir, "scripts", "_core-helpers.mjs"));
  await cp(path.join(REPO_ROOT, "scripts", "_cli-primitives.mjs"), path.join(dir, "scripts", "_cli-primitives.mjs"));
  await mkdir(path.join(dir, "scripts", "lib"), { recursive: true });
  await cp(path.join(REPO_ROOT, "scripts", "lib", "jq-output.mjs"), path.join(dir, "scripts", "lib", "jq-output.mjs"));
  await mkdir(path.join(dir, "node_modules", "@dev-loops"), { recursive: true });
  await symlink(path.join(REPO_ROOT, "packages", "core"), path.join(dir, "node_modules", "@dev-loops", "core"), "dir");

  // Guards a branch OTHER than "main" (the branch every commit below actually
  // lands on): the default-branch guard's own refusal is a separate concern
  // with its own suite (default-branch-guard.test.mjs) — installing it
  // against a branch nothing here is ever ON isolates these tests to the
  // secret-scan behavior alone.
  installDefaultBranchGuard({ gitDir, defaultBranches: "not-the-test-branch" });
  return dir;
}

test("pre-commit hook e2e: a clean staged diff commits normally", async () => {
  const dir = await repoFixtureWithScanner();
  try {
    const result = commitAttempt(dir, "clean.txt", "nothing sensitive here\n");
    assert.equal(result.blocked, false, `expected a clean commit to succeed: ${result.stderr}`);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "2");
    // Quiet on success: the scanner's own `{"ok":true,...}` payload must not
    // leak into a normal commit's stdout.
    assert.ok(!result.stdout.includes('"ok":true'), `expected no scanner JSON noise on a clean commit: ${result.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook e2e: a planted literal credential is blocked by the REAL hook, value never echoed", async () => {
  const dir = await repoFixtureWithScanner();
  const credentialValue = join("ghp_", "C".repeat(20), "d3");
  try {
    const result = commitAttempt(dir, "config.sh", `export TOKEN="${credentialValue}"\n`);
    assert.equal(result.blocked, true, "expected the planted credential to block the commit");
    assert.match(result.stderr, /literal-credential/);
    assert.match(result.stderr, /config\.sh/);
    assert.ok(!result.stdout.includes(credentialValue), "stdout must never contain the matched value");
    assert.ok(!result.stderr.includes(credentialValue), "stderr must never contain the matched value");
    // Refusal must be the only effect: nothing recorded.
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]).trim(), "1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(`pre-commit hook e2e: ${GUARD_OVERRIDE_ENV}=1 does NOT bypass the secret scan (only the default-branch guard)`, async () => {
  const dir = await repoFixtureWithScanner();
  const credentialValue = join("ghp_", "D".repeat(20), "e4");
  try {
    const result = commitAttempt(dir, "config.sh", `export TOKEN="${credentialValue}"\n`, { [GUARD_OVERRIDE_ENV]: "1" });
    assert.equal(result.blocked, true, "the release override must never silence a secret-scan hit");
    assert.ok(!result.stderr.includes(credentialValue));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook e2e: a scanner internal error fails closed and blocks even a clean diff", async () => {
  const dir = await repoFixtureWithScanner();
  try {
    // Corrupt the scanner so it throws instead of scanning — the "scanner
    // internal error" case. A perfectly clean staged diff must still block.
    await writeFile(path.join(dir, "scripts", "security", "scan-staged-diff.mjs"), "throw new Error('scanner boom');\n");
    const result = commitAttempt(dir, "clean.txt", "nothing sensitive here\n");
    assert.equal(result.blocked, true, "a broken scanner must fail CLOSED, not silently allow the commit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook e2e: a worktree with no scanner file (checkout predates the feature) commits normally", async () => {
  // No scripts/security here at all — the default-branch-guard suite's own
  // fixture shape, kept as an explicit e2e case: a missing scanner is a
  // pre-feature checkout, not a bypass, so the hook skips rather than blocks.
  const dir = await mkdtemp(path.join(tmpdir(), "secret-scan-hook-e2e-nosca-"));
  try {
    git(dir, ["init", "--quiet", "--initial-branch=main"]);
    git(dir, ["config", "user.email", "t@example.test"]);
    git(dir, ["config", "user.name", "Hook E2E"]);
    await writeFile(path.join(dir, "seed.txt"), "seed\n");
    git(dir, ["add", "seed.txt"]);
    git(dir, ["commit", "--quiet", "--no-verify", "-m", "seed"]);
    const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();
    installDefaultBranchGuard({ gitDir, defaultBranches: "not-the-test-branch" });

    const result = commitAttempt(dir, "clean.txt", "nothing sensitive here\n");
    assert.equal(result.blocked, false, `expected the commit to succeed with no scanner present: ${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
