import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectStaleRunner,
  resolveStaleRunnerMaxAgeMs,
  STALE_RUNNER_ERROR,
} from "../../scripts/loop/_stale-runner-detection.mjs";
import {
  claimRunnerOwnership,
  recordExitSignalForRunner,
} from "../../scripts/loop/_pr-runner-coordination.mjs";

test("resolveStaleRunnerMaxAgeMs prefers explicit option, then env, then default", () => {
  const emptyEnv = {};
  assert.equal(resolveStaleRunnerMaxAgeMs({}, emptyEnv), 30 * 60 * 1000);
  assert.equal(resolveStaleRunnerMaxAgeMs({ staleRunnerMaxAgeMs: 5000 }, emptyEnv), 5000);
  assert.equal(resolveStaleRunnerMaxAgeMs({ staleRunnerMaxAgeMs: 5000 }), 5000);
  assert.equal(resolveStaleRunnerMaxAgeMs({}, { PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS: "9000" }), 9000);
  assert.equal(
    resolveStaleRunnerMaxAgeMs({ staleRunnerMaxAgeMs: 5000 }, { PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS: "9000" }),
    5000,
  );
  assert.equal(resolveStaleRunnerMaxAgeMs({ staleRunnerMaxAgeMs: -1 }, emptyEnv), 30 * 60 * 1000);
  assert.equal(resolveStaleRunnerMaxAgeMs({}, { PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS: "abc" }), 30 * 60 * 1000);
});

test("detectStaleRunner returns no_owner_record when no coordination file exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    const result = await detectStaleRunner({ repo: "owner/repo", pr: 17, cwd: tempDir });
    assert.equal(result.ok, true);
    assert.equal(result.status, "no_owner_record");
    assert.equal(result.activeRun, null);
    assert.equal(result.staleRunner, null);
    assert.equal(result.exitSignal, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detectStaleRunner returns fresh_runner when active run is recent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    const claimed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-fresh",
      cwd: tempDir,
      now: new Date().toISOString(),
    });
    assert.equal(claimed.ok, true);

    const result = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      now: Date.parse(claimed.activeRun.claimedAt) + 60_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "fresh_runner");
    assert.equal(result.activeRun.runId, "run-fresh");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detectStaleRunner returns stale_runner when active run is older than max age", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    const claimed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-stale",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });
    assert.equal(claimed.ok, true);

    const result = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      now: Date.parse("2026-06-05T08:00:00.000Z") + 60 * 60 * 1000, // 1 hour later
      maxAgeMs: 30 * 60 * 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, STALE_RUNNER_ERROR.STALE_RUNNER);
    assert.equal(result.status, "stale_runner");
    assert.equal(result.staleRunner.runId, "run-stale");
    assert.ok(result.staleRunner.claimedAgeMs > 30 * 60 * 1000);
    assert.ok(result.staleRunner.updatedAgeMs > 30 * 60 * 1000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detectStaleRunner returns exit_signal_recorded when an exit signal exists for the active run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    const claimed = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });
    assert.equal(claimed.ok, true);

    const exitSignal = await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:05:00.000Z",
      reason: "Fresh runner took over",
    });
    assert.equal(exitSignal.ok, true);

    const result = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      now: Date.parse("2026-06-05T08:05:00.000Z") + 60_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, STALE_RUNNER_ERROR.EXIT_SIGNAL_RECORDED);
    assert.equal(result.status, "exit_signal_recorded");
    assert.equal(result.activeRun.runId, "run-active");
    assert.equal(result.exitSignal.signals.length, 1);
    assert.equal(result.exitSignal.signals[0].reason, "Fresh runner took over");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detectStaleRunner ignores exit signals for non-active runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    // claim a non-owner exit signal that should be ignored (requireActiveOwner=false bypasses the
    // ownership check at write-time, so the signal is stored but the active run never matches it).
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });

    await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 17,
      runId: "run-not-owner",
      cwd: tempDir,
      now: "2026-06-05T08:00:30.000Z",
      reason: "obsolete",
      requireActiveOwner: false,
    });

    const result = await detectStaleRunner({
      repo: "owner/repo",
      pr: 17,
      cwd: tempDir,
      now: Date.parse("2026-06-05T08:00:30.000Z") + 5_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "fresh_runner");
    assert.equal(result.exitSignal, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordExitSignalForRunner rejects when current run is not the active owner", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });

    const result = await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 17,
      runId: "run-stale",
      cwd: tempDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ownership_lost");
    assert.equal(result.activeRun.runId, "run-active");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordExitSignalForRunner allows non-owner recording when requireActiveOwner is false", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });

    const result = await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 17,
      runId: "run-stale",
      cwd: tempDir,
      requireActiveOwner: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "exit_signal_recorded");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("recordExitSignalForRunner rejects when no coordination file exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-"));

  try {
    const result = await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 17,
      runId: "run-stale",
      cwd: tempDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "ownership_missing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
