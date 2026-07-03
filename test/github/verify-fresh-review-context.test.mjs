import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("scripts/github/verify-fresh-review-context.mjs");

function runScript(args = [], opts = {}) {
  return spawnSync("node", [scriptPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

test("verify-fresh-review-context exits 0 on first run (fresh context)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript([], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.fresh, true);
    assert.equal(output.sentinelCreated, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context exits 1 when sentinel already exists", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "tmp", "checkpoint-context-sentinel.json"),
      JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", pid: 1 }) + "\n",
      "utf8"
    );
    const result = runScript([], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.fresh, false);
    assert.ok(output.reason.includes("sentinel already exists"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --help prints usage and exits 0", async () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("verify-fresh-review-context.mjs"));
});

test("verify-fresh-review-context creates tmp dir if needed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    const result = runScript([], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context second run in same dir detects contamination", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const r1 = runScript([], { cwd: tmpDir });
    assert.equal(r1.status, 0);
    assert.equal(JSON.parse(r1.stdout.trim()).fresh, true);

    const r2 = runScript([], { cwd: tmpDir });
    assert.equal(r2.status, 1);
    assert.equal(JSON.parse(r2.stdout.trim()).fresh, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --scope isolates parallel reviewers in same CWD", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });

    const r1 = runScript(["--scope", "angle-coverage"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(JSON.parse(r1.stdout.trim()).fresh, true);

    const r2 = runScript(["--scope", "angle-correctness"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout.trim()).fresh, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --scope re-run with same scope detects contamination", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });

    const r1 = runScript(["--scope", "angle-correctness"], { cwd: tmpDir });
    assert.equal(r1.status, 0);
    assert.equal(JSON.parse(r1.stdout.trim()).fresh, true);

    const r2 = runScript(["--scope", "angle-correctness"], { cwd: tmpDir });
    assert.equal(r2.status, 1);
    assert.equal(JSON.parse(r2.stdout.trim()).fresh, false);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// RFC-2 reconciliation (#895): the injected neutral builder bundle is the
// INTENDED seed (allowed), while main-agent / cross-session state bleed still
// fails closed.
// ---------------------------------------------------------------------------

test("RFC-2: a reviewer seeded with the neutral gate-context bundle is NOT flagged as contaminated", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    // Simulate the build-once neutral bundle being present in the workspace:
    // the gate-context artifact + .diff written by write-gate-context.mjs. These
    // are the INTENDED seed for the reviewer and must NOT count as contamination.
    const ctxDir = path.join(tmpDir, "tmp", "gate-context", "owner-repo", "pr-1");
    await mkdir(ctxDir, { recursive: true });
    await writeFile(
      path.join(ctxDir, "draft_gate-abc1234.json"),
      JSON.stringify({ adjacentCode: { files: [] }, scope: { diffPath: "x.diff" } }) + "\n",
      "utf8",
    );
    await writeFile(path.join(ctxDir, "draft_gate-abc1234.diff"), "diff --git a/x b/x\n", "utf8");

    // First scoped-reviewer run in a fresh session: must be fresh despite the
    // neutral bundle existing on disk.
    const result = runScript(["--scope", "draft-gate-coverage"], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, true);
    assert.equal(output.sentinelCreated, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("RFC-2: genuine cross-session state bleed (prior reviewer sentinel for the same scope) still fails closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    // The neutral bundle is present (allowed)...
    const ctxDir = path.join(tmpDir, "tmp", "gate-context", "owner-repo", "pr-1");
    await mkdir(ctxDir, { recursive: true });
    await writeFile(
      path.join(ctxDir, "draft_gate-abc1234.json"),
      JSON.stringify({ adjacentCode: { files: [] } }) + "\n",
      "utf8",
    );
    // ...but a prior reviewer session for the SAME scope already ran (sentinel
    // present) — that is cross-session state bleed and must fail closed.
    await writeFile(
      path.join(tmpDir, "tmp", "checkpoint-context-sentinel-draft-gate-coverage.json"),
      JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", pid: 1, scope: "draft-gate-coverage" }) + "\n",
      "utf8",
    );
    const result = runScript(["--scope", "draft-gate-coverage"], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, false);
    assert.ok(output.reason.includes("sentinel already exists"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --scope rejects path traversal", async () => {
  const result = runScript(["--scope", "../../.git/config"]);
  assert.equal(result.status, 2, result.stderr);
});

test("verify-fresh-review-context --scope rejects empty value", async () => {
  const result = runScript(["--scope", ""]);
  assert.equal(result.status, 2, result.stderr);
});

test("verify-fresh-review-context --scope rejects values with slashes", async () => {
  const result = runScript(["--scope", "foo/bar"]);
  assert.equal(result.status, 2, result.stderr);
});

test("verify-fresh-review-context --scope with missing value fails closed", async () => {
  // --scope followed by another flag or nothing
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(["--scope"], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stderr);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Head-keyed review rounds (#1095, closes #1108): sentinels are per review
// ROUND, keyed by the current head SHA (git rev-parse HEAD). A retry at a new
// head gets a fresh sentinel with no manual clear; a same-head re-entry still
// fails closed. When git is unavailable the key falls back to scope-only.
// ---------------------------------------------------------------------------

function makeGit(tmpDir) {
  // Scrub inherited global/system git config so commit signing, hooks, or
  // templates on the host cannot make these tests flaky (determinism review).
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  return (args) => {
    const r = spawnSync("git", args, { cwd: tmpDir, encoding: "utf8", env: gitEnv });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
}

test("head round: same scope across commits passes on each new head, fails closed on same head", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });

    // Round auto-resolves to HEAD; first run fresh, keyed by the full head SHA.
    const r1 = runScript(["--scope", "correctness"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    const out1 = JSON.parse(r1.stdout.trim());
    assert.equal(out1.fresh, true);
    assert.equal(out1.round, git(["rev-parse", "HEAD"]).stdout.trim());

    // Same head, same scope -> contamination fail-closed.
    const r1b = runScript(["--scope", "correctness"], { cwd: tmpDir });
    assert.equal(r1b.status, 1, r1b.stderr);
    assert.equal(JSON.parse(r1b.stdout.trim()).fresh, false);

    // New commit -> new head -> fresh again, no manual clear step.
    await writeFile(path.join(tmpDir, "a.txt"), "2", "utf8");
    git(["commit", "-qam", "c2"]);
    const r2 = runScript(["--scope", "correctness"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r2.stdout.trim()).fresh, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("head round: a stale pre-round (scope-only) sentinel does NOT block a new head (#1108)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    // Old-format sentinel from before head-keying — must not collide with the
    // head-keyed round (the #1108 stale-sentinel false positive).
    await writeFile(
      path.join(tmpDir, "tmp", "checkpoint-context-sentinel-correctness.json"),
      JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", pid: 1, scope: "correctness" }) + "\n",
      "utf8"
    );
    const result = runScript(["--scope", "correctness"], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).fresh, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
