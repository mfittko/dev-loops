import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOuterLoop } from "../../scripts/loop/outer-loop.mjs";
import {
  MINIMAL_COPILOT_SNAPSHOT,
  runNode,
  writeGhStub,
  writeGitStub,
  writeJson,
} from "./outer-loop-test-helpers.mjs";
// ---------------------------------------------------------------------------
// CLI: false-positive prevention — wait wakeup with no state change → still continue_wait
// ---------------------------------------------------------------------------

test("outer-loop: wait cycles accumulate correctly across multiple re-detect runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-wait-cycles-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });

    const baseArgs = [
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", tempDir,
    ];

    // First run: waitCycles should be 1
    const run1 = await runNode(baseArgs, { env });
    assert.equal(run1.code, 0);
    const out1 = JSON.parse(run1.stdout);
    assert.equal(out1.outerAction, "continue_wait");
    assert.equal(out1.checkpoint.waitCycles, 1);

    // Second run (same state, state still unchanged): waitCycles should be 2
    const run2 = await runNode(baseArgs, { env });
    assert.equal(run2.code, 0);
    const out2 = JSON.parse(run2.stdout);
    assert.equal(out2.outerAction, "continue_wait");
    assert.equal(out2.checkpoint.waitCycles, 2);

    // Third run (still same): waitCycles should be 3
    const run3 = await runNode(baseArgs, { env });
    assert.equal(run3.code, 0);
    const out3 = JSON.parse(run3.stdout);
    assert.equal(out3.outerAction, "continue_wait");
    assert.equal(out3.checkpoint.waitCycles, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: default checkpoint path is repo-qualified", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-default-checkpoint-path-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });
    const result = await runNode([
      "--repo", "Owner/Repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-47", "outer-loop-state.json");
    const { readFile: rf } = await import("node:fs/promises");
    const checkpointText = await rf(checkpointPath, "utf8");
    assert.ok(checkpointText.includes('"repo": "owner/repo"'));
    assert.equal(output.checkpoint.headSha, "abc123");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: cross-repo default checkpoints do not share waitCycles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-repo-qualified-wait-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });

    const run1 = await runNode([
      "--repo", "owner/repo-a", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ], { env, cwd: tempDir });
    assert.equal(JSON.parse(run1.stdout).checkpoint.waitCycles, 1);

    const run2 = await runNode([
      "--repo", "owner/repo-b", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ], { env, cwd: tempDir });
    assert.equal(JSON.parse(run2.stdout).checkpoint.waitCycles, 1);

    const { readFile: rf } = await import("node:fs/promises");
    const repoACheckpoint = JSON.parse(await rf(path.join(tempDir, "tmp", "copilot-loop", "owner", "repo-a", "pr-47", "outer-loop-state.json"), "utf8"));
    const repoBCheckpoint = JSON.parse(await rf(path.join(tempDir, "tmp", "copilot-loop", "owner", "repo-b", "pr-47", "outer-loop-state.json"), "utf8"));
    assert.equal(repoACheckpoint.repo, "owner/repo-a");
    assert.equal(repoBCheckpoint.repo, "owner/repo-b");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: wait cycles carry forward on same repo/pr/head using the default checkpoint path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-default-path-same-head-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });
    const baseArgs = [
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ];

    const run1 = await runNode(baseArgs, { env, cwd: tempDir });
    assert.equal(JSON.parse(run1.stdout).checkpoint.waitCycles, 1);

    const run2 = await runNode(baseArgs, { env, cwd: tempDir });
    assert.equal(JSON.parse(run2.stdout).checkpoint.waitCycles, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: wait cycles reset to 1 when head changes but outer action stays continue_wait", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-wait-head-reset-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });
    const baseArgs = [
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ];

    const run1 = await runNode(baseArgs, { env, cwd: tempDir });
    assert.equal(JSON.parse(run1.stdout).checkpoint.waitCycles, 1);

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "def456",
    });

    const run2 = await runNode(baseArgs, { env, cwd: tempDir });
    const out2 = JSON.parse(run2.stdout);
    assert.equal(out2.checkpoint.waitCycles, 1);
    assert.equal(out2.checkpoint.headSha, "def456");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: legacy default checkpoint fallback is used only for matching repo/pr", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-legacy-fallback-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");
    const legacyCheckpointPath = path.join(tempDir, "tmp", "copilot-loop", "pr-47", "outer-loop-state.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });
    await mkdir(path.dirname(legacyCheckpointPath), { recursive: true });
    await writeJson(legacyCheckpointPath, {
      pr: 47,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 2,
      headSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });
    const run1 = await runNode([
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ], { env, cwd: tempDir });
    assert.equal(JSON.parse(run1.stdout).checkpoint.waitCycles, 3);

    await writeJson(legacyCheckpointPath, {
      pr: 47,
      repo: "other/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 9,
      headSha: "abc123",
    });

    const repoQualifiedPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-47", "outer-loop-state.json");
    await rm(repoQualifiedPath, { force: true });

    const run2 = await runNode([
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ], { env, cwd: tempDir });
    assert.equal(JSON.parse(run2.stdout).checkpoint.waitCycles, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: prefers repo-qualified checkpoint when both new and legacy checkpoints exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-prefer-repo-qualified-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");
    const legacyCheckpointPath = path.join(tempDir, "tmp", "copilot-loop", "pr-47", "outer-loop-state.json");
    const repoQualifiedPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-47", "outer-loop-state.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });
    await mkdir(path.dirname(legacyCheckpointPath), { recursive: true });
    await mkdir(path.dirname(repoQualifiedPath), { recursive: true });
    await writeJson(legacyCheckpointPath, {
      pr: 47,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-16T10:00:00Z",
      waitCycles: 9,
      headSha: "abc123",
    });
    await writeJson(repoQualifiedPath, {
      pr: 47,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 2,
      headSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });
    const run = await runNode([
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
    ], { env, cwd: tempDir });
    assert.equal(JSON.parse(run.stdout).checkpoint.waitCycles, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: wait cycles reset to 0 when outer action changes from continue_wait to reenter_copilot_loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-wait-reset-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });

    // First run: copilot waiting → waitCycles = 1
    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const run1 = await runNode([
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env });
    assert.equal(JSON.parse(run1.stdout).checkpoint.waitCycles, 1);

    // Second run: copilot has review, unresolved threads → reenter_copilot_loop; waitCycles resets to 0
    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 1,
      actionableThreadCount: 1,
      ciStatus: "success",
    });

    const run2 = await runNode([
      "--repo", "owner/repo", "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env });
    assert.equal(run2.code, 0);
    const out2 = JSON.parse(run2.stdout);
    assert.equal(out2.outerAction, "reenter_copilot_loop");
    assert.equal(out2.checkpoint.waitCycles, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: terminal blocked / final gate precedence
// ---------------------------------------------------------------------------

test("outer-loop: PR merged → done (terminal state, takes precedence)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-merged-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prMerged: true,
      prClosed: false,
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prMerged: true,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.outerAction, "done");
    assert.equal(output.copilotState, "done");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: copilot blocked_needs_user_decision → stop / copilot_blocked (beats any wait state)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-copilot-blocked-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    // CI failure maps to blocked_needs_user_decision in copilot state
    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "failure",
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.outerAction, "stop");
    assert.equal(output.reason, "copilot_blocked");
    assert.equal(output.copilotState, "blocked_needs_user_decision");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: checkpoint is persisted to disk
// ---------------------------------------------------------------------------

test("outer-loop: checkpoint file is created at default location under --checkpoint-dir", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-checkpoint-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");
    const checkpointDir = path.join(tempDir, "checkpoint");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", checkpointDir,
    ], { env });

    assert.equal(result.code, 0);

    const { readFile: rf } = await import("node:fs/promises");
    const checkpointText = await rf(path.join(checkpointDir, "outer-loop-state.json"), "utf8");
    const checkpoint = JSON.parse(checkpointText);

    assert.equal(checkpoint.pr, 47);
    assert.equal(checkpoint.repo, "owner/repo");
    assert.equal(checkpoint.outerAction, "continue_wait");
    assert.equal(checkpoint.copilotState, "waiting_for_copilot_review");
    assert.equal(checkpoint.waitCycles, 1);
    assert.ok(typeof checkpoint.timestamp === "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Async-start contract enforcement in runOuterLoop
// ---------------------------------------------------------------------------

test("outer-loop: rejects when no Pi-managed async context markers are present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-async-start-"));
  try {
    const copilotInputPath = path.join(tempDir, "copilot.json");
    await writeJson(copilotInputPath, MINIMAL_COPILOT_SNAPSHOT);

    // Provide only copilot-input (not snapshot mode) with empty env — no Pi markers
    const result = await runOuterLoop(
      { repo: "owner/repo", pr: 47, copilotInputPath, checkpointDir: tempDir },
      { env: {}, ghCommand: "false", gitCommand: "false" },
    );

    assert.equal(result.ok, false);
    assert.equal(result.asyncStartContract, "rejected");
    assert.ok(result.error.includes("No async context detected"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop CLI: async-start rejection exits non-zero and writes JSON error to stderr", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-async-start-cli-"));
  try {
    const copilotInputPath = path.join(tempDir, "copilot.json");
    await writeJson(copilotInputPath, MINIMAL_COPILOT_SNAPSHOT);

    // Clean env with PATH only — no Pi markers, no bypass; only copilot-input so not snapshot mode
    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotInputPath,
      "--checkpoint-dir", tempDir,
    ], { env: { PATH: process.env.PATH } });

    assert.equal(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.asyncStartContract, "rejected");
    assert.ok(payload.error.includes("No async context detected"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: rejects when only PI_SESSION_ID is set (non-snapshot mode)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-async-start-"));
  try {
    const copilotInputPath = path.join(tempDir, "copilot.json");
    await writeJson(copilotInputPath, MINIMAL_COPILOT_SNAPSHOT);
    const env = { PI_SESSION_ID: "test-session-123" };

    // copilot-input only — not snapshot mode; session marker alone is not sufficient evidence
    const result = await runOuterLoop(
      { repo: "owner/repo", pr: 47, copilotInputPath, checkpointDir: tempDir },
      { env, ghCommand: "false", gitCommand: "false" },
    );

    assert.equal(result.ok, false);
    assert.equal(result.asyncStartContract, "rejected");
    assert.ok(result.error.includes("PI_SUBAGENT_RUN_ID"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: proceeds when PI_SUBAGENT_RUN_ID is set (non-snapshot mode)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-async-start-"));
  try {
    const copilotInputPath = path.join(tempDir, "copilot.json");
    await writeJson(copilotInputPath, MINIMAL_COPILOT_SNAPSHOT);
    const gitEnv = await writeGitStub(tempDir);
    const ghEnv = await writeGhStub(tempDir, { repo: "owner/repo", pr: 47 });
    const env = { ...gitEnv, ...ghEnv, PI_SUBAGENT_RUN_ID: "run-123" };

    const result = await runOuterLoop(
      { repo: "owner/repo", pr: 47, copilotInputPath, checkpointDir: tempDir },
      { env, gitCommand: path.join(tempDir, "git") },
    );

    assert.equal(result.ok, true);
    assert.ok(result.outerAction);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: maintainer-controlled asyncStartMode=allowed permits non-snapshot startup", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-async-start-"));
  try {
    const copilotInputPath = path.join(tempDir, "copilot.json");
    await writeJson(copilotInputPath, MINIMAL_COPILOT_SNAPSHOT);
    const gitEnv = await writeGitStub(tempDir);
    const ghEnv = await writeGhStub(tempDir, { repo: "owner/repo", pr: 47 });
    await mkdir(path.join(tempDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".pi", "dev-loop", "settings.yaml"),
      "version: 1\nworkflow:\n  asyncStartMode: allowed\n",
      "utf8",
    );

    // copilot-input only — not snapshot mode; repo policy, not agent env, allows this test setup
    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotInputPath,
      "--checkpoint-dir", tempDir,
    ], { env: { ...gitEnv, ...ghEnv }, cwd: tempDir });

    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.outerAction);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: snapshot mode (both inputs provided) bypasses async-start check", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-async-start-"));
  try {
    const copilotInputPath = path.join(tempDir, "copilot.json");
    const reviewerInputPath = path.join(tempDir, "reviewer.json");
    await writeJson(copilotInputPath, MINIMAL_COPILOT_SNAPSHOT);
    await writeJson(reviewerInputPath, {
      prExists: true,
      prState: "OPEN",
      prNumber: 47,
      prHeadSha: "abc123",
      reviewerScope: "all_reviewers",
      reviewerLogin: null,
      submittedReviewPresent: false,
      submittedReviewState: null,
      submittedReviewCommitSha: null,
      pendingReviewRequestPresent: false,
    });
    const gitEnv = await writeGitStub(tempDir);

    // No Pi markers, no bypass — but both inputs provided = snapshot mode
    const result = await runOuterLoop(
      { repo: "owner/repo", pr: 47, copilotInputPath, reviewerInputPath, checkpointDir: tempDir },
      { env: gitEnv, gitCommand: path.join(tempDir, "git") },
    );

    assert.equal(result.ok, true);
    assert.ok(result.outerAction);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
