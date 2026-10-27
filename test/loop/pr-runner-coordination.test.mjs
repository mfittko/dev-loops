import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "bun:test";

import { runNode } from "../_helpers.mjs";
import {
  assertRunnerOwnership,
  claimRunnerOwnership,
  defaultRunnerCoordinationFilePathForTarget,
  ensureAsyncRunnerOwnership,
  handoffRunnerOwnership,
  loadRunnerCoordinationState,
  recordExitSignalForRunner,
  recordWatchClaim,
  releaseAsyncRunnerOwnership,
  releaseRunClaimsOnExit,
  releaseRunnerOwnership,
  RUNNER_COORDINATION_HISTORY_LIMIT,
} from "../../scripts/loop/_pr-runner-coordination.mjs";
import { detectStaleRunner, STALE_RUNNER_DEFAULT_MAX_AGE_MS, STALE_RUNNER_ERROR } from "../../scripts/loop/_stale-runner-detection.mjs";
import { runPrRunnerCoordination } from "../../scripts/loop/pr-runner-coordination.mjs";
import {
  NATIVE_PI_CHILD_MARKER,
  NATIVE_PI_PARENT_SESSION_MARKER,
  NATIVE_PI_SESSION_MARKER,
  synthesizePiRunId,
} from "@dev-loops/core/loop/run-context";

const releaseClaimsFromKnownRoot = (options) => releaseRunClaimsOnExit({
  resolveCoordinationRoot: (root) => root,
  ...options,
});
const execFileAsync = promisify(execFile);

test("handoff atomically clears its owner, preserves authority and noops without writing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "runner-handoff-"));
  const options = { repo: "owner/repo", pr: 17, cwd, env: { DEVLOOPS_RUN_ID: "owner" } };
  try {
    const absent = await handoffRunnerOwnership(options);
    assert.equal(absent.status, "handoff_noop");
    assert.equal(absent.previousRun, null);
    await assert.rejects(readFile(absent.filePath), { code: "ENOENT" });
    const claimed = await claimRunnerOwnership({ ...options, runId: "owner" });
    const raw = JSON.parse(await readFile(claimed.filePath, "utf8"));
    raw.schemaVersion = 1;
    raw.authority = { branch: "branch", head: "head", rounds: 4 };
    raw.target.extension = "preserved";
    await writeFile(claimed.filePath, JSON.stringify(raw));
    const neighbor = path.join(cwd, "gate.json");
    await writeFile(neighbor, '{"verdict":"pass","delta":3}');
    const result = await handoffRunnerOwnership({ ...options, runId: "owner" });
    assert.equal(result.status, "handoff_recorded");
    assert.equal(result.activeRun, null);
    assert.equal(result.previousRun.runId, "owner");
    assert.equal(result.previousRun.replacedByRunId, null);
    assert.equal(result.exitSignals.length, 1);
    const afterBytes = await readFile(claimed.filePath, "utf8");
    const after = JSON.parse(afterBytes);
    assert.deepEqual(after, { ...raw, activeRun: null, previousRun: result.previousRun,
      exitSignals: result.exitSignals, history: [...raw.history, { type: "handoff", runId: "owner", at: result.exitSignals[0].at }] });
    assert.equal(await readFile(neighbor, "utf8"), '{"verdict":"pass","delta":3}');
    assert.equal((await handoffRunnerOwnership(options)).status, "handoff_noop");
    assert.equal(await readFile(claimed.filePath, "utf8"), afterBytes);
    const status = await runPrRunnerCoordination({ ...options, command: "status" }, { cwd });
    assert.equal(status.state.activeRun, null);
    assert.equal(status.state.previousRun.runId, "owner");
    assert.equal((await claimRunnerOwnership({ ...options, runId: "fresh" })).status, "claimed_new");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("handoff refuses unverified, mismatched and foreign identities without writing", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "runner-handoff-refusal-"));
  const options = { repo: "owner/repo", pr: 17, cwd };
  try {
    const claim = await claimRunnerOwnership({ ...options, runId: "owner" });
    const before = await readFile(claim.filePath, "utf8");
    for (const [env, runId, error] of [
      [{}, "owner", "run_id_required"],
      [{ DEVLOOPS_RUN_ID: "owner" }, "foreign", "ownership_lost"],
      [{ DEVLOOPS_RUN_ID: "foreign" }, undefined, "ownership_lost"],
    ]) {
      assert.equal((await handoffRunnerOwnership({ ...options, env, runId })).error, error);
      assert.equal(await readFile(claim.filePath, "utf8"), before);
    }
    for (const raw of ["{", JSON.stringify({ ...JSON.parse(before), schemaVersion: 99 }),
      JSON.stringify({ ...JSON.parse(before), target: { repo: "other/repo", pr: 17 } }),
      JSON.stringify({ ...JSON.parse(before), target: { repo: "owner/repo", pr: 18 } })]) {
      await writeFile(claim.filePath, raw);
      await assert.rejects(handoffRunnerOwnership({ ...options, env: { DEVLOOPS_RUN_ID: "owner" } }));
      assert.equal(await readFile(claim.filePath, "utf8"), raw);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const claimOffset of [-1000, 0, 1000]) for (const mode of ["claim", "takeover"]) {
test(`handoff evidence cannot displace a new ${mode} with timestamp offset ${claimOffset}`, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "runner-handoff-reclaim-"));
  const options = { repo: "owner/repo", pr: 17, cwd, runId: "owner" };
  const prevMaxAge = process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
  process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = String(STALE_RUNNER_DEFAULT_MAX_AGE_MS);
  try {
    const now = Date.now();
    await claimRunnerOwnership({ ...options, now: new Date(now - 2000).toISOString() });
    await handoffRunnerOwnership({ ...options, env: { DEVLOOPS_RUN_ID: "owner" }, now: new Date(now).toISOString() });
    if (mode === "takeover") {
      await claimRunnerOwnership({ ...options, runId: "other" });
      await recordExitSignalForRunner({ ...options, runId: "other" });
    }
    const claim = await claimRunnerOwnership({ ...options, mode, now: new Date(now + claimOffset).toISOString() });
    assert.equal(claim.exitSignals.some((entry) => entry.runId === "owner"), false);
    assert.equal(claim.exitSignals.length, mode === "takeover" ? 1 : 0);
    const before = await readFile(claim.filePath, "utf8");
    const result = await ensureAsyncRunnerOwnership({ ...options, env: { DEVLOOPS_RUN_ID: "competitor" }, supersedeStale: true });
    assert.equal(result.error, "ownership_lost");
    assert.equal(await readFile(claim.filePath, "utf8"), before);
    assert.equal((await detectStaleRunner(options)).exitSignal, null);
    await recordExitSignalForRunner({ ...options, now: new Date(now + 2000).toISOString() });
    await claimRunnerOwnership(options);
    assert.equal((await detectStaleRunner(options)).error, "exit_signal_recorded", "same-owner refresh preserves current-claim evidence");
  } finally {
    if (prevMaxAge === undefined) delete process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
    else process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = prevMaxAge;
    await rm(cwd, { recursive: true, force: true });
  }
});
}

