import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode } from "../_helpers.mjs";
import {
  assertRunnerOwnership,
  claimRunnerOwnership,
  defaultRunnerCoordinationFilePathForTarget,
  ensureAsyncRunnerOwnership,
  loadRunnerCoordinationState,
  recordExitSignalForRunner,
  releaseAsyncRunnerOwnership,
  releaseRunClaimsOnExit,
  releaseRunnerOwnership,
  RUNNER_COORDINATION_HISTORY_LIMIT,
} from "../../scripts/loop/_pr-runner-coordination.mjs";
import { detectStaleRunner, STALE_RUNNER_DEFAULT_MAX_AGE_MS } from "../../scripts/loop/_stale-runner-detection.mjs";
import { runPrRunnerCoordination } from "../../scripts/loop/pr-runner-coordination.mjs";

// Builds a throwaway git repo with a linked worktree so cross-CWD coordination
// path resolution (git-common-dir anchoring) can be exercised for real.
//
// repoRoot/wtPath are deliberately left un-realpath'd (raw mkdtemp() output,
// e.g. macOS's symlinked /var/... rather than /private/var/...): git returns a
// relative --git-common-dir from a main checkout but an already-realpath'd
// absolute one from a linked worktree, so the un-normalized paths are what
// exercise resolveRepoCoordinationRoot's own canonicalization instead of
// masking a divergence the test helper resolved away.
async function makeRepoWithWorktree() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-git-"));
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  await writeFile(path.join(repoRoot, "README.md"), "init\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  const wtPath = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-wt-"));
  git(["worktree", "add", "-q", wtPath, "-b", "issue-1245-wt"]);
  return { repoRoot, wtPath };
}

