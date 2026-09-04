import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decideOuterAction, runOuterLoop } from "../../scripts/loop/outer-loop.mjs";
import {
  runNode,
  writeGhStub,
  writeGitStub,
  writeJson,
} from "./outer-loop-test-helpers.mjs";
test("decideOuterAction: copilot done → done", () => {
  const result = decideOuterAction({
    copilotState: "done",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "done");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: copilot no_pr → stop / pr_not_ready", () => {
  const result = decideOuterAction({
    copilotState: "no_pr",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "stop");
  assert.equal(result.reason, "pr_not_ready");
});

test("decideOuterAction: copilot pr_draft → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: copilot waiting_for_copilot_review → continue_wait", () => {
  const result = decideOuterAction({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: reviewer waiting_for_author_followup → continue_wait", () => {
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "waiting_for_author_followup",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: reviewer waiting_for_re_request → continue_wait", () => {
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "waiting_for_re_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: copilot waiting_for_ci → continue_wait", () => {
  const result = decideOuterAction({
    copilotState: "waiting_for_ci",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "continue_wait");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: reviewer review_requested → reenter_reviewer_loop", () => {
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_requested",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_reviewer_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: reviewer review_invalidated → reenter_reviewer_loop", () => {
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_invalidated",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_reviewer_loop");
});

test("decideOuterAction: copilot unresolved_feedback_present → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: copilot ready_to_rerequest_review → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "ready_to_rerequest_review",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
});

test("decideOuterAction: copilot blocked_needs_user_decision → stop / copilot_blocked", () => {
  const result = decideOuterAction({
    copilotState: "blocked_needs_user_decision",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "stop");
  assert.equal(result.reason, "copilot_blocked");
});

test("decideOuterAction: reviewer blocked_needs_user_decision → stop / reviewer_blocked", () => {
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "blocked_needs_user_decision",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "stop");
  assert.equal(result.reason, "reviewer_blocked");
});

test("decideOuterAction: copilot review_request_unavailable → stop / review_unavailable", () => {
  const result = decideOuterAction({
    copilotState: "review_request_unavailable",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "stop");
  assert.equal(result.reason, "review_unavailable");
});

test("decideOuterAction: dirty checkout + pr_draft → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: true, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: detached HEAD + pr_draft → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "pr_draft",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: true },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: dirty checkout + unresolved_feedback → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
    gitStatus: { isDirty: true, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: detached HEAD + unresolved_feedback → reenter_copilot_loop", () => {
  const result = decideOuterAction({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: false, isDetached: true },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: dirty checkout + reviewer review_requested → reenter_reviewer_loop", () => {
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "review_requested",
    gitStatus: { isDirty: true, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_reviewer_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: dirty checkout + reviewer waiting_for_user_submit → reenter_reviewer_loop (no local exec needed)", () => {
  // waiting_for_user_submit does not need local execution, so dirty checkout is safe
  const result = decideOuterAction({
    copilotState: "pr_ready_no_feedback",
    reviewerState: "waiting_for_user_submit",
    gitStatus: { isDirty: true, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_reviewer_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: dirty checkout + copilot already_fixed_needs_reply_resolve → reenter_copilot_loop (no local edit needed)", () => {
  // already_fixed_needs_reply_resolve only needs GitHub API calls, not code edits
  const result = decideOuterAction({
    copilotState: "already_fixed_needs_reply_resolve",
    reviewerState: "waiting_for_review_request",
    gitStatus: { isDirty: true, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
  assert.equal(result.reason, undefined);
});

test("decideOuterAction: waiting_for_copilot_review keeps orchestrator waiting even when reviewer is active", () => {
  const result = decideOuterAction({
    copilotState: "waiting_for_copilot_review",
    reviewerState: "review_requested",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "continue_wait");
});

test("decideOuterAction: reviewer active still wins when copilot is waiting_for_ci", () => {
  const result = decideOuterAction({
    copilotState: "waiting_for_ci",
    reviewerState: "review_requested",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_reviewer_loop");
});

test("decideOuterAction: copilot active wins over reviewer wait state", () => {
  // Reviewer is waiting_for_author_followup, but copilot needs fix work
  const result = decideOuterAction({
    copilotState: "unresolved_feedback_present",
    reviewerState: "waiting_for_author_followup",
    gitStatus: { isDirty: false, isDetached: false },
  });
  assert.equal(result.outerAction, "reenter_copilot_loop");
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

test("outer-loop --help prints usage and exits 0", async () => {
  const helpLong = await runNode(["--help"]);
  assert.equal(helpLong.code, 0);
  assert.equal(helpLong.stderr, "");
  assert(helpLong.stdout.includes("outer-loop.mjs"), `expected script name in help, got: ${helpLong.stdout}`);
  assert(helpLong.stdout.includes("--repo"), "expected --repo in help");
  assert(helpLong.stdout.includes("--pr"), "expected --pr in help");
  assert(helpLong.stdout.includes("continue_wait"), "expected continue_wait in help");
  assert(helpLong.stdout.includes("reenter_copilot_loop"), "expected reenter_copilot_loop in help");
  assert(helpLong.stdout.includes("reenter_reviewer_loop"), "expected reenter_reviewer_loop in help");

  const helpShort = await runNode(["-h"]);
  assert.equal(helpShort.code, 0);
  assert.equal(helpShort.stdout, helpLong.stdout);
});

test("outer-loop rejects malformed arguments with usage guidance", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.equal(missingPr.stdout, "");
  const err = JSON.parse(missingPr.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error, "outer-loop requires both --repo <owner/name> and --pr <number>");
  assert.equal(err.hint, "run with --help for usage");

  const noArgs = await runNode([]);
  assert.equal(noArgs.code, 1);
  const noArgsErr = JSON.parse(noArgs.stderr);
  assert.equal(noArgsErr.ok, false);
  assert.equal(noArgsErr.hint, "run with --help for usage");

  const unknown = await runNode(["--repo", "owner/repo", "--pr", "17", "--unexpected"]);
  assert.equal(unknown.code, 1);
  const unknownErr = JSON.parse(unknown.stderr);
  assert.equal(unknownErr.ok, false);
  assert.equal(unknownErr.error, "Unknown argument: --unexpected");

  // --reviewer-login removed from CLI; unknown argument test
  const unknownFlag = await runNode([
    "--repo", "owner/repo",
    "--pr", "17",
    "--unknown-flag", "value",
  ]);
  assert.equal(unknownFlag.code, 1);
  const unknownFlagErr = JSON.parse(unknownFlag.stderr);
  assert.equal(unknownFlagErr.ok, false);
  assert.match(unknownFlagErr.error, /Unknown argument: --unknown-flag/);
});

// ---------------------------------------------------------------------------
test("outer-loop: pr_draft → reenter_copilot_loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outer-loop-pr-draft-"));

  try {
    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");
    const checkpointDir = path.join(tempDir, "checkpoint");

    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 53,
      prDraft: true,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "none",
      agentFixStatus: null,
    });

    await writeJson(reviewerInput, {
      reviewRequested: false,
      reviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      draftReviewStored: false,
      localPlanStatus: "none",
      localRunStatus: "none",
      localMergeStatus: "none",
      draftCommentPosted: false,
    });

    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "pr-53-local" });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "53",
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
      "--checkpoint-dir", checkpointDir,
    ], { env });

    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.outerAction, "reenter_copilot_loop");
    assert.equal(output.copilotState, "pr_draft");
    assert.equal(output.reason, undefined);
    assert.equal(output.checkpoint.outerAction, "reenter_copilot_loop");
    assert.equal(output.checkpoint.waitCycles, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// CLI: copilot wait timeout → re-detect → continue_wait
// ---------------------------------------------------------------------------

test("outer-loop: waiting_for_copilot_review → continue_wait", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-copilot-wait-"));

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
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--reviewer-input", reviewerSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.outerAction, "continue_wait");
    assert.equal(output.copilotState, "waiting_for_copilot_review");
    assert.equal(output.reason, undefined);
    assert.ok(output.checkpoint, "expected checkpoint in output");
    assert.equal(output.checkpoint.outerAction, "continue_wait");
    assert.equal(output.checkpoint.pr, 47);
    assert.equal(output.checkpoint.repo, "owner/repo");
    assert.equal(output.checkpoint.waitCycles, 1);
    assert.ok(typeof output.checkpoint.timestamp === "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop mixed live+snapshot input keeps local sourceMode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-mixed-source-mode-"));

  try {
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    const gitEnv = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "main" });
    const env = await writeGhStub(tempDir, { repo: "owner/myrepo", pr: 47, headSha: "abc123" });

    const output = await runOuterLoop({
      repo: "Owner/MyRepo",
      pr: 47,
      reviewerInputPath: reviewerSnapshotPath,
      checkpointDir: tempDir,
    }, { env: { ...gitEnv, ...env, DEVLOOPS_RUN_ID: "test-run-123" }, ghCommand: "gh", gitCommand: "git" });

    assert.equal(output.conductorRouting.handoffEnvelope.confidence, "local");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: copilot pr_draft → reenter_copilot_loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-copilot-draft-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: true,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "none",
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: true,
      prHeadSha: "abc123",
      reviewRequested: false,
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
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.outerAction, "reenter_copilot_loop");
    assert.equal(output.copilotState, "pr_draft");
    assert.equal("reason" in output, false);
    assert.equal(output.checkpoint.waitCycles, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: reviewer submitted_review handoff boundary → continue_wait
// ---------------------------------------------------------------------------

test("outer-loop: reviewer submitted_review (same head) → continue_wait", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-reviewer-followup-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    // Copilot is at pr_ready_no_feedback (no review yet, no unresolved threads)
    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });

    // Reviewer submitted review on current head (handoff boundary to remediation/follow-up)
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
    assert.equal(output.outerAction, "continue_wait");
    assert.equal(output.reviewerState, "submitted_review");
    assert.equal(output.reviewerScope.mode, "all_reviewers");
    assert.equal(output.reviewerScope.reviewerLogin, null);
    assert.equal(output.checkpoint.reviewerScope, "all_reviewers");
    assert.equal(output.checkpoint.reviewerLogin, null);
    assert.equal(output.checkpoint.waitCycles, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: reviewer submitted_review after author push → continue_wait (same remediation family)
// ---------------------------------------------------------------------------

test("outer-loop: reviewer submitted_review (author pushed; no re-request) → continue_wait", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-reviewer-rerequest-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });

    // Author pushed a new commit since review submission; no explicit re-request yet.
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "def456",
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
      reviewRequested: false,
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
    assert.equal(output.outerAction, "continue_wait");
    assert.equal(output.reviewerState, "submitted_review");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: explicit re-request after author/Copilot follow-up → reviewer re-entry
// ---------------------------------------------------------------------------

test("outer-loop: submitted_review → review_requested after explicit re-request → reenter_reviewer_loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-reviewer-reentry-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });

    // Reviewer was re-requested after author pushed → review_requested
    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "def456",
      reviewerScope: "single_reviewer",
      reviewerLogin: "pi-reviewer",
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
      reviewRequested: true,
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
    assert.equal(output.outerAction, "reenter_reviewer_loop");
    assert.equal(output.reviewerState, "review_requested");
    assert.equal(output.reviewerScope.mode, "single_reviewer");
    assert.equal(output.reviewerScope.reviewerLogin, "pi-reviewer");
    assert.equal(output.checkpoint.reviewerScope, "single_reviewer");
    assert.equal(output.checkpoint.reviewerLogin, "pi-reviewer");
    assert.equal(output.checkpoint.waitCycles, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: isolation-needed re-entry stays as a handoff with requiresLocalIsolation
// ---------------------------------------------------------------------------

test("outer-loop: dirty checkout + unresolved_feedback → handoff_to_copilot_loop with isolation flag", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-dirty-copilot-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 2,
      actionableThreadCount: 2,
      ciStatus: "success",
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
    });

    // Dirty checkout (modified files)
    const env = await writeGitStub(tempDir, {
      porcelainOutput: " M src/foo.ts\n M src/bar.ts",
      headRef: "main",
    });

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
    assert.equal(output.outerAction, "reenter_copilot_loop");
    assert.equal(output.reason, undefined);
    assert.equal(output.copilotState, "unresolved_feedback_present");
    assert.equal(output.conductorRouting.routingOutcome, "handoff_to_copilot_loop");
    assert.equal(output.conductorRouting.handoffEnvelope.requiresLocalIsolation, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: detached HEAD + reviewer review_requested → handoff_to_reviewer_loop with isolation flag", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-detached-reviewer-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");
    const reviewerSnapshotPath = path.join(tempDir, "reviewer-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
    });

    await writeJson(reviewerSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prHeadSha: "abc123",
      reviewRequested: true,
    });

    // Detached HEAD
    const env = await writeGitStub(tempDir, { porcelainOutput: "", headRef: "HEAD" });

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
    assert.equal(output.outerAction, "reenter_reviewer_loop");
    assert.equal(output.reason, undefined);
    assert.equal(output.conductorRouting.routingOutcome, "handoff_to_reviewer_loop");
    assert.equal(output.conductorRouting.handoffEnvelope.requiresLocalIsolation, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: dirty local checkout keeps PR-draft follow-up as an isolation-managed handoff", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-dirty-local-pr-draft-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");

    await writeJson(copilotSnapshotPath, {
      prExists: true,
      prNumber: 47,
      prDraft: true,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "none",
    });

    const gitEnv = await writeGitStub(tempDir, {
      porcelainOutput: " M docs/notes.md",
      headRef: "main",
      headSha: "def456",
    });
    const ghEnv = await writeGhStub(tempDir, {
      repo: "owner/repo",
      pr: 47,
      headRefName: "copilot/fix-gate-progression-issue",
      headSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env: { ...gitEnv, ...ghEnv, DEVLOOPS_RUN_ID: "test-run-123" } });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outerAction, "reenter_copilot_loop");
    assert.equal(output.reason, undefined);
    assert.equal(output.branchIdentity.localBranch, "main");
    assert.equal(output.branchIdentity.prBranch, "copilot/fix-gate-progression-issue");
    assert.equal(output.branchIdentity.branchMatches, false);
    assert.equal(output.branchIdentity.headMatches, false);
    assert.equal(output.conductorRouting.routingOutcome, "handoff_to_copilot_loop");
    assert.equal(output.conductorRouting.handoffEnvelope.requiresLocalIsolation, true);
    assert.equal(output.conductorRouting.handoffEnvelope.requiredArgs.headRefName, "copilot/fix-gate-progression-issue");
    assert.equal(output.conductorRouting.handoffEnvelope.requiredArgs.headRefOid, "abc123");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: active PR branch mismatch stops with explicit reconcile reason", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-branch-mismatch-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");

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

    const gitEnv = await writeGitStub(tempDir, {
      porcelainOutput: "",
      headRef: "main",
      headSha: "abc123",
    });
    const ghEnv = await writeGhStub(tempDir, {
      repo: "owner/repo",
      pr: 47,
      headRefName: "copilot/fix-gate-progression-issue",
      headSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env: { ...gitEnv, ...ghEnv, DEVLOOPS_RUN_ID: "test-run-123" } });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outerAction, "stop");
    assert.equal(output.reason, "unsafe_local_branch_mismatch_requires_reconcile");
    assert.equal(output.branchIdentity.localBranch, "main");
    assert.equal(output.branchIdentity.prBranch, "copilot/fix-gate-progression-issue");
    assert.equal(output.branchIdentity.branchMatches, false);
    assert.equal(output.branchIdentity.headMatches, true);
    assert.equal(output.conductorRouting.routingOutcome, "stop_needs_human");
    assert.equal(output.conductorRouting.stopReason, "unsafe_local_branch_mismatch_requires_reconcile");
    assert.equal(output.conductorRouting.handoffEnvelope.loopFamily, null);
    assert.equal(output.conductorRouting.handoffEnvelope.entrypoint, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop: branch match but local head mismatch stops with explicit reconcile reason", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-outer-head-mismatch-"));

  try {
    const copilotSnapshotPath = path.join(tempDir, "copilot-snapshot.json");

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

    const gitEnv = await writeGitStub(tempDir, {
      porcelainOutput: "",
      headRef: "copilot/fix-gate-progression-issue",
      headSha: "def456",
    });
    const ghEnv = await writeGhStub(tempDir, {
      repo: "owner/repo",
      pr: 47,
      headRefName: "copilot/fix-gate-progression-issue",
      headSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "47",
      "--copilot-input", copilotSnapshotPath,
      "--checkpoint-dir", tempDir,
    ], { env: { ...gitEnv, ...ghEnv, DEVLOOPS_RUN_ID: "test-run-123" } });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outerAction, "stop");
    assert.equal(output.reason, "unsafe_local_head_mismatch_requires_reconcile");
    assert.equal(output.branchIdentity.localBranch, "copilot/fix-gate-progression-issue");
    assert.equal(output.branchIdentity.prBranch, "copilot/fix-gate-progression-issue");
    assert.equal(output.branchIdentity.branchMatches, true);
    assert.equal(output.branchIdentity.headMatches, false);
    assert.equal(output.conductorRouting.routingOutcome, "stop_needs_human");
    assert.equal(output.conductorRouting.stopReason, "unsafe_local_head_mismatch_requires_reconcile");
    assert.equal(output.conductorRouting.handoffEnvelope.loopFamily, null);
    assert.equal(output.conductorRouting.handoffEnvelope.entrypoint, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