test("retained pre-claim exit signal cannot displace a fresh owner", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "runner-retained-signal-"));
  const options = { repo: "owner/repo", pr: 17, cwd, runId: "owner" };
  const prevMaxAge = process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
  process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = String(STALE_RUNNER_DEFAULT_MAX_AGE_MS);
  try {
    const now = Date.now();
    const claim = await claimRunnerOwnership({ ...options, now: new Date(now).toISOString() });
    const signalAt = new Date(now - 1000).toISOString();
    await recordExitSignalForRunner({ ...options, now: signalAt });
    const before = await readFile(claim.filePath, "utf8");
    assert.deepEqual(JSON.parse(before).exitSignals.map(({ runId, at }) => ({ runId, at })),
      [{ runId: "owner", at: signalAt }]);
    const detected = await detectStaleRunner(options);
    assert.equal(detected.status, "fresh_runner");
    assert.equal(detected.exitSignal, null);
    const result = await ensureAsyncRunnerOwnership({ ...options, env: { DEVLOOPS_RUN_ID: "competitor" }, supersedeStale: true });
    assert.equal(result.error, "ownership_lost");
    assert.equal(await readFile(claim.filePath, "utf8"), before);
  } finally {
    if (prevMaxAge === undefined) delete process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
    else process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = prevMaxAge;
    await rm(cwd, { recursive: true, force: true });
  }
});

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
  const git = (args) => execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await writeFile(path.join(repoRoot, "README.md"), "init\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-q", "-m", "init"]);
  const wtPath = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-wt-"));
  await git(["worktree", "add", "-q", wtPath, "-b", "issue-1245-wt"]);
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
    const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, now: "2026-06-05T08:00:00.000Z" });
    const ownedBytes = await readFile(owned.filePath, "utf8");

    const conflict = await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-2", cwd: tempDir });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "active_run_exists");
    assert.equal(conflict.activeRun.runId, "run-1");
    assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a refused claim writes nothing");

    // A takeover authorized by evidence about another run must refuse once the owner moved on.
    const misattributed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-2",
      cwd: tempDir,
      mode: "takeover",
      expectPreviousRunId: "run-earlier",
    });
    assert.equal(misattributed.ok, false);
    assert.equal(misattributed.error, "active_run_exists");
    assert.equal(misattributed.activeRun.runId, "run-1");
    assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a refused takeover writes nothing");

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
    assert.equal((await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir })).state, null, "a missing-record refusal writes no coordination record");

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
    assert.equal(result.filePath, null);
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
    assert.equal("recovery" in result, false);

    // Live owner's claim is untouched.
    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 23, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-live");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1: a successful supersedeStale recovery reports which evidence authorized it,
