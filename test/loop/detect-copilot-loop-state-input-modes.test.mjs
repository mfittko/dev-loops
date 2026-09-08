import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";

import {
  autoDetectSnapshot,
  parseDetectCliArgs,
} from "../../scripts/loop/detect-copilot-loop-state.mjs";
import {
  GH_RUNNER,
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

test("detect-copilot-loop-state --input routes clean exhausted rounds to round_cap_clean_fallback when head changed (no illegal re-request)", async () => {
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
    // Head advanced past the last review, but the cap forbids another Copilot round,
    // so proceed to the pre_approval_gate fallback instead of re-requesting.
    assert.equal(output.state, "round_cap_clean_fallback");
    assert.equal(output.autoRerequestEligible, false);
    assert.equal(output.terminal, true);
    assert.match(output.nextAction, /pre_approval_gate/i);
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

test("detect-copilot-loop-state --input --lightweight: 1 completed round reaches round_cap_reached (lightweight cap defaults to 1, #1210)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-lightweight-cap-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 1,
      actionableThreadCount: 1,
      copilotReviewRoundCount: 1,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath, "--lightweight"]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "round_cap_reached");
    assert.equal(output.terminal, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state --input (no --lightweight): the same 1-round snapshot does NOT reach the round cap (full-PR default cap 5 unchanged, #1210)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-lightweight-cap-"));

  try {
    const snapshotPath = path.join(tempDir, "snapshot.json");
    await writeJson(snapshotPath, {
      prExists: true,
      prNumber: 17,
      copilotReviewRequestStatus: "none",
      copilotReviewPresent: true,
      unresolvedThreadCount: 1,
      actionableThreadCount: 1,
      copilotReviewRoundCount: 1,
      ciStatus: "success",
    });

    const result = await runNode(["--input", snapshotPath]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.notEqual(output.state, "round_cap_reached");
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
      { env, runChild: env[GH_RUNNER] },
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
  assert.equal(missingPrErr.hint, "run with --help for usage");

  const zeroPr = await runNode(["--repo", "owner/repo", "--pr", "0"]);
  assert.equal(zeroPr.code, 1);
  const zeroPrErr = JSON.parse(zeroPr.stderr);
  assert.equal(zeroPrErr.ok, false);
  assert.equal(zeroPrErr.error, "--pr must be a positive integer");
  assert.equal(zeroPrErr.hint, "run with --help for usage");

  const noArgs = await runNode([]);
  assert.equal(noArgs.code, 1);
  const noArgsErr = JSON.parse(noArgs.stderr);
  assert.equal(noArgsErr.ok, false);
  assert.equal(noArgsErr.error, "Provide either --input <path> or --repo <owner/name> --pr <number>");
  assert.equal(noArgsErr.hint, "run with --help for usage");

  const mixedSources = await runNode(["--input", "/tmp/snap.json", "--repo", "owner/repo", "--pr", "17"]);
  assert.equal(mixedSources.code, 1);
  const mixedErr = JSON.parse(mixedSources.stderr);
  assert.equal(mixedErr.ok, false);
  assert.equal(mixedErr.error, "Choose exactly one input source: --input <path> or --repo/--pr auto-detect");
  assert.equal(mixedErr.hint, "run with --help for usage");

  const unknown = await runNode(["--repo", "owner/repo", "--pr", "17", "--wat"]);
  assert.equal(unknown.code, 1);
  const unknownErr = JSON.parse(unknown.stderr);
  assert.equal(unknownErr.ok, false);
  assert.equal(unknownErr.error, "Unknown argument: --wat");
  assert.equal(unknownErr.hint, "run with --help for usage");

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
