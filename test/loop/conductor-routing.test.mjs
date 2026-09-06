/**
 * Integration tests for conductor routing wired through outer-loop.mjs.
 *
 * These tests verify that the outer-loop's output includes a `conductorRouting`
 * field built by evaluateConductorRouting, and that the routing outcome
 * matches the outer-loop's action decision.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/outer-loop.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

const writeJson = writeJsonHelper;

async function writeGitStub(tempDir, { porcelainOutput = "", headRef = "main" } = {}) {
  const gitPath = path.join(tempDir, "git");
  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2).join(' ');",
      `if (args.includes('status') && args.includes('porcelain')) {`,
      `  process.stdout.write(${JSON.stringify(porcelainOutput ? porcelainOutput + "\n" : "")});`,
      `  process.exit(0);`,
      `}`,
      `if (args.includes('rev-parse') && args.includes('abbrev-ref')) {`,
      `  process.stdout.write(${JSON.stringify(headRef + "\n")});`,
      `  process.exit(0);`,
      `}`,
      `process.exit(0);`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);
  return {
    ...process.env,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
  };
}

// ---------------------------------------------------------------------------
// Integration: outer-loop emits conductorRouting in output
// ---------------------------------------------------------------------------

test("outer-loop output includes conductorRouting field with routingOutcome and handoffEnvelope", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // Copilot review requested → waiting_for_copilot_review
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 99,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewOnCurrentHead: false,
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    });

    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 99,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "99",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.ok);
    assert.ok("conductorRouting" in result, "output must include conductorRouting field");
    assert.ok("routingOutcome" in result.conductorRouting, "conductorRouting must have routingOutcome");
    assert.ok("handoffEnvelope" in result.conductorRouting, "conductorRouting must have handoffEnvelope");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop continue_wait → conductorRouting.routingOutcome=continue_current_wait", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // Copilot review requested but not yet received → waiting_for_copilot_review
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 1,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewOnCurrentHead: false,
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    });

    // Reviewer not yet requested → waiting_for_review_request
    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 1,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "1",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.outerAction, "continue_wait");
    assert.equal(result.conductorRouting.routingOutcome, "continue_current_wait");
    assert.equal(result.conductorRouting.handoffEnvelope.loopFamily, "outer_loop");
    assert.equal(result.conductorRouting.handoffEnvelope.entrypoint, "outer_loop_wait");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop keeps waiting when copilot re-review is unsettled even if reviewer is active", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 11,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewOnCurrentHead: false,
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    });

    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 11,
      reviewRequested: true,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "11",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.outerAction, "continue_wait");
    assert.equal(result.conductorRouting.routingOutcome, "continue_current_wait");
    assert.equal(result.conductorRouting.handoffEnvelope.loopFamily, "outer_loop");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop reenter_copilot_loop → conductorRouting.routingOutcome=handoff_to_copilot_loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // Unresolved threads → unresolved_feedback_present
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 2,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      unresolvedThreadCount: 2,
      actionableThreadCount: 2,
      agentFixStatus: null,
      ciStatus: "success",
    });

    // Reviewer not requested → waiting_for_review_request
    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 2,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "2",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.outerAction, "reenter_copilot_loop");
    assert.equal(result.conductorRouting.routingOutcome, "handoff_to_copilot_loop");
    assert.equal(result.conductorRouting.handoffEnvelope.loopFamily, "copilot_loop");
    assert.equal(result.conductorRouting.handoffEnvelope.entrypoint, "copilot_pr_handoff");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop reenter_reviewer_loop → conductorRouting.routingOutcome=handoff_to_reviewer_loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // No feedback yet, no review request → pr_ready_no_feedback
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 3,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      agentFixStatus: null,
      ciStatus: "success",
    });

    // Review requested → review_requested (active reviewer state)
    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 3,
      reviewRequested: true,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "3",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.outerAction, "reenter_reviewer_loop");
    assert.equal(result.conductorRouting.routingOutcome, "handoff_to_reviewer_loop");
    assert.equal(result.conductorRouting.handoffEnvelope.loopFamily, "reviewer_loop");
    assert.equal(result.conductorRouting.handoffEnvelope.entrypoint, "reviewer_loop_handler");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop stop/copilot_blocked → conductorRouting.routingOutcome=stop_needs_human", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // Failed review request → blocked_needs_user_decision
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 4,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "failed",
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      agentFixStatus: null,
      ciStatus: "none",
    });

    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 4,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "4",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.outerAction, "stop");
    assert.equal(result.conductorRouting.routingOutcome, "stop_needs_human");
    assert.equal(result.conductorRouting.handoffEnvelope.loopFamily, null);
    assert.equal(result.conductorRouting.handoffEnvelope.entrypoint, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop done → conductorRouting.routingOutcome=done_terminal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // Merged PR → done
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 5,
      prDraft: false,
      prMerged: true,
      prClosed: false,
      copilotReviewRequestStatus: "none",
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      agentFixStatus: null,
      ciStatus: "success",
    });

    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 5,
      prMerged: true,
    });

    const { code, stdout } = await runNode([
      "--repo", "test/repo",
      "--pr", "5",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.equal(result.outerAction, "done");
    assert.equal(result.conductorRouting.routingOutcome, "done_terminal");
    assert.equal(result.conductorRouting.handoffEnvelope.loopFamily, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outer-loop normalizes repo casing consistently across handoff envelope and checkpoint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "conductor-routing-test-"));
  try {
    const env = await writeGitStub(tempDir);
    const checkpointDir = path.join(tempDir, "checkpoint");

    const copilotInput = path.join(tempDir, "copilot.json");
    const reviewerInput = path.join(tempDir, "reviewer.json");

    // Copilot review requested → waiting_for_copilot_review
    await writeJson(copilotInput, {
      prExists: true,
      prNumber: 77,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      agentFixStatus: null,
      ciStatus: "success",
    });

    await writeJson(reviewerInput, {
      prExists: true,
      prNumber: 77,
    });

    const { code, stdout } = await runNode([
      "--repo", "Owner/MyRepo",
      "--pr", "77",
      "--checkpoint-dir", checkpointDir,
      "--copilot-input", copilotInput,
      "--reviewer-input", reviewerInput,
    ], { env });

    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    // repo is normalized once in outer-loop so checkpoint and handoff envelope agree
    assert.equal(result.conductorRouting.handoffEnvelope.targetIdentity.repo, "owner/myrepo");
    assert.equal(result.conductorRouting.handoffEnvelope.targetIdentity.pr, 77);
    assert.equal(result.checkpoint.repo, "owner/myrepo");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
