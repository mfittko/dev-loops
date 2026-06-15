import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  autoDetectSnapshot,
  parseDetectCliArgs,
} from "../../scripts/loop/detect-copilot-loop-state.mjs";
import {
  makeComment,
  makeThread,
  runNode,
  writeAutoDetectGhStub,
  writeGhStub,
  writeJson,
} from "./detect-copilot-loop-state-test-helpers.mjs";
test("detect-copilot-loop-state --input interprets a snapshot file and emits state JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-input-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "pr_ready_no_feedback");
    assert.ok(Array.isArray(output.allowedTransitions));
    assert.ok(typeof output.nextAction === "string" && output.nextAction.length > 0);
    assert.ok(output.snapshot && typeof output.snapshot === "object");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input routes unresolved threads to unresolved_feedback_present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-unresolved-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewPresent: true,
      unresolvedThreadCount: 2,
      actionableThreadCount: 1,
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "unresolved_feedback_present");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input routes unavailable status to review_request_unavailable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-unavailable-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "unavailable",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "review_request_unavailable");
    assert.deepEqual(output.allowedTransitions, []);
    assert.match(output.nextAction, /stop/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input routes already-fixed threads to already_fixed_needs_reply_resolve", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-fixed-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewPresent: true,
      unresolvedThreadCount: 1,
      actionableThreadCount: 1,
      agentFixStatus: "applied",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "already_fixed_needs_reply_resolve");
    assert.deepEqual(output.allowedTransitions, ["ready_to_rerequest_review"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input re-opens clean exhausted rounds to ready_to_rerequest_review when head changed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-round-cap-clean-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      copilotReviewRoundCount: 5,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.autoRerequestEligible, true);
    assert.equal(output.terminal, false);
    assert.match(output.nextAction, /Re-request Copilot review/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input fails closed to round_cap_clean_fallback when current-head review signal is omitted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-round-cap-clean-missing-head-signal-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      copilotReviewRoundCount: 5,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "round_cap_clean_fallback");
    assert.equal(output.autoRerequestEligible, false);
    assert.equal(output.terminal, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input keeps clean exhausted rounds on current head at round_cap_clean_fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-round-cap-clean-current-head-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      copilotReviewOnCurrentHead: true,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      copilotReviewRoundCount: 5,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "round_cap_clean_fallback");
    assert.equal(output.terminal, true);
    assert.match(output.nextAction, /pre_approval_gate/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input routes blocked exhausted rounds to round_cap_reached", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-round-cap-blocked-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 1,
      actionableThreadCount: 1,
      copilotReviewRoundCount: 5,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "round_cap_reached");
    assert.equal(output.terminal, true);
    assert.match(output.nextAction, /do not re-request review/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input routes failed review request to blocked_needs_user_decision", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-failed-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "failed",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "blocked_needs_user_decision");
    assert.deepEqual(output.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input returns done for merged PR snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-done-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      prMerged: true,
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "done");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Auto-detect mode via gh stubs
// ---------------------------------------------------------------------------

test("detect-copilot-loop-state auto-detect accepts successful status-context rollup entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-status-context-success-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "abc123",
          reviews: [],
          statusCheckRollup: [
            { state: "SUCCESS" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "pr_ready_no_feedback");
    assert.equal(output.snapshot.ciStatus, "success");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state auto-detect returns waiting_for_ci when statusCheckRollup is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-missing-rollup-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.ciStatus, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-copilot-loop-state auto-detect tracks completed Copilot review rounds in the snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-round-count-"));

  try {
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {
        headRefOid: "abc123",
        reviews: [
          {
            id: "r-old",
            author: { login: "copilot-pull-request-reviewer[bot]" },
            state: "COMMENTED",
            commit: { oid: "old123" },
            submittedAt: "2026-01-10T00:00:00Z",
          },
          {
            id: "r-current",
            author: { login: "copilot-pull-request-reviewer[bot]" },
            state: "CHANGES_REQUESTED",
            commit: { oid: "abc123" },
            submittedAt: "2026-01-11T00:00:00Z",
          },
          {
            id: "r-human",
            author: { login: "human-reviewer" },
            state: "APPROVED",
            commit: { oid: "abc123" },
            submittedAt: "2026-01-11T01:00:00Z",
          },
        ],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      },
      requestedReviewers: { users: [], teams: [] },
      reviewThreads: [],
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.snapshot.copilotReviewRoundCount, 2);
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("autoDetectSnapshot uses the default ghCommand when deps omit it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-auto-detect-default-deps-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: `${emptyThreads}\n`,
      },
    ]);

    const snapshot = await autoDetectSnapshot(
      { repo: "owner/repo", pr: 17 },
      { env },
    );

    assert.equal(snapshot.prExists, true);
    assert.equal(snapshot.prNumber, 17);
    assert.equal(snapshot.copilotReviewRequestStatus, "none");
    assert.equal(snapshot.unresolvedThreadCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-copilot-loop-state auto-detect returns done for merged PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-merged-"));

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "MERGED",
          number: 17,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "done");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state auto-detect returns no_pr when gh reports PR not found", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-no-pr-"));

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "99", "--repo", "owner/repo"],
        stderr: "no pull requests found for branch\n",
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "99"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "no_pr");
    assert.equal(output.snapshot.prExists, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state --review-request-status override injects status without re-probing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-override-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
      // Note: NO requested_reviewers call — override skips it
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--review-request-status", "unavailable"],
      { env },
    );

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "review_request_unavailable");
    assert.equal(output.snapshot.copilotReviewRequestStatus, "unavailable");
    assert.deepEqual(output.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state auto-detect detects CI pending status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-ci-pending-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [
            { status: "IN_PROGRESS", conclusion: null, name: "build" },
            { status: "COMPLETED", conclusion: "SUCCESS", name: "lint" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "pending");
    assert.equal(output.state, "waiting_for_ci");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state auto-detect prioritizes CI failure over pending checks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-ci-failure-priority-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "FAILURE", name: "test" },
            { status: "IN_PROGRESS", conclusion: null, name: "build" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "failure");
    assert.equal(output.state, "blocked_needs_user_decision");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state auto-detect fails when the gh stub is missing a scripted invocation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gh-budget-"));

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "gh command failed: unexpected gh args: api repos/owner/repo/pulls/17/requested_reviewers",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

test("detect-copilot-loop-state rejects malformed arguments deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.equal(missingPr.stdout, "");
  const missingPrErr = JSON.parse(missingPr.stderr);
  assert.equal(missingPrErr.ok, false);
  assert.equal(missingPrErr.error, "Auto-detect mode requires both --repo <owner/name> and --pr <number>");
  assert.equal(typeof missingPrErr.usage, "string");
  assert(missingPrErr.usage.length > 0);

  const zeroPr = await runNode(["--repo", "owner/repo", "--pr", "0"]);
  assert.equal(zeroPr.code, 1);
  const zeroPrErr = JSON.parse(zeroPr.stderr);
  assert.equal(zeroPrErr.ok, false);
  assert.equal(zeroPrErr.error, "--pr must be a positive integer");
  assert.equal(typeof zeroPrErr.usage, "string");
  assert(zeroPrErr.usage.length > 0);

  const noArgs = await runNode([]);
  assert.equal(noArgs.code, 1);
  const noArgsErr = JSON.parse(noArgs.stderr);
  assert.equal(noArgsErr.ok, false);
  assert.equal(noArgsErr.error, "Provide either --input <path> or --repo <owner/name> --pr <number>");
  assert.equal(typeof noArgsErr.usage, "string");
  assert(noArgsErr.usage.length > 0);

  const mixedSources = await runNode(["--input", "/tmp/snap.json", "--repo", "owner/repo", "--pr", "17"]);
  assert.equal(mixedSources.code, 1);
  const mixedErr = JSON.parse(mixedSources.stderr);
  assert.equal(mixedErr.ok, false);
  assert.equal(mixedErr.error, "Choose exactly one input source: --input <path> or --repo/--pr auto-detect");
  assert.equal(typeof mixedErr.usage, "string");
  assert(mixedErr.usage.length > 0);

  const unknown = await runNode(["--repo", "owner/repo", "--pr", "17", "--wat"]);
  assert.equal(unknown.code, 1);
  const unknownErr = JSON.parse(unknown.stderr);
  assert.equal(unknownErr.ok, false);
  assert.equal(unknownErr.error, "Unknown argument: --wat");
  assert.equal(typeof unknownErr.usage, "string");
  assert(unknownErr.usage.length > 0);

  // --review-request-status removed from CLI; unknown flag now caught as "Unknown argument"
  const badOverride = await runNode(["--repo", "owner/repo", "--pr", "17", "--review-request-status", "bogus"]);
  assert.equal(badOverride.code, 1);
  assert.match(JSON.parse(badOverride.stderr).error, /Unknown argument: --review-request-status/);

  // --review-request-status removed; --input mode rejects it as unknown
  const overrideWithInput = await runNode(["--input", "/tmp/snap.json", "--review-request-status", "none"]);
  assert.equal(overrideWithInput.code, 1);
  assert.match(JSON.parse(overrideWithInput.stderr).error, /Unknown argument: --review-request-status/);
});