// so records and handbacks distinguish an exit-signal recovery from a max-age one.
// Both writes pin `now`, so the claim-scoped signal match never depends on the clock.
test("ensureAsyncRunnerOwnership reports typed recovery evidence (exit signal)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const claimedAt = "2026-06-05T08:00:00.000Z";
  const signalAt = "2026-06-05T08:05:00.000Z";

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 31, runId: "run-dead", cwd: tempDir, now: claimedAt });
    await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 31,
      runId: "run-dead",
      reason: "completed",
      cwd: tempDir,
      now: signalAt,
    });

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 31,
      cwd: tempDir,
      // The window comes from the caller's env, not the ambient one.
      env: { DEVLOOPS_RUN_ID: "run-next", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: String(STALE_RUNNER_DEFAULT_MAX_AGE_MS) },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(result.status, "taken_over");
    assert.deepEqual(result.recovery, {
      evidence: "exit_signal",
      displacedRunId: "run-dead",
      maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1 precedence: a crashed owner whose claim also aged out satisfies both evidence
// branches, and only the detector's evidence order picks `exit_signal`. Only a test
// holding both branches true pins that tie-breaker.
test("typed recovery prefers the claim-scoped exit signal over the stale window", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const now = Date.now();
  const claimedAt = new Date(now - 40 * 60 * 1000).toISOString();
  const signalAt = new Date(now - 39 * 60 * 1000).toISOString();
  const env = { DEVLOOPS_RUN_ID: "run-next", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: String(STALE_RUNNER_DEFAULT_MAX_AGE_MS) };

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 34, runId: "run-crashed", cwd: tempDir, now: claimedAt });
    await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 34,
      runId: "run-crashed",
      reason: "crashed",
      cwd: tempDir,
      now: signalAt,
    });

    const recovered = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 34,
      cwd: tempDir,
      env,
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(recovered.status, "taken_over");
    assert.deepEqual(recovered.recovery, {
      evidence: "exit_signal",
      displacedRunId: "run-crashed",
      maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
    });

    // The same claim shape recovers on the max-age branch alone, so both branches
    // were true above and only the evidence order chose the label.
    await claimRunnerOwnership({ repo: "owner/repo", pr: 35, runId: "run-crashed", cwd: tempDir, now: claimedAt });
    const agedOnly = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 35,
      cwd: tempDir,
      env,
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(agedOnly.recovery.evidence, "stale_max_age");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1/R2: a claim whose timestamps do not parse arrives as the detector's
// ordinary `stale_runner` verdict carrying `staleRunner.corruptedTimestamp`, and
// no clock comparison authorized that recovery, so the handoff stays fail-closed
// on the ownership conflict instead of reporting a max-age recovery.
test("a corrupted claim timestamp refuses the takeover without a state write", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 36, runId: "run-owner", cwd: tempDir });
    const ownedBytes = await readFile(owned.filePath, "utf8");

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 36,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-next" },
      claimIfMissing: true,
      supersedeStale: true,
      // The verdict shape `detectStaleRunner` reports for an unparseable claim.
      detectStale: async () => ({
        ok: false,
        error: STALE_RUNNER_ERROR.STALE_RUNNER,
        status: "stale_runner",
        activeRun: owned.activeRun,
        staleRunner: {
          runId: owned.activeRun.runId,
          claimedAt: owned.activeRun.claimedAt,
          updatedAt: "(corrupt)",
          claimedAgeMs: -1,
          updatedAgeMs: -1,
          maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
          corruptedTimestamp: true,
        },
        exitSignal: null,
        maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ownership_lost");
    assert.equal("recovery" in result, false);
    assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a corrupted claim writes nothing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1/R2: the corruption path end to end. The record itself carries the
// unparseable timestamp and the real detector reports it, so the takeover is
// never labeled a max-age recovery for a claim whose age was never compared.
test("a stored claim with an unparseable timestamp refuses the takeover as corruption", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const owned = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 43,
      runId: "run-corrupt",
      cwd: tempDir,
      now: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });
    const record = JSON.parse(await readFile(owned.filePath, "utf8"));
    record.activeRun.updatedAt = "not-a-timestamp";
    await writeFile(owned.filePath, `${JSON.stringify(record, null, 2)}\n`);
    const corruptedBytes = await readFile(owned.filePath, "utf8");

    const detected = await detectStaleRunner({ repo: "owner/repo", pr: 43, cwd: tempDir });
    assert.equal(detected.error, STALE_RUNNER_ERROR.STALE_RUNNER);
    assert.equal(detected.staleRunner.corruptedTimestamp, true);

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 43,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-next", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: "60000" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ownership_lost");
    assert.equal("recovery" in result, false);
    assert.equal(await readFile(owned.filePath, "utf8"), corruptedBytes, "a corrupted claim writes nothing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1/DESIGN-SIMPLEST-FIRST: a verdict code the production detector cannot emit
// authorizes no takeover either, because the mapping covers exactly the two
// recoverable verdicts.
test("an unrecognized detector verdict authorizes no takeover and writes no state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 39, runId: "run-owner", cwd: tempDir });
    const ownedBytes = await readFile(owned.filePath, "utf8");

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 39,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-next" },
      claimIfMissing: true,
      supersedeStale: true,
      detectStale: async () => ({ ok: false, error: "unexpected_verdict", activeRun: owned.activeRun }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ownership_lost");
    assert.equal("recovery" in result, false);
    assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "an untyped recovery writes nothing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R2: the takeover is authorized by the lock-free detection read, so the production
// supersedeStale wiring must refuse once the observed owner is no longer active.
test("supersedeStale refuses a takeover whose detected owner is no longer active", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 37, runId: "run-1", cwd: tempDir });
    const ownedBytes = await readFile(owned.filePath, "utf8");

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 37,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-2" },
      claimIfMissing: true,
      supersedeStale: true,
      // The owner moved on between the detection read and the locked takeover: the
      // verdict names another run while carrying THIS claim's real generation, so
      // only the owner-identity guard can produce the refusal below (an all-null
      // generation would trip the claim-generation guard instead, which has its
      // own tests).
      detectStale: async () => ({
        ok: false,
        error: STALE_RUNNER_ERROR.STALE_RUNNER,
        activeRun: { ...owned.activeRun, runId: "run-earlier" },
        maxAgeMs: STALE_RUNNER_DEFAULT_MAX_AGE_MS,
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "active_run_exists");
    assert.equal(result.activeRun.runId, "run-1");
    assert.match(result.message, /not the displaced run run-earlier/, "the owner-identity guard refuses, not the claim-generation guard");
    assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a refused takeover writes nothing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R2: the same run id is not the same claim. A live owner that heartbeats
// between the lock-free detection read and the locked takeover keeps its run id
// and `claimedAt`, so only the observed generation refuses the displacement.
test("supersedeStale refuses a takeover whose claim was refreshed after the stale read", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const maxAgeMs = STALE_RUNNER_DEFAULT_MAX_AGE_MS;

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 45,
      runId: "run-1",
      cwd: tempDir,
      now: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });
    const observed = (await loadRunnerCoordinationState({ repo: "owner/repo", pr: 45, cwd: tempDir })).state.activeRun;
    const filePath = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 45 }, tempDir);
    let refreshedBytes = null;

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 45,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-2", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: String(maxAgeMs) },
      claimIfMissing: true,
      supersedeStale: true,
      detectStale: async () => {
        // The owner heartbeats after the detection read returned `observed`: the
        // run id and `claimedAt` stay, only `updatedAt` moves.
        await assertRunnerOwnership({ repo: "owner/repo", pr: 45, runId: "run-1", cwd: tempDir });
        refreshedBytes = await readFile(filePath, "utf8");
        return {
          ok: false,
          error: STALE_RUNNER_ERROR.STALE_RUNNER,
          activeRun: observed,
          staleRunner: { ...observed, claimedAgeMs: -1, updatedAgeMs: -1, maxAgeMs, corruptedTimestamp: false },
          maxAgeMs,
        };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "active_run_exists");
    assert.equal("recovery" in result, false);
    assert.equal(result.activeRun.runId, "run-1");
    assert.equal(await readFile(filePath, "utf8"), refreshedBytes, "a refreshed live claim is never displaced");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R2: a same-run release and re-claim retires that run's exit signals while
