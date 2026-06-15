import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRunnerOwnership,
  claimRunnerOwnership,
  defaultRunnerCoordinationFilePathForTarget,
  ensureAsyncRunnerOwnership,
  loadRunnerCoordinationState,
  releaseRunnerOwnership,
} from "../../scripts/loop/_pr-runner-coordination.mjs";
import { runPrRunnerCoordination } from "../../scripts/loop/pr-runner-coordination.mjs";

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
      env: { PI_SUBAGENT_RUN_ID: "run-1" },
      claimIfMissing: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "claimed_new");
    assert.equal(result.activeRun.runId, "run-1");
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
      env: { PI_SUBAGENT_RUN_ID: "run-2" },
      claimIfMissing: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "claimed_new");
    assert.equal(result.activeRun.runId, "run-2");

    const strict = await ensureAsyncRunnerOwnership({
      repo: "owner/repo",
      pr: 18,
      cwd: tempDir,
      env: { PI_SUBAGENT_RUN_ID: "run-3" },
      claimIfMissing: false,
      requireExisting: true,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.error, "ownership_missing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