test("detect-copilot-loop-state --help prints usage and exits 0", async () => {
  const helpLong = await runNode(["--help"]);
  assert.equal(helpLong.code, 0);
  assert.equal(helpLong.stderr, "");
  assert(helpLong.stdout.includes("detect-copilot-loop-state.mjs"), `expected script name in help, got: ${helpLong.stdout}`);
  assert(helpLong.stdout.includes("--repo"), `expected --repo in help`);
  assert(helpLong.stdout.includes("--pr"), `expected --pr in help`);
  assert(helpLong.stdout.includes("--input"), `expected --input in help`);

  const helpShort = await runNode(["-h"]);
  assert.equal(helpShort.code, 0);
  assert.equal(helpShort.stderr, "");
  assert.equal(helpShort.stdout, helpLong.stdout);
});

test("detect-copilot-loop-state reports gh failures deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gh-failure-"));

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stderr: "gh: authentication required\n",
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "gh command failed: gh: authentication required",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state fails closed when review threads cannot be fetched", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-thread-failure-"));

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stderr: "GraphQL error: reviewThreads unavailable\n",
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Could not determine review-thread state: gh command failed: GraphQL error: reviewThreads unavailable",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Steering integration — real loop surface changes behavior after steering
// ---------------------------------------------------------------------------