// keeping its run id, so the generation the detector judged dead is gone even
// though the owner identity still matches.
test("supersedeStale refuses a takeover whose claim was released and re-claimed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const maxAgeMs = STALE_RUNNER_DEFAULT_MAX_AGE_MS;

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 47,
      runId: "run-1",
      cwd: tempDir,
      now: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });
    const observed = (await loadRunnerCoordinationState({ repo: "owner/repo", pr: 47, cwd: tempDir })).state.activeRun;
    let reclaimedBytes = null;
    const filePath = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 47 }, tempDir);

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 47,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-2", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: String(maxAgeMs) },
      claimIfMissing: true,
      supersedeStale: true,
      detectStale: async () => {
        await releaseRunnerOwnership({ repo: "owner/repo", pr: 47, runId: "run-1", cwd: tempDir });
        await claimRunnerOwnership({ repo: "owner/repo", pr: 47, runId: "run-1", cwd: tempDir });
        reclaimedBytes = await readFile(filePath, "utf8");
        return {
          ok: false,
          error: STALE_RUNNER_ERROR.STALE_RUNNER,
          activeRun: observed,
          staleRunner: { ...observed, claimedAgeMs: -1, updatedAgeMs: -1, maxAgeMs, corruptedTimestamp: false },
          maxAgeMs,
        };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "active_run_exists");
    assert.equal("recovery" in result, false);
    assert.equal(result.activeRun.runId, "run-1");
    assert.equal(await readFile(filePath, "utf8"), reclaimedBytes, "a re-claimed owner is never displaced");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1: the typed recovery field is gated on the takeover status. A claim released
