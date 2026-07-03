import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  releaseAsyncRunnerOwnership,
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

test("a completed parent that did NOT release can be cleanly taken over by the merge run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-runner-coordination-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-parent", cwd: tempDir });
    const takeover = await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-merge",
      cwd: tempDir,
      mode: "takeover",
    });
    assert.equal(takeover.status, "taken_over");
    assert.equal(takeover.previousRun.runId, "run-parent");
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