test.skip("parseDetectCliArgs accepts --steering-state-file flag in auto-detect mode", () => {
  const opts = parseDetectCliArgs(["--repo", "owner/repo", "--pr", "17", "--steering-state-file", "/tmp/st.json"]);
  assert.equal(opts.steeringStateFile, "/tmp/st.json");
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.pr, 17);
});

test.skip("parseDetectCliArgs accepts --local-validation-head-sha in auto-detect mode", () => {
  const opts = parseDetectCliArgs(["--repo", "owner/repo", "--pr", "17", "--local-validation-head-sha", "abc123"]);
  assert.equal(opts.localValidationHeadSha, "abc123");
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.pr, 17);
});

test.skip("parseDetectCliArgs rejects --steering-state-file in snapshot mode", () => {
  assert.throws(
    () => parseDetectCliArgs(["--input", "/tmp/snap.json", "--steering-state-file", "/tmp/st.json"]),
    /--steering-state-file cannot be combined with --input/,
  );
});

test.skip("parseDetectCliArgs rejects --local-validation-head-sha in snapshot mode", () => {
  assert.throws(
    () => parseDetectCliArgs(["--input", "/tmp/snap.json", "--local-validation-head-sha", "abc123"]),
    /--local-validation-head-sha cannot be combined with --input/,
  );
});

test("parseDetectCliArgs leaves steeringStateFile undefined when flag is absent", () => {
  const opts = parseDetectCliArgs(["--input", "/tmp/snap.json"]);
  assert.equal(opts.steeringStateFile, undefined);
});