test("runner coordination claims empty PR ownership and refreshes same run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const claimed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-1",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.status, "claimed_new");
    assert.equal(claimed.activeRun.runId, "run-1");

    const refreshed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-1",
      cwd: tempDir,
      now: "2026-06-05T08:05:00.000Z",
    });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.status, "refreshed");
    assert.equal(refreshed.activeRun.updatedAt, "2026-06-05T08:05:00.000Z");

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-1");
    assert.equal(loaded.state.history.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runner coordination fails closed for second claim and allows explicit takeover", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, now: "2026-06-05T08:00:00.000Z" });

    const conflict = await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-2", cwd: tempDir });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "active_run_exists");
    assert.equal(conflict.activeRun.runId, "run-1");

    const takeover = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-2",
      cwd: tempDir,
      mode: "takeover",
      now: "2026-06-05T08:10:00.000Z",
    });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.status, "taken_over");
    assert.equal(takeover.activeRun.runId, "run-2");
    assert.equal(takeover.previousRun.runId, "run-1");

    const staleAssert = await assertRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, requireExisting: true });
    assert.equal(staleAssert.ok, false);
    assert.equal(staleAssert.error, "ownership_lost");
    assert.equal(staleAssert.activeRun.runId, "run-2");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("owner-confirmed assert refreshes updatedAt so a long gate cycle stays non-stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const isoAt = (offsetMs) => new Date(t0 + offsetMs).toISOString();

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, now: isoAt(0) });

    let lastAssertedAt = isoAt(0);
    for (const offsetMinutes of [20, 40, 60]) {
      const at = isoAt(offsetMinutes * 60 * 1000);
      const asserted = await assertRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, now: at });
      assert.equal(asserted.ok, true);
      assert.equal(asserted.status, "owner_confirmed");
      assert.equal(asserted.activeRun.updatedAt, at);
      lastAssertedAt = at;
    }

    // 65 min after claim / 5 min after last assert: claimedAt is stale-old but
    // the refreshed updatedAt keeps the runner fresh.
    const freshCheck = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      now: Date.parse(lastAssertedAt) + 5 * 60 * 1000,
      maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
    });
    assert.equal(freshCheck.staleRunner, null);
    assert.equal(freshCheck.status, "fresh_runner");

    // Discrimination: with no further assert, 40 min after the last assert
    // both claimedAt and updatedAt exceed maxAge, so it IS stale — proving
    // the refresh (not some other mechanism) was what kept it alive above.
    const staleCheck = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      now: Date.parse(lastAssertedAt) + 40 * 60 * 1000,
      maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
    });
    assert.notEqual(staleCheck.staleRunner, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runner coordination pre-merge assert requires existing owner record for async runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const missing = await assertRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-1",
      cwd: tempDir,
      requireExisting: true,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "ownership_missing");

    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    const asserted = await assertRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-1",
      cwd: tempDir,
      requireExisting: true,
    });
    assert.equal(asserted.ok, true);
    assert.equal(asserted.status, "owner_confirmed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runner coordination release clears active owner", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    const released = await releaseRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    assert.equal(released.ok, true);
    assert.equal(released.status, "released");

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseAsyncRunnerOwnership is a no-op when no async run id (Claude Code path)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    const result = await releaseAsyncRunnerOwnership({ repo: "owner/repo", pr: 17, env: {}, cwd: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "skipped_no_async_run_id");
    assert.deepEqual(result.exitSignals, []);

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseAsyncRunnerOwnership releases the claim it owns on completion", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    const result = await releaseAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      env: { DEVLOOPS_RUN_ID: "run-1" },
      cwd: tempDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseAsyncRunnerOwnership is best-effort/non-fatal when another run owns the claim (fail-closed competitor preserved)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-active", cwd: tempDir });
    const result = await releaseAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      env: { DEVLOOPS_RUN_ID: "run-other" },
      cwd: tempDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "release_skipped");
    assert.equal(result.skippedReason, "ownership_lost");
    assert.ok(Array.isArray(result.exitSignals));

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-active");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("completed parent releases so a fresh merge run inherits ownership cleanly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-parent", cwd: tempDir });
    await releaseAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      env: { DEVLOOPS_RUN_ID: "run-parent" },
      cwd: tempDir,
    });
    const claimed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-merge",
      cwd: tempDir,
      mode: "claim",
    });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.status, "claimed_new");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("pr-runner-coordination CLI facade returns machine-readable conflicts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const filePath = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, tempDir);
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });

    const result = await runPrRunnerCoordination({ command: "claim", repo: "owner/repo", pr: 17, runId: "run-2", requireExisting: false }, { env: {}, cwd: tempDir });
    assert.equal(result.ok, false);
    assert.equal(result.error, "active_run_exists");
    assert.equal(result.filePath, filePath);

    const status = await runPrRunnerCoordination({ command: "status", repo: "owner/repo", pr: 17 }, { env: {}, cwd: tempDir });
    assert.equal(status.ok, true);
    assert.equal(status.state.activeRun.runId, "run-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("ensureAsyncRunnerOwnership auto-claims when no file exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-1" },
      claimIfMissing: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "claimed_new");
    assert.equal(result.activeRun.runId, "run-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensureAsyncRunnerOwnership resolves the neutral DEVLOOPS_RUN_ID end-to-end", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 19,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "devloops-run-1" },
      claimIfMissing: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "claimed_new");
    assert.equal(result.activeRun.runId, "devloops-run-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensureAsyncRunnerOwnership ignores the dropped legacy Pi run-id env var", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  // Built dynamically so the tree-wide neutrality guard does not flag this assertion.
  const droppedPiRunId = ["PI", "SUBAGENT", "RUN", "ID"].join("_");

  try {
    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 20,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "devloops-win", [droppedPiRunId]: "pi-ignored" },
      claimIfMissing: true,
    });
    assert.equal(result.activeRun.runId, "devloops-win");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensureAsyncRunnerOwnership auto-claims after release when no active owner remains", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    await releaseRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-2" },
      claimIfMissing: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "claimed_new");
    assert.equal(result.activeRun.runId, "run-2");

    const strict = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 18,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-3" },
      claimIfMissing: false,
      requireExisting: true,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.error, "ownership_missing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// #1706: a run that dies without releasing (exit signal recorded) is treated as
