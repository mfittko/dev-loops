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

// ---------------------------------------------------------------------------
// #1135: per-angle gate reviewers must not run in an isolated worktree that
// lacks the seeded gate-context bundle. --context-path makes that check
// mechanical: fail closed when the seeded artifact isn't present at the
// reviewer's cwd (which is exactly what an isolated worktree checked out
// from stale main would look like, since tmp/ is gitignored and
// worktree-local).
// ---------------------------------------------------------------------------

test("verify-fresh-review-context --context-path fails closed when the gate-context artifact is missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(
      ["--scope", "coverage", "--context-path", "tmp/gate-context/owner-repo/pr-1/draft_gate-abc1234.json"],
      { cwd: tmpDir }
    );
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.ok, true);
    assert.equal(output.fresh, false);
    assert.equal(output.gateContextPresent, false);
    assert.ok(output.reason.includes("gate-context artifact missing"));

    // The context-path check runs BEFORE sentinel creation, so a fail-closed
    // run must NOT burn the scope sentinel: a retry from the corrected
    // worktree/head (artifact now present, same cwd+scope+round) still passes
    // fresh. Reordering the checks (sentinel-first) would leave a sentinel
    // behind and falsely flag the corrected retry as contaminated.
    assert.equal(output.sentinelCreated, false);
    const ctxRelPath = "tmp/gate-context/owner-repo/pr-1/draft_gate-abc1234.json";
    await mkdir(path.join(tmpDir, "tmp", "gate-context", "owner-repo", "pr-1"), { recursive: true });
    await writeFile(path.join(tmpDir, ctxRelPath), JSON.stringify({ adjacentCode: { files: [] } }) + "\n", "utf8");
    const retry = runScript(["--scope", "coverage", "--context-path", ctxRelPath], { cwd: tmpDir });
    assert.equal(retry.status, 0, retry.stderr);
    const retryOutput = JSON.parse(retry.stdout.trim());
    assert.equal(retryOutput.fresh, true);
    assert.equal(retryOutput.gateContextPresent, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --context-path passes through when the gate-context artifact is present", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    const ctxDir = path.join(tmpDir, "tmp", "gate-context", "owner-repo", "pr-1");
    await mkdir(ctxDir, { recursive: true });
    const ctxRelPath = "tmp/gate-context/owner-repo/pr-1/draft_gate-abc1234.json";
    await writeFile(path.join(tmpDir, ctxRelPath), JSON.stringify({ adjacentCode: { files: [] } }) + "\n", "utf8");
    const result = runScript(["--scope", "coverage", "--context-path", ctxRelPath], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, true);
    assert.equal(output.gateContextPresent, true);
    assert.equal(output.gateContextPath, ctxRelPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --context-path fails closed when the path resolves outside cwd (absolute path to another worktree)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  const otherDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-other-wt-"));
  try {
    // A real bundle exists in a DIFFERENT worktree; an absolute path to it must
    // NOT pass the guard, or an isolated/stale reviewer could game worktree-locality.
    const ctxDir = path.join(otherDir, "tmp", "gate-context", "owner-repo", "pr-1");
    await mkdir(ctxDir, { recursive: true });
    const absPath = path.join(ctxDir, "draft_gate-abc1234.json");
    await writeFile(absPath, JSON.stringify({ adjacentCode: { files: [] } }) + "\n", "utf8");
    const result = runScript(["--scope", "coverage", "--context-path", absPath], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, false);
    assert.equal(output.gateContextPresent, false);
    assert.ok(output.reason.includes("outside the reviewer's working directory"), output.reason);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await rm(otherDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --context-path fails closed on a ..-escaping path", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(
      ["--scope", "coverage", "--context-path", "../escape/gate-context/draft_gate-abc1234.json"],
      { cwd: tmpDir }
    );
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, false);
    assert.equal(output.gateContextPresent, false);
    assert.ok(output.reason.includes("outside the reviewer's working directory"), output.reason);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --context-path with missing value fails closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(["--context-path"], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stderr);
    // Bind the assertion to the intended cause, not just any exit-2 parse error.
    assert.ok(result.stderr.includes("context-path"), result.stderr);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context --context-path with a flag-like value fails closed (does not consume the next flag)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(["--context-path", "--scope", "coverage"], { cwd: tmpDir });
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes("context-path"), result.stderr);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// #1207: GATE-EXEC-BRIEFING-PREFIX enforcement — record a hash of the
// invariant briefing block on the reviewer's sentinel so
// verify-briefing-prefixes.mjs can compare it across reviewers.
// ---------------------------------------------------------------------------

test("--prefix-hash is recorded on the sentinel and echoed in the result", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const hash = "a".repeat(64);
    const result = runScript(["--scope", "coverage", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, true);
    assert.equal(output.prefixHash, hash);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--prefix-hash rejects a non-sha256-shaped value", async () => {
  const result = runScript(["--scope", "coverage", "--prefix-hash", "not-a-hash"]);
  assert.equal(result.status, 2, result.stderr);
});

test("--prefix-hash uppercase input is normalized to lowercase on the sentinel", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const hash = "AB".repeat(32);
    const result = runScript(["--scope", "coverage", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).prefixHash, hash.toLowerCase());
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--prefix-file hashes the file's bytes (sha256) and records the digest", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    await writeFile(path.join(tmpDir, "prefix.txt"), "invariant block content", "utf8");
    const result = runScript(["--scope", "coverage", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.match(output.prefixHash, /^[0-9a-f]{64}$/);

    // Deterministic: hashing the same bytes again (different scope, same file)
    // yields the SAME digest — the positive case verify-briefing-prefixes.mjs relies on.
    const result2 = runScript(["--scope", "other-angle", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(result2.status, 0, result2.stderr);
    assert.equal(JSON.parse(result2.stdout.trim()).prefixHash, output.prefixHash);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--prefix-file fails closed when the file is missing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(["--scope", "coverage", "--prefix-file", "missing.txt"], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, false);
    assert.ok(output.reason.includes("unreadable"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--prefix-hash and --prefix-file are mutually exclusive", async () => {
  const result = runScript(["--scope", "coverage", "--prefix-hash", "a".repeat(64), "--prefix-file", "x.txt"]);
  assert.equal(result.status, 2, result.stderr);
});

test("without --prefix-hash/--prefix-file, no prefixHash field is recorded (backward compatible)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(["--scope", "coverage"], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal("prefixHash" in output, false);
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

// ---------------------------------------------------------------------------
// Sanctioned same-head PR-body-fix retry: a PR-body/description-only fix does
// not change the head SHA (the round key), so a same-scope + same-head
// re-entry would otherwise always trip the contamination guard. --pr-body-fix-retry
// permits ONE narrow exception, gated on the given prefix hash matching the
// existing sentinel's recorded one exactly (proof the seeded briefing bytes
// were NOT rebuilt, preserving the round's byte-identity invariant).
// ---------------------------------------------------------------------------

test("--pr-body-fix-retry overwrites an existing sentinel when the prefix hash matches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const hash = "a".repeat(64);

    const first = runScript(["--scope", "findings-present", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout.trim()).fresh, true);

    // Plain re-entry (no flag) still fails closed — the escape hatch is opt-in only.
    const collision = runScript(["--scope", "findings-present", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(collision.status, 1, collision.stderr);
    assert.equal(JSON.parse(collision.stdout.trim()).fresh, false);

    const retry = runScript(
      ["--scope", "findings-present", "--prefix-hash", hash, "--pr-body-fix-retry"],
      { cwd: tmpDir },
    );
    assert.equal(retry.status, 0, retry.stderr);
    const retryOutput = JSON.parse(retry.stdout.trim());
    assert.equal(retryOutput.fresh, true);
    assert.equal(retryOutput.sentinelCreated, true);
    assert.equal(retryOutput.prBodyFixRetry, true);
    assert.equal(retryOutput.prefixHash, hash);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--pr-body-fix-retry fails closed when the prefix hash does not match the existing sentinel's recorded hash", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const first = runScript(["--scope", "findings-present", "--prefix-hash", "a".repeat(64)], { cwd: tmpDir });
    assert.equal(first.status, 0, first.stderr);

    // A DIFFERENT hash means the context-builder actually rebuilt the briefing —
    // outside this narrow escape hatch's scope; still fail closed.
    const retry = runScript(
      ["--scope", "findings-present", "--prefix-hash", "b".repeat(64), "--pr-body-fix-retry"],
      { cwd: tmpDir },
    );
    assert.equal(retry.status, 1, retry.stderr);
    const output = JSON.parse(retry.stdout.trim());
    assert.equal(output.fresh, false);
    assert.ok(output.reason.includes("DIFFERENT prefix hash"), output.reason);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--pr-body-fix-retry fails closed when the existing sentinel recorded no prefix hash", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    // Existing sentinel with no prefixHash at all (predates GATE-EXEC-BRIEFING-PREFIX
    // enforcement, or a caller that never passed --prefix-hash/--prefix-file).
    const first = runScript(["--scope", "findings-present"], { cwd: tmpDir });
    assert.equal(first.status, 0, first.stderr);

    const retry = runScript(
      ["--scope", "findings-present", "--prefix-hash", "a".repeat(64), "--pr-body-fix-retry"],
      { cwd: tmpDir },
    );
    assert.equal(retry.status, 1, retry.stderr);
    const output = JSON.parse(retry.stdout.trim());
    assert.equal(output.fresh, false);
    assert.ok(output.reason.includes("no prefix hash"), output.reason);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--pr-body-fix-retry requires --prefix-hash or --prefix-file", async () => {
  const result = runScript(["--scope", "findings-present", "--pr-body-fix-retry"]);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes("pr-body-fix-retry"), result.stderr);
});

test("--pr-body-fix-retry on a first run (no existing sentinel) behaves like a normal fresh run", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const result = runScript(
      ["--scope", "findings-present", "--prefix-hash", "a".repeat(64), "--pr-body-fix-retry"],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.fresh, true);
    assert.equal(output.sentinelCreated, true);
    // The flag only changes behavior when a collision actually occurs; a plain
    // first run is unaffected and does not report prBodyFixRetry.
    assert.equal("prBodyFixRetry" in output, false);
    assert.equal("sameHeadRetry" in output, false, "the retry marker never leaks into a first-run output");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Generalized same-head retry (--same-head-retry): the escape hatch covers ANY
// same-head re-run with unrebuilt briefing bytes — interrupted reviewer,
// harness crash, or the original PR-body-fix case. --pr-body-fix-retry stays
// as a deprecated alias with identical semantics.
// ---------------------------------------------------------------------------

test("--same-head-retry re-admits an interrupted reviewer when the prefix hash matches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  const git = makeGit(tmpDir);
  try {
    // Real gate reviews run at a head-keyed round; exercise that path, not the
    // scope-only git-unavailable fallback.
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const hash = "c".repeat(64);

    // Reviewer runs the sentinel, then dies before writing its findings artifact.
    const first = runScript(["--scope", "interrupted-angle", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(first.status, 0, first.stderr);

    // The re-dispatched reviewer passes with the retry flag and the same hash.
    const retry = runScript(
      ["--scope", "interrupted-angle", "--prefix-hash", hash, "--same-head-retry"],
      { cwd: tmpDir },
    );
    assert.equal(retry.status, 0, retry.stderr);
    const output = JSON.parse(retry.stdout.trim());
    assert.equal(output.fresh, true);
    assert.equal(output.sameHeadRetry, true);
    assert.equal(output.prBodyFixRetry, true, "deprecated mirror field kept while callers migrate");
    assert.equal(output.prefixHash, hash);
    assert.match(output.round ?? "", /^[0-9a-f]{40}$/, "the retry happened at the head-keyed round, not the scope-only fallback");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--same-head-retry fails closed on hash mismatch and on a hashless sentinel", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  const git = makeGit(tmpDir);
  try {
    // Head-keyed round, same as the happy-path retry test.
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const hash = "d".repeat(64);

    const first = runScript(["--scope", "mismatch-angle", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(first.status, 0, first.stderr);

    const mismatch = runScript(
      ["--scope", "mismatch-angle", "--prefix-hash", "e".repeat(64), "--same-head-retry"],
      { cwd: tmpDir },
    );
    assert.equal(mismatch.status, 1);
    assert.match(JSON.parse(mismatch.stdout.trim()).reason, /DIFFERENT prefix hash/);

    // Hashless sentinel: create without a prefix hash, then retry with one.
    const hashless = runScript(["--scope", "hashless-angle"], { cwd: tmpDir });
    assert.equal(hashless.status, 0, hashless.stderr);
    const retry = runScript(
      ["--scope", "hashless-angle", "--prefix-hash", hash, "--same-head-retry"],
      { cwd: tmpDir },
    );
    assert.equal(retry.status, 1);
    assert.match(JSON.parse(retry.stdout.trim()).reason, /recorded no prefix hash/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("--same-head-retry without a prefix hash is a usage error, and the alias emits the new field", async () => {
  const bare = runScript(["--scope", "findings-present", "--same-head-retry"]);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--same-head-retry \(alias --pr-body-fix-retry\) requires/);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-"));
  const git = makeGit(tmpDir);
  try {
    // Head-keyed round, same as the other retry tests.
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const hash = "f".repeat(64);
    const first = runScript(["--scope", "alias-angle", "--prefix-hash", hash], { cwd: tmpDir });
    assert.equal(first.status, 0, first.stderr);
    const viaAlias = runScript(
      ["--scope", "alias-angle", "--prefix-hash", hash, "--pr-body-fix-retry"],
      { cwd: tmpDir },
    );
    assert.equal(viaAlias.status, 0, viaAlias.stderr);
    const output = JSON.parse(viaAlias.stdout.trim());
    assert.equal(output.sameHeadRetry, true, "the alias resolves to the same generalized retry");
    assert.equal(output.prBodyFixRetry, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("verify-fresh-review-context reports the validated repo root on fresh runs only", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-verify-fresh-root-"));
  try {
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const fresh = runScript(["--scope", "root-probe"], { cwd: tmpDir });
    assert.equal(fresh.status, 0, fresh.stderr);
    const output = JSON.parse(fresh.stdout.trim());
    // The reported root is the cwd the sentinel validated — the authoritative
    // path for `git -C <repoRoot>` in cwd-resetting reviewer shells.
    assert.equal(output.repoRoot, await realpathOf(tmpDir));
    const refused = runScript(["--scope", "root-probe"], { cwd: tmpDir });
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout.trim()).repoRoot, undefined);
    // The sanctioned same-head retry (matching prefix hash) is also a fresh
    // run and must carry the root too.
    const prefixPath = path.join(tmpDir, "prefix.txt");
    await writeFile(prefixPath, "invariant prefix bytes", "utf8");
    const seeded = runScript(["--scope", "retry-probe", "--prefix-file", prefixPath], { cwd: tmpDir });
    assert.equal(seeded.status, 0, seeded.stderr);
    const retried = runScript(["--scope", "retry-probe", "--prefix-file", prefixPath, "--same-head-retry"], { cwd: tmpDir });
    assert.equal(retried.status, 0, retried.stderr);
    const retryOut = JSON.parse(retried.stdout.trim());
    assert.equal(retryOut.sameHeadRetry, true);
    assert.equal(retryOut.repoRoot, await realpathOf(tmpDir));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function realpathOf(p) {
  const { realpath } = await import("node:fs/promises");
  return realpath(p);
}