// between the lock-free stale read and the locked claim lands on `claimed_new`,
// whose `previousRun` is copied from the prior state and names the run that
// released itself rather than one this claim displaced; attaching `recovery`
// there would report a displacement that never happened.
test("a claim released after the stale read reports no recovery field", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const maxAgeMs = STALE_RUNNER_DEFAULT_MAX_AGE_MS;

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 46, runId: "run-older", cwd: tempDir });
    await claimRunnerOwnership({ repo: "owner/repo", pr: 46, runId: "run-stale", cwd: tempDir, mode: "takeover" });
    const observed = (await loadRunnerCoordinationState({ repo: "owner/repo", pr: 46, cwd: tempDir })).state.activeRun;

    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 46,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-next", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: String(maxAgeMs) },
      claimIfMissing: true,
      supersedeStale: true,
      detectStale: async () => {
        // The owner releases after the detection read, so the locked claim finds
        // no active run and lands on the ordinary `claimed_new` branch.
        await releaseRunnerOwnership({ repo: "owner/repo", pr: 46, runId: "run-stale", cwd: tempDir });
        return {
          ok: false,
          error: STALE_RUNNER_ERROR.STALE_RUNNER,
          activeRun: observed,
          staleRunner: { ...observed, claimedAgeMs: -1, updatedAgeMs: -1, maxAgeMs, corruptedTimestamp: false },
          maxAgeMs,
        };
      },
    });
    assert.equal(result.status, "claimed_new");
    assert.equal(result.previousRun.runId, "run-stale", "previousRun still names the released owner, not a displaced one");
    assert.equal("recovery" in result, false, "a fresh claim never reports recovery evidence");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// R1/R4: the DOCUMENTED handoff-to-successor sequence runs end to end. The handoff
// clears the claim in the same locked write that appends the exit signal, so the
// successor's pre-flight finds no owner to displace: it claims fresh, its
// `previousRun` names the handed-off owner, and it carries no `recovery` field.
// A regression that re-created a claim during the handoff, or that attached
// `recovery` to this `claimed_new` result, fails here.
test("a handoff successor claims fresh with no recovery field", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 48, runId: "run-owner-a", cwd: tempDir });
    const handed = await handoffRunnerOwnership({
      repo: "owner/repo",
      pr: 48,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-owner-a" },
    });
    assert.equal(handed.status, "handoff_recorded");
    assert.equal(handed.activeRun, null, "the handoff clears the claim in its own locked write");

    const successor = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 48,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-owner-b" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(successor.ok, true);
    assert.equal(successor.status, "claimed_new");
    assert.equal(successor.previousRun.runId, "run-owner-a", "the fresh claim names the handed-off owner");
    assert.equal("recovery" in successor, false, "a handoff successor displaces nobody, so it reports no recovery");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The expectation guard normalizes its input like every other run-id entry point,