test("detect-copilot-loop-state without steering file omits steeringApplied from output (backward-compatible)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-compat-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewPresent: true,
      unresolvedThreadCount: 0,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(output, "steeringApplied"),
      "steeringApplied must not appear when no steering file is provided");
    assert.ok(!Object.prototype.hasOwnProperty.call(output, "effectiveConstraints"),
      "effectiveConstraints must not appear when no steering file is provided");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state with empty steering file adds steering fields but keeps original nextAction", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-empty-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {
        reviews: [{
          id: "review-1",
          state: "COMMENTED",
          author: { login: "copilot-pull-request-reviewer" },
          commit: { oid: "abc123" },
        }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    await writeJson(steeringPath, {
      runId: "pr-17",
      target: { repo: "owner/repo", pr: 17 },
      schemaVersion: 1,
      events: [],
      effectiveStack: [],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 1,
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--review-request-status", "none", "--steering-state-file", steeringPath], { env });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.steeringApplied, false, "steeringApplied must be false when no effective steering");
    assert.ok(output.effectiveConstraints, "effectiveConstraints must be present");
    assert.deepEqual(output.effectiveConstraints.hardConstraints, []);
    assert.equal(output.effectiveConstraints.stopAtNextSafeGate, false);
    assert.ok(!/Stop at this safe gate/.test(output.nextAction));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state: stop_at_next_safe_gate steering overrides nextAction on the real loop surface", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-stop-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {
        reviews: [{
          id: "review-1",
          state: "COMMENTED",
          author: { login: "copilot-pull-request-reviewer" },
          commit: { oid: "abc123" },
        }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    await writeJson(steeringPath, {
      runId: "pr-17",
      target: { repo: "owner/repo", pr: 17 },
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "pr-17",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review cycle",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      effectiveStack: [{
        eventId: "evt-001",
        runId: "pr-17",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review cycle",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      queuedEvents: [],
      resultHistory: [{
        eventId: "evt-001",
        seq: 1,
        result: "applied_now",
        reason: null,
        acknowledgedAt: "2026-05-16T09:00:00.000Z",
      }],
      latestResult: {
        eventId: "evt-001",
        seq: 1,
        result: "applied_now",
        reason: null,
        acknowledgedAt: "2026-05-16T09:00:00.000Z",
      },
      nextSeq: 2,
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--review-request-status", "none", "--steering-state-file", steeringPath], { env });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.steeringApplied, true);
    assert.match(output.nextAction, /Stop at this safe gate/);
    assert.match(output.nextAction, /stop_at_next_safe_gate/);
    assert.equal(output.effectiveConstraints.stopAtNextSafeGate, true);
    assert.deepEqual(output.effectiveConstraints.hardConstraints, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state: hard_constraint steering is visible in effectiveConstraints on the real loop surface", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-hard-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 42,
      prView: {
        reviews: [],
        statusCheckRollup: [],
      },
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    await writeJson(steeringPath, {
      runId: "pr-42",
      target: { repo: "owner/repo", pr: 42 },
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "pr-42",
        kind: "hard_constraint",
        directive: "Do not add new npm dependencies",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      effectiveStack: [{
        eventId: "evt-001",
        runId: "pr-42",
        kind: "hard_constraint",
        directive: "Do not add new npm dependencies",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 2,
    });

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "42",
      "--review-request-status", "requested",
      "--steering-state-file", steeringPath,
    ], { env });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "waiting_for_copilot_review");
    assert.equal(output.steeringApplied, true);
    assert.deepEqual(output.effectiveConstraints.hardConstraints, ["Do not add new npm dependencies"]);
    assert.equal(output.effectiveConstraints.stopAtNextSafeGate, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state: stop_at_next_safe_gate is visible as pending when loop is not at a safe point", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-nogate-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {
        reviews: [{
          id: "review-1",
          state: "COMMENTED",
          author: { login: "copilot-pull-request-reviewer" },
          commit: { oid: "abc123" },
        }],
      },
      reviewThreads: [
        makeThread({
          id: "thread-1",
          isResolved: false,
          comments: [makeComment({ id: "comment-1", body: "Please fix this" })],
        }),
        makeThread({
          id: "thread-2",
          isResolved: false,
          comments: [makeComment({ id: "comment-2", body: "And this too" })],
        }),
      ],
      skipRequestedReviewers: true,
    });

    await writeJson(steeringPath, {
      runId: "pr-17",
      target: { repo: "owner/repo", pr: 17 },
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "pr-17",
        kind: "stop_at_next_safe_gate",
        directive: "Stop at next gate",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      effectiveStack: [{
        eventId: "evt-001",
        runId: "pr-17",
        kind: "stop_at_next_safe_gate",
        directive: "Stop at next gate",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 2,
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--review-request-status", "none", "--steering-state-file", steeringPath], { env });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "unresolved_feedback_present");
    assert.equal(output.steeringApplied, true);
    assert.equal(output.pendingStopAtNextSafeGate, true);
    assert.match(output.nextAction, /Pending stop_at_next_safe_gate/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state: missing --steering-state-file path returns steering-free output (ENOENT tolerant)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-missing-"));

  try {
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {
        reviews: [{
          id: "review-1",
          state: "COMMENTED",
          author: { login: "copilot-pull-request-reviewer" },
          commit: { oid: "abc123" },
        }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    const steeringPath = path.join(tempDir, "nonexistent-steering.json");
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17",
      "--review-request-status", "none",
      "--steering-state-file", steeringPath,
    ], { env });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.steeringApplied, false);
    assert.equal(output.effectiveConstraints.stopAtNextSafeGate, false);
    assert.equal(output.terminalStopAtNextSafeGate, false);
    await assert.rejects(() => stat(steeringPath), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test.skip("detect-copilot-loop-state fails closed when a provided steering file targets a different repo/pr", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-target-mismatch-"));

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "55", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 55,
          headRefOid: "abc123",
          reviews: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/55/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }) + "\n",
      },
    ]);
    const steeringPath = path.join(tempDir, "steering.json");
    await writeJson(steeringPath, {
      runId: "pr-55",
      target: { repo: "other/repo", pr: 55 },
      schemaVersion: 1,
      events: [],
      effectiveStack: [],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 1,
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--steering-state-file", steeringPath,
    ], { env });

    assert.equal(result.code, 1);
    const err = JSON.parse(result.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /steering state target mismatch/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state rejects --input with --steering-state-file at the CLI boundary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-input-reject-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const steeringPath = path.join(tempDir, "steering.json");

    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 42,
      copilotReviewPresent: true,
      unresolvedThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(steeringPath, {
      runId: "pr-42",
      schemaVersion: 1,
      events: [],
      effectiveStack: [],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 1,
    });

    const result = await runNode([
      "--input", snapshotPath,
      "--steering-state-file", steeringPath,
    ]);

    assert.equal(result.code, 1);
    const err = JSON.parse(result.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /--steering-state-file cannot be combined with --input/);
    assert.match(err.usage, /detect-copilot-loop-state\.mjs/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state: terminal stop_at_next_safe_gate is surfaced when the loop is blocked", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-terminal-stop-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 17,
      prView: {},
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    await writeJson(steeringPath, {
      runId: "pr-17",
      target: { repo: "owner/repo", pr: 17 },
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "pr-17",
        kind: "stop_at_next_safe_gate",
        directive: "Stop at next gate",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      effectiveStack: [{
        eventId: "evt-001",
        runId: "pr-17",
        kind: "stop_at_next_safe_gate",
        directive: "Stop at next gate",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-16T09:00:00.000Z",
      }],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 2,
    });

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17",
      "--review-request-status", "failed",
      "--steering-state-file", steeringPath,
    ], { env });

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "blocked_needs_user_decision");
    assert.equal(output.pendingStopAtNextSafeGate, false);
    assert.equal(output.terminalStopAtNextSafeGate, true);
    assert.match(output.nextAction, /inactive because the loop is in terminal state/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state: durable reload — steering applied after steer-loop submit is reflected on real loop surface", async () => {
  const steerScriptPath = path.resolve("scripts/loop/steer-loop.mjs");

  function runSteerNode(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [steerScriptPath, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => { resolve({ code, stdout, stderr }); });
    });
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-reload-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 77,
      prView: {
        reviews: [{
          id: "review-1",
          state: "COMMENTED",
          author: { login: "copilot-pull-request-reviewer" },
          commit: { oid: "abc123" },
        }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    const submitResult = await runSteerNode([
      "submit",
      "--run-id", "run-77",
      "--kind", "stop_at_next_safe_gate",
      "--directive", "Stop before next review pass",
      "--seq", "1",
      "--loop-state", "waiting_for_copilot_review",
      "--state-file", steeringPath,
    ]);
    assert.equal(submitResult.code, 0, `steer-loop submit failed: ${submitResult.stderr || submitResult.stdout}`);
    const submitOut = JSON.parse(submitResult.stdout);
    assert.equal(submitOut.result.result, "applied_now");

    const persisted = JSON.parse(await readFile(steeringPath, "utf8"));
    persisted.runId = "pr-77";
    persisted.events = persisted.events.map((event) => ({ ...event, runId: "pr-77" }));
    persisted.effectiveStack = persisted.effectiveStack.map((event) => ({ ...event, runId: "pr-77" }));
    persisted.queuedEvents = persisted.queuedEvents.map((event) => ({ ...event, runId: "pr-77" }));
    persisted.target = { repo: "owner/repo", pr: 77 };
    await writeJson(steeringPath, persisted);

    const detectResult = await runNode(["--repo", "owner/repo", "--pr", "77", "--review-request-status", "none", "--steering-state-file", steeringPath], { env });

    assert.equal(detectResult.code, 0, `detect failed: ${detectResult.stderr || detectResult.stdout}`);
    const detectOut = JSON.parse(detectResult.stdout);
    assert.equal(detectOut.ok, true);
    assert.equal(detectOut.state, "ready_to_rerequest_review");
    assert.equal(detectOut.steeringApplied, true);
    assert.match(detectOut.nextAction, /Stop at this safe gate/);
    assert.equal(detectOut.effectiveConstraints.stopAtNextSafeGate, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state leaves queued stop_at_next_safe_gate unchanged until the steering owner promotes it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-detect-steer-promote-"));

  try {
    const steeringPath = path.join(tempDir, "steering.json");
    const { env } = await writeAutoDetectGhStub(tempDir, {
      pr: 88,
      prView: {
        reviews: [{
          id: "review-1",
          state: "COMMENTED",
          author: { login: "copilot-pull-request-reviewer" },
          commit: { oid: "abc123" },
        }],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      reviewThreads: [],
      skipRequestedReviewers: true,
    });

    await writeJson(steeringPath, {
      runId: "pr-88",
      target: { repo: "owner/repo", pr: 88 },
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "pr-88",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-19T12:00:00.000Z",
      }],
      effectiveStack: [],
      queuedEvents: [{
        eventId: "evt-001",
        runId: "pr-88",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-19T12:00:00.000Z",
      }],
      resultHistory: [{
        eventId: "evt-001",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
        acknowledgedAt: "2026-05-19T12:00:01.000Z",
      }],
      latestResult: {
        eventId: "evt-001",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "Loop is in 'pr_draft' (not a safe point for immediate application); steering queued for next safe point",
        acknowledgedAt: "2026-05-19T12:00:01.000Z",
      },
      nextSeq: 2,
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "88", "--review-request-status", "none", "--steering-state-file", steeringPath], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.steeringApplied, false);
    assert.doesNotMatch(output.nextAction, /Stop at this safe gate/);

    const persisted = JSON.parse(await readFile(steeringPath, "utf8"));
    assert.equal(persisted.queuedEvents.length, 1);
    assert.equal(persisted.effectiveStack.length, 0);
    assert.equal(persisted.latestResult.result, "queued_for_safe_point");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