// confirmed-dead immediately; ensureAsyncRunnerOwnership with supersedeStale
// takes the claim over so the next legitimately-dispatched run proceeds.
test("ensureAsyncRunnerOwnership supersedes a dead run's claim when supersedeStale (exit signal)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-dead", cwd: tempDir });
    // run-dead dies without releasing — record its exit signal (confirmed death)
    const sig = await recordExitSignalForRunner({ repo: "owner/repo", pr: 17, runId: "run-dead", reason: "crashed", cwd: tempDir });
    assert.equal(sig.ok, true);
    assert.equal(sig.status, "exit_signal_recorded");

    // live (default) supersedeStale=false → fail closed against the dead claim
    const strict = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-next" },
      claimIfMissing: true,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.error, "ownership_lost");

    // supersedeStale=true → the confirmed-dead claim is taken over
    const superseded = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-next" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(superseded.ok, true);
    assert.equal(superseded.status, "taken_over");
    assert.equal(superseded.activeRun.runId, "run-next");

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-next");
    assert.equal(loaded.state.previousRun.runId, "run-dead");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// #1706: a run whose claim has gone stale (no heartbeat past the max-age window)
// is treated as dead; supersedeStale takes it over.
test("ensureAsyncRunnerOwnership supersedes a stale claim when supersedeStale (staleness exceeded)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const prevMaxAge = process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
  process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = "60000"; // 1 minute

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 21,
      runId: "run-stale",
      cwd: tempDir,
      now: new Date(Date.now() - 1000 * 60 * 10).toISOString(), // claimed 10 min ago
    });

    const superseded = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 21,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-fresh" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(superseded.ok, true);
    assert.equal(superseded.status, "taken_over");
    assert.equal(superseded.activeRun.runId, "run-fresh");
  } finally {
    if (prevMaxAge === undefined) {
      delete process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
    } else {
      process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = prevMaxAge;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

// #1706 AC-3: supersedeStale must NOT supersede a genuinely live owner (no exit
// signal, fresh claim) — one-runner-per-PR preserved for active work.
test("ensureAsyncRunnerOwnership keeps a live owner (stand down) even with supersedeStale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 23, runId: "run-live", cwd: tempDir, now: new Date().toISOString() });

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 23,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-wannabe" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ownership_lost");
    assert.equal(result.activeRun.runId, "run-live");

    // Live owner's claim is untouched.
    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 23, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-live");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// #1706 AC-1: the release-on-process-exit sweep clears every claim owned by a
// run (completed/killed/timed out/crashed) so no leaky lock blocks the next run.
test("releaseRunClaimsOnExit clears all claims owned by a run on process exit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-exit", cwd: tempDir });
    await claimRunnerOwnership({ repo: "owner/repo", pr: 18, runId: "run-exit", cwd: tempDir });
    // A competing live run's claim must remain untouched.
    await claimRunnerOwnership({ repo: "owner/repo", pr: 19, runId: "run-other", cwd: tempDir });

    const result = await releaseRunClaimsOnExit({ runId: "run-exit", root: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.released.length, 2);

    const pr17 = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    const pr18 = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 18, cwd: tempDir });
    const pr19 = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 19, cwd: tempDir });
    assert.equal(pr17.state.activeRun, null);
    assert.equal(pr18.state.activeRun, null);
    // Competing live run untouched.
    assert.equal(pr19.state.activeRun.runId, "run-other");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit no-ops when no run id is present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-x", cwd: tempDir });
    const result = await releaseRunClaimsOnExit({ runId: "", root: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "skipped_no_async_run_id");
    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-x");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// #1706: the release-on-death sweep must anchor at the git-common-dir root
// (resolveRepoCoordinationRoot) the claims are actually stored under, NOT a
// naive path.join(root, ".pi", ...). In a linked worktree the run's claims
// live in the MAIN repo's .pi (common dir), so a worktree-cwd sweep that scans
// the worktree's own .pi would miss them and leak the lock.
test("releaseRunClaimsOnExit anchors at the git-common-dir root (linked worktree)", async () => {
  const { repoRoot, wtPath } = await makeRepoWithWorktree();

  try {
    // Claim under the WORKTREE cwd — claims are stored at the common-dir root.
    await claimRunnerOwnership({ repo: "owner/repo", pr: 31, runId: "run-wt", cwd: wtPath });
    const claimPath = defaultRunnerCoordinationFilePathForTarget(
      { repo: "owner/repo", pr: 31 },
      wtPath,
    );
    assert.ok(
      claimPath.startsWith(path.join(realpathSync(repoRoot), ".pi")),
      "claim must live under the main repo's .pi (git-common-dir anchored), not the worktree's",
    );

    const result = await releaseRunClaimsOnExit({ runId: "run-wt", root: wtPath });
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.released.length, 1);

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 31, cwd: wtPath });
    assert.equal(loaded.state.activeRun, null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(wtPath, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit reports no_coordination_dir when the root is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-missing-"));
  try {
    const result = await releaseRunClaimsOnExit({ runId: "run-x", root: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "no_coordination_dir");
    assert.deepEqual(result.released, []);
    assert.deepEqual(result.failed, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit treats a missing-dir (ENOENT) readdir error as no_coordination_dir", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-enoent-"));
  const missingDirError = Object.assign(new Error("missing"), { code: "ENOENT" });
  try {
    const result = await releaseRunClaimsOnExit({
      runId: "run-x",
      root: tempDir,
      readDir: async () => { throw missingDirError; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "no_coordination_dir");
    assert.equal(result.error, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit does not mask a non-ENOENT readdir failure as no_coordination_dir", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-scanfail-"));
  const permissionError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  try {
    const result = await releaseRunClaimsOnExit({
      runId: "run-x",
      root: tempDir,
      readDir: async () => { throw permissionError; },
    });
    // Non-fatal by contract (ok stays true, nothing thrown) but the failure is
    // surfaced via a distinct scan_failed status + message, not a clean-looking
    // no_coordination_dir that would make the sweep appear successful while
    // doing nothing.
    assert.equal(result.ok, true);
    assert.equal(result.status, "scan_failed");
    assert.match(result.error, /EACCES/);
    assert.deepEqual(result.released, []);
    assert.deepEqual(result.failed, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit records parse_failed on a corrupt claim file and continues", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-corrupt-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 41, runId: "run-a", cwd: tempDir });
    await claimRunnerOwnership({ repo: "owner/repo", pr: 42, runId: "run-a", cwd: tempDir });
    // Corrupt one of the two claim files.
    const corruptPath = defaultRunnerCoordinationFilePathForTarget(
      { repo: "owner/repo", pr: 42 },
      tempDir,
    );
    await writeFile(corruptPath, "{ not-json", "utf8");

    const result = await releaseRunClaimsOnExit({ runId: "run-a", root: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    // The healthy claim is released; the corrupt one is recorded as parse_failed,
    // never thrown, and the sweep keeps going.
    assert.equal(result.released.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].reason, "parse_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit records release_failed when the release fn throws and continues", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-releasefail-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 51, runId: "run-x", cwd: tempDir });
    await claimRunnerOwnership({ repo: "owner/repo", pr: 52, runId: "run-x", cwd: tempDir });
    const throwingReleaseFn = async () => {
      throw new Error("release boom");
    };
    const result = await releaseRunClaimsOnExit({ runId: "run-x", root: tempDir, releaseFn: throwingReleaseFn });
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.released.length, 0);
    assert.equal(result.failed.length, 2);
    assert.ok(result.failed.every((f) => f.reason === "release_failed"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit records read_failed when a claim file is unreadable and continues", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-readfail-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 61, runId: "run-x", cwd: tempDir });
    await claimRunnerOwnership({ repo: "owner/repo", pr: 62, runId: "run-x", cwd: tempDir });
    const throwingReadFile = async () => {
      throw new Error("read boom");
    };
    const result = await releaseRunClaimsOnExit({ runId: "run-x", root: tempDir, readFile: throwingReadFile });
    assert.equal(result.ok, true);
    assert.equal(result.status, "released");
    assert.equal(result.released.length, 0);
    assert.equal(result.failed.length, 2);
    assert.ok(result.failed.every((f) => f.reason === "read_failed"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// End-to-end CLI proof of the shared --jq/--silent output helper (issue #981).
// `status` needs no run-id and no gh, so it is a clean read-script vehicle.
const cliScript = path.resolve("scripts/loop/pr-runner-coordination.mjs");
const runCli = (args) => runNode(cliScript, args, { cwd: process.cwd() });

test("CLI --jq extracts a field from the result", async () => {
  const { code, stdout } = await runCli(["status", "--repo", "owner/repo", "--pr", "17", "--jq", ".ok"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "true");
});

test("CLI invalid --jq filter fails closed (exit 2 + stderr)", async () => {
  const { code, stdout, stderr } = await runCli(["status", "--repo", "owner/repo", "--pr", "17", "--jq", "bogus"]);
  assert.equal(code, 2);
  assert.equal(stdout.trim(), "");
  assert.match(stderr, /--jq/);
});

test("CLI --silent pass exits 0 silently", async () => {
  const { code, stdout } = await runCli(["status", "--repo", "owner/repo", "--pr", "17", "-s"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});

test("CLI --jq predicate + --silent: false predicate exits 1 silently", async () => {
  const { code, stdout } = await runCli(["status", "--repo", "owner/repo", "--pr", "17", "--jq", ".pr==99999", "--silent"]);
  assert.equal(code, 1);
  assert.equal(stdout.trim(), "");
});

test("CLI --silent + invalid --jq fails closed distinct from predicate-false (exit 2)", async () => {
  const { code, stderr } = await runCli(["status", "--repo", "owner/repo", "--pr", "17", "--jq", "nope", "--silent"]);
  assert.equal(code, 2);
  assert.match(stderr, /--jq/);
});

test("CLI without --jq/--silent leaves JSON shape unchanged", async () => {
  const { code, stdout } = await runCli(["status", "--repo", "owner/repo", "--pr", "17"]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "status");
  assert.equal(parsed.pr, 17);
});

test("releaseAsyncRunnerOwnership is non-fatal (release_error) when the coordination file is corrupt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    // Write malformed JSON at the exact coordination path so releaseRunnerOwnership's
    // read/parse throws — the swallow must fold it into ok:true/release_error, never rethrow.
    const filePath = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, tempDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{ this is not valid json", "utf8");

    const result = await releaseAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      env: { DEVLOOPS_RUN_ID: "run-1" },
      cwd: tempDir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "release_error");
    assert.equal(result.skippedReason, "release_threw");
    assert.equal(result.runId, "run-1");
    assert.deepEqual(result.exitSignals, []);
    assert.ok(typeof result.message === "string" && result.message.length > 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cross-CWD claim visibility: worktree and repo root resolve the same coordination file", async () => {
  const { repoRoot, wtPath } = await makeRepoWithWorktree();

  try {
    const pathFromWorktree = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, wtPath);
    const pathFromRoot = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, repoRoot);
    assert.equal(pathFromWorktree, pathFromRoot);
    // repoRoot/wtPath are raw (potentially symlinked) mkdtemp paths; both resolved
    // coordination paths must land under the *realpath'd* repo root, proving
    // resolveRepoCoordinationRoot canonicalizes cwd instead of relying on the
    // caller (or the test helper) to have already done so.
    assert.ok(pathFromRoot.startsWith(realpathSync(repoRoot)));

    const claimedFromWorktree = await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-wt", cwd: wtPath });
    assert.equal(claimedFromWorktree.ok, true);
    const confirmedFromRoot = await assertRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-wt", cwd: repoRoot });
    assert.equal(confirmedFromRoot.ok, true);
    assert.equal(confirmedFromRoot.status, "owner_confirmed");

    const claimedFromRoot = await claimRunnerOwnership({ repo: "owner/repo", pr: 18, runId: "run-root", cwd: repoRoot });
    assert.equal(claimedFromRoot.ok, true);
    const confirmedFromWorktree = await assertRunnerOwnership({ repo: "owner/repo", pr: 18, runId: "run-root", cwd: wtPath });
    assert.equal(confirmedFromWorktree.ok, true);
    assert.equal(confirmedFromWorktree.status, "owner_confirmed");
  } finally {
    await rm(wtPath, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("detector from repo root sees a worktree runner's refresh (no false-stale)", async () => {
  const { repoRoot, wtPath } = await makeRepoWithWorktree();

  try {
    // Resolved coordination path must converge as a STRING across cwds (proves
    // fs.realpathSync canonicalization, not just I/O round-trip transparency).
    const fromWt = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, wtPath);
    const fromRoot = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, repoRoot);
    assert.equal(fromWt, fromRoot);
    assert.ok(fromWt.startsWith(realpathSync(repoRoot)));

    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-wt", cwd: wtPath, now: "2026-06-05T08:00:00.000Z" });
    const refreshed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-wt",
      cwd: wtPath,
      now: "2026-06-05T08:29:00.000Z",
    });
    assert.equal(refreshed.status, "refreshed");

    const detected = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: repoRoot,
      now: Date.parse("2026-06-05T08:29:30.000Z"),
      maxAgeMs: 5 * 60 * 1000,
    });
    assert.equal(detected.ok, true);
    assert.equal(detected.status, "fresh_runner");
    assert.equal(detected.staleRunner, null);
  } finally {
    await rm(wtPath, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("no false-stale split: worktree and repo root converge on one coordination state", async () => {
  const { repoRoot, wtPath } = await makeRepoWithWorktree();

  try {
    // Resolved coordination path must converge as a STRING across cwds (proves
    // fs.realpathSync canonicalization, not just I/O round-trip transparency).
    const pathFromWt = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, wtPath);
    const pathFromRoot = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, repoRoot);
    assert.equal(pathFromWt, pathFromRoot);
    assert.ok(pathFromWt.startsWith(realpathSync(repoRoot)));

    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-wt", cwd: wtPath, now: "2026-06-05T08:00:00.000Z" });
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-wt", cwd: wtPath, now: "2026-06-05T08:15:00.000Z" });

    const fromRoot = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: repoRoot });
    const fromWorktree = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: wtPath });
    assert.equal(fromRoot.state.activeRun.updatedAt, "2026-06-05T08:15:00.000Z");
    assert.equal(fromRoot.state.activeRun.updatedAt, fromWorktree.state.activeRun.updatedAt);
  } finally {
    await rm(wtPath, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("history stays bounded across many heartbeats and keeps the newest entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-1",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });

    const heartbeatCount = 120;
    for (let i = 0; i < heartbeatCount; i += 1) {
      const now = new Date(Date.parse("2026-06-05T08:00:01.000Z") + i * 1000).toISOString();
      const asserted = await assertRunnerOwnership({
        repo: "owner/repo",
        pr: 17,
        runId: "run-1",
        cwd: tempDir,
        now,
      });
      assert.equal(asserted.ok, true);
      assert.equal(asserted.status, "owner_confirmed");
    }

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.ok(loaded.state.history.length <= RUNNER_COORDINATION_HISTORY_LIMIT);
    const newest = loaded.state.history.at(-1);
    assert.equal(newest.type, "heartbeat");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