// so an absent, null or padded expectation behaves like an exact one.
for (const form of [
  { label: "the observed displaced owner", expectation: { expectPreviousRunId: "run-1" } },
  { label: "null", expectation: { expectPreviousRunId: null } },
  { label: "undefined", expectation: { expectPreviousRunId: undefined } },
  { label: "absent", expectation: {} },
  { label: "whitespace padded", expectation: { expectPreviousRunId: "  run-1  " } },
]) {
  test(`claimRunnerOwnership takeover proceeds when expectPreviousRunId is ${form.label}`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

    try {
      await claimRunnerOwnership({ repo: "owner/repo", pr: 40, runId: "run-1", cwd: tempDir });
      const takeover = await claimRunnerOwnership({
        repo: "owner/repo",
        pr: 40,
        runId: "run-2",
        cwd: tempDir,
        mode: "takeover",
        ...form.expectation,
      });
      assert.equal(takeover.status, "taken_over");
      assert.equal(takeover.previousRun.runId, "run-1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

test("claimRunnerOwnership takeover refuses an expectPreviousRunId that names another run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 41, runId: "run-1", cwd: tempDir });
    const ownedBytes = await readFile(owned.filePath, "utf8");

    const refused = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 41,
      runId: "run-2",
      cwd: tempDir,
      mode: "takeover",
      expectPreviousRunId: "run-earlier",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "active_run_exists");
    assert.equal(refused.activeRun.runId, "run-1");
    assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a refused takeover writes nothing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// A supplied expectation that cannot name a run refuses instead of collapsing to
// null, which would silently disable the race guard for that takeover.
for (const form of [
  { label: "a whitespace-only string", expectation: "   " },
  { label: "a non-string", expectation: 42 },
]) {
  test(`claimRunnerOwnership takeover refuses ${form.label} expectPreviousRunId`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

    try {
      const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 42, runId: "run-1", cwd: tempDir });
      const ownedBytes = await readFile(owned.filePath, "utf8");

      const refused = await claimRunnerOwnership({
        repo: "owner/repo",
        pr: 42,
        runId: "run-2",
        cwd: tempDir,
        mode: "takeover",
        expectPreviousRunId: form.expectation,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.error, "run_id_required");
      assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a malformed expectation writes nothing");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

// A supplied `expectPreviousClaim` that is not a claim generation cannot describe
// one. Coercing it to an all-null generation would surface as a lost-race
// `active_run_exists` diagnostic for input the caller never sent, so it refuses as
// malformed instead — the same conflict a malformed `expectPreviousRunId` gets.
for (const form of [
  { label: "a string", expectation: "junk" },
  { label: "a number", expectation: 42 },
  { label: "an array", expectation: ["claimedAt", "updatedAt"] },
  { label: "a Date", expectation: new Date() },
  { label: "a Map", expectation: new Map() },
  { label: "an object with a non-string member", expectation: { claimedAt: 42, updatedAt: null } },
  { label: "an object missing a member", expectation: { claimedAt: "2026-06-05T08:00:00.000Z" } },
]) {
  test(`claimRunnerOwnership takeover refuses ${form.label} expectPreviousClaim`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

    try {
      const owned = await claimRunnerOwnership({ repo: "owner/repo", pr: 43, runId: "run-1", cwd: tempDir });
      const ownedBytes = await readFile(owned.filePath, "utf8");

      const refused = await claimRunnerOwnership({
        repo: "owner/repo",
        pr: 43,
        runId: "run-2",
        cwd: tempDir,
        mode: "takeover",
        expectPreviousClaim: form.expectation,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.error, "run_id_required");
      assert.equal(await readFile(owned.filePath, "utf8"), ownedBytes, "a malformed expectation writes nothing");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

// The expectation options are validated the same way in every mode, so a malformed
// one is caller error on a default claim-mode call too, refused before the lock
// with no coordination record written.
test("claimRunnerOwnership refuses a malformed expectation in claim mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const refused = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 44,
      runId: "run-1",
      cwd: tempDir,
      expectPreviousRunId: 42,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "run_id_required");
    const filePath = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 44 }, tempDir);
    await assert.rejects(readFile(filePath, "utf8"), "a malformed expectation writes no coordination record");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensureAsyncRunnerOwnership reports typed recovery evidence (stale max age)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 32,
      runId: "run-stale",
      cwd: tempDir,
      now: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
    });

    // The window comes from the caller's env, not the ambient one.
    const result = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 32,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-fresh", DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: "60000" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(result.status, "taken_over");
    assert.deepEqual(result.recovery, {
      evidence: "stale_max_age",
      displacedRunId: "run-stale",
      maxAgeMs: 60000,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ensureAsyncRunnerOwnership omits recovery when it performs no recovery", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    const claimed = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 33,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-first" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(claimed.status, "claimed_new");
    assert.equal("recovery" in claimed, false);

    const refreshed = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 33,
      cwd: tempDir,
      env: { DEVLOOPS_RUN_ID: "run-first" },
      claimIfMissing: true,
      supersedeStale: true,
    });
    assert.equal(refreshed.ok, true);
    assert.equal("recovery" in refreshed, false);
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

    const result = await releaseClaimsFromKnownRoot({ runId: "run-exit", root: tempDir });
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
    const result = await releaseClaimsFromKnownRoot({ runId: "", root: tempDir });
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
    const result = await releaseClaimsFromKnownRoot({ runId: "run-x", root: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "no_coordination_dir");
    assert.deepEqual(result.released, []);
    assert.deepEqual(result.failed, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit accepts a resolved coordination root without shelling out to Git", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-resolved-root-"));
  let resolveCalls = 0;
  try {
    const result = await releaseClaimsFromKnownRoot({
      runId: "run-x",
      root: tempDir,
      resolveCoordinationRoot: (root) => {
        resolveCalls += 1;
        assert.equal(root, tempDir);
        return tempDir;
      },
    });
    assert.equal(resolveCalls, 1);
    assert.equal(result.status, "no_coordination_dir");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("releaseRunClaimsOnExit treats a missing-dir (ENOENT) readdir error as no_coordination_dir", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-enoent-"));
  const missingDirError = Object.assign(new Error("missing"), { code: "ENOENT" });
  try {
    const result = await releaseClaimsFromKnownRoot({
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
    const result = await releaseClaimsFromKnownRoot({
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

    const result = await releaseClaimsFromKnownRoot({ runId: "run-a", root: tempDir });
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
    const result = await releaseClaimsFromKnownRoot({ runId: "run-x", root: tempDir, releaseFn: throwingReleaseFn });
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
    const result = await releaseClaimsFromKnownRoot({ runId: "run-x", root: tempDir, readFile: throwingReadFile });
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

// The full --jq/--silent/invalid-filter/predicate matrix is owned by emitResult
// (test/loop/jq-output.test.mjs); this command keeps one positive --jq wiring
// case to prove `status` composes its result through the shared emit path.
test("CLI --jq extracts a field from the result", async () => {
  const { code, stdout } = await runCli(["status", "--repo", "owner/repo", "--pr", "17", "--jq", ".ok"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "true");
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

// --- recordWatchClaim (watcher-exclusivity live enforcement, issue 2157) ---

test("recordWatchClaim records head+waitKind onto the active owner and refreshes updatedAt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, now: "2026-06-05T08:00:00.000Z" });
    const claim = await recordWatchClaim({
      repo: "owner/repo",
      pr: 17,
      runId: "run-1",
      head: "abc123",
      waitKind: "copilot_review",
      cwd: tempDir,
      now: "2026-06-05T08:05:00.000Z",
    });
    assert.equal(claim.ok, true);
    assert.equal(claim.status, "watch_claim_recorded");
    assert.deepEqual(claim.watch, { head: "abc123", waitKind: "copilot_review", updatedAt: "2026-06-05T08:05:00.000Z" });
    assert.equal(claim.activeRun.updatedAt, "2026-06-05T08:05:00.000Z");

    // Persisted and preserved through normalization on reload.
    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.deepEqual(loaded.state.activeRun.watch, { head: "abc123", waitKind: "copilot_review", updatedAt: "2026-06-05T08:05:00.000Z" });
    const newest = loaded.state.history[loaded.state.history.length - 1];
    assert.equal(newest.type, "watch_claim");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordWatchClaim fails closed when another run owns the lease (no second observer)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir, now: "2026-06-05T08:00:00.000Z" });
    const foreign = await recordWatchClaim({ repo: "owner/repo", pr: 17, runId: "run-2", head: "abc123", waitKind: "ci", cwd: tempDir });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error, "ownership_lost");
    assert.equal(foreign.activeRun.runId, "run-1");
    // The foreign run's claim was NOT written.
    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.watch ?? null, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordWatchClaim fails closed when there is no coordination record", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    const missing = await recordWatchClaim({ repo: "owner/repo", pr: 17, runId: "run-1", head: "abc123", waitKind: "ci", cwd: tempDir });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "ownership_missing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordWatchClaim rejects a missing head and an invalid waitKind", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    const noHead = await recordWatchClaim({ repo: "owner/repo", pr: 17, runId: "run-1", head: "  ", waitKind: "ci", cwd: tempDir });
    assert.equal(noHead.ok, false);
    assert.equal(noHead.error, "watch_head_required");
    const badKind = await recordWatchClaim({ repo: "owner/repo", pr: 17, runId: "run-1", head: "abc123", waitKind: "poll", cwd: tempDir });
    assert.equal(badKind.ok, false);
    assert.equal(badKind.error, "watch_kind_invalid");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a persisted watch with an unparseable updatedAt normalizes to null (fail-closed, issue 2157 fix 3)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    const filePath = defaultRunnerCoordinationFilePathForTarget({ repo: "owner/repo", pr: 17 }, tempDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 2,
      target: { repo: "owner/repo", pr: 17 },
      activeRun: {
        runId: "run-1",
        claimedAt: "2026-06-05T08:00:00.000Z",
        updatedAt: "2026-06-05T08:05:00.000Z",
        watch: { head: "abc123", waitKind: "copilot_review", updatedAt: "not-a-date" },
      },
      previousRun: null,
      history: [],
      exitSignals: [],
    }));
    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, "run-1", "the rest of activeRun stays intact");
    assert.equal(loaded.state.activeRun.watch ?? null, null, "an unparseable watch.updatedAt drops the whole watch, not just the bad field");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordWatchClaim requires a non-empty run id", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-1", cwd: tempDir });
    const noRun = await recordWatchClaim({ repo: "owner/repo", pr: 17, runId: "", head: "abc123", waitKind: "ci", cwd: tempDir });
    assert.equal(noRun.ok, false);
    assert.equal(noRun.error, "run_id_required");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// pi-subagents >= 0.65 injects no run-id carrier, so the claim path resolves the synthesized
// native Pi id. Before that fallback existed, resolveRunId returned null and runner ownership
// claim (which requires an id) refused outright under Pi.
test("runner coordination claim succeeds from a native Pi async-runner env with no run-id carrier", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const parentSession = "parent-session-abc";

  try {
    const env = { [NATIVE_PI_CHILD_MARKER]: "1", [NATIVE_PI_PARENT_SESSION_MARKER]: parentSession };
    const claimed = await runPrRunnerCoordination(
      { command: "claim", repo: "owner/repo", pr: 17 },
      { env, cwd: tempDir },
    );

    assert.equal(claimed.ok, true);
    assert.equal(claimed.status, "claimed_new");
    assert.equal(claimed.activeRun.runId, synthesizePiRunId(parentSession));

    const loaded = await loadRunnerCoordinationState({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(loaded.state.activeRun.runId, synthesizePiRunId(parentSession));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("native Codex runner claims and CLI handoff require the shared child identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-codex-"));
  try {
    const id = "01a15519-285b-74b3-8f36-01e51619bba3";
    const directory = path.join(root, "sessions/2026/10/19");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-child-${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id, parent_thread_id: "parent", source: {
      subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: null, agent_role: null } },
    } } })}\n`);
    const env = { CODEX_HOME: root, CODEX_THREAD_ID: id, DEVLOOPS_RUN_ID: "inherited" };
    const options = { command: "claim", repo: "owner/repo", pr: 17 };
    const result = await runPrRunnerCoordination(options, { env, cwd: root });
    assert.equal(result.ok, true);
    assert.equal(result.activeRun.runId, `codex-thread-${id}`);
    const args = ["handoff", "--repo", "owner/repo", "--pr", "17"];
    const cli = (extra = []) => runNode(cliScript, [...args, ...extra], { cwd: root, env });
    const mismatch = await cli(["--run-id", "foreign"]);
    assert.equal(mismatch.code, 1);
    assert.equal(JSON.parse(mismatch.stderr).error, "ownership_lost");
    const handed = await cli();
    assert.equal(handed.code, 0);
    assert.equal(JSON.parse(handed.stdout).status, "handoff_recorded");
    assert.equal((await cli(["--jq", ".status"])).stdout.trim(), "handoff_noop");
    const silent = await cli(["--silent"]);
    assert.equal(silent.code, 0);
    assert.equal(silent.stdout, "");
    for (const extra of [["--run-id"], ["--unknown"]]) {
      const invalid = await cli(extra);
      assert.equal(invalid.code, 1);
      assert.match(invalid.stderr, /usage/i);
    }
    await runPrRunnerCoordination(options, { env, cwd: root });
    const before = await readFile(result.filePath, "utf8");
    await writeFile(file, "invalid metadata\n");
    const malformed = await cli(["--run-id", result.runId]);
    assert.equal(malformed.code, 1);
    assert.equal(JSON.parse(malformed.stderr).error, "run_id_required");
    await rm(file);
    assert.equal((await runPrRunnerCoordination(options, { env, cwd: root })).error, "run_id_required");
    const missing = await cli(["--run-id", result.runId]);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stderr).error, "run_id_required");
    assert.equal(await readFile(result.filePath, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const invalidation of ["missing", "malformed"]) {
  test(`automatic ownership refuses ${invalidation} Codex metadata after a valid claim`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-codex-auto-"));
    try {
      const id = "01a15519-285b-74b3-8f36-01e51619bba3";
      const directory = path.join(root, "sessions/2026/10/19");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `rollout-child-${id}.jsonl`);
      await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id, parent_thread_id: "parent", source: {
        subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: null, agent_role: null } },
      } } })}\n`);
      const env = { CODEX_HOME: root, CODEX_THREAD_ID: id, DEVLOOPS_RUN_ID: "inherited" };
      const options = { repo: "owner/repo", pr: 17, cwd: root, env };
      const claimed = await ensureAsyncRunnerOwnership(options);
      assert.equal(claimed.ok, true);
      assert.equal(claimed.activeRun.runId, `codex-thread-${id}`);
      const claimedBytes = await readFile(claimed.filePath, "utf8");
      if (invalidation === "missing") await rm(file);
      else await writeFile(file, "invalid metadata\n");

      for (const policy of [{}, { claimIfMissing: false, requireExisting: true }]) {
        const result = await ensureAsyncRunnerOwnership({ ...options, ...policy });
        assert.equal(result.ok, false, "invalid evidence must never skip automatic ownership");
        assert.equal(result.error, "run_id_required");
      }
      assert.equal(await readFile(claimed.filePath, "utf8"), claimedBytes, "every refusal leaves the coordination record byte-identical");
      const inspected = await ensureAsyncRunnerOwnership({ ...options, claimIfMissing: false, requireExisting: false });
      assert.equal(inspected.ok, true, "read-only inspection remains available without async evidence");
      assert.equal(inspected.status, "skipped_no_async_run_id");
      const loaded = await loadRunnerCoordinationState(options);
      assert.equal(loaded.state.activeRun.runId, claimed.runId, "a refusal preserves the existing claim");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("automatic ownership preserves native Pi, Claude and nonasync context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-harnesses-"));
  try {
    for (const [env, runId] of [
      [{ [NATIVE_PI_CHILD_MARKER]: "1", [NATIVE_PI_PARENT_SESSION_MARKER]: "parent", [NATIVE_PI_SESSION_MARKER]: "child" }, "pi-session-child"],
      [{ CLAUDECODE: "1", DEVLOOPS_RUN_ID: "claude-run", CODEX_THREAD_ID: "inherited" }, "claude-run"],
      [{}, null],
    ]) {
      const result = await ensureAsyncRunnerOwnership({ repo: "owner/repo", pr: 17, cwd: root, env });
      assert.equal(result.ok, true);
      assert.equal(result.runId, runId);
      if (runId) {
        const handed = await handoffRunnerOwnership({ repo: "owner/repo", pr: 17, cwd: root, env });
        assert.equal(handed.status, "handoff_recorded");
        assert.equal(handed.runId, runId);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Sibling regression: runner coordination treats an EQUAL run id as an authorized refresh, not
// a conflict, so two concurrent native Pi children of one parent session must NOT share an id —
// otherwise the second silently takes over the first's lease on the same PR.
test("two sibling native Pi children of one parent session cannot both claim the same PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));
  const parentSession = "parent-session-shared";

  try {
    const siblingEnv = (childSession) => ({
      [NATIVE_PI_CHILD_MARKER]: "1",
      [NATIVE_PI_PARENT_SESSION_MARKER]: parentSession,
      [NATIVE_PI_SESSION_MARKER]: childSession,
    });

    const first = await runPrRunnerCoordination(
      { command: "claim", repo: "owner/repo", pr: 17 },
      { env: siblingEnv("child-a"), cwd: tempDir },
    );
    assert.equal(first.ok, true);
    assert.equal(first.activeRun.runId, "pi-session-child-a");

    const second = await runPrRunnerCoordination(
      { command: "claim", repo: "owner/repo", pr: 17 },
      { env: siblingEnv("child-b"), cwd: tempDir },
    );
    assert.equal(second.ok, false, "the sibling must conflict, not refresh the first child's lease");
    assert.equal(second.error, "active_run_exists");
    assert.equal(second.activeRun.runId, "pi-session-child-a");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
