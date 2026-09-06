import { test } from "bun:test";
import { runIdFreeEnv, runNode as runNodeHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  formatWatchCycleConcise,
  parseWatchCycleCliArgs,
  runWatchCycle,
  watchWorkflowRun,
} from "../../scripts/loop/run-watch-cycle.mjs";

const EMPTY_THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [] },
      },
    },
  },
});

function makeWatchCycleGhRunner({ requested = false, reviews = [], workflowRuns = [] } = {}) {
  let reviewRequested = requested;
  return async (_command, args) => {
    const has = (value) => args.includes(value);
    const contains = (value) => args.some((arg) => arg.includes(value));
    const success = (payload = "") => ({
      code: 0,
      stdout: typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`,
      stderr: "",
    });
    if (has("graphql")) return success(JSON.parse(EMPTY_THREADS));
    if (contains("requested_reviewers")) {
      if (has("POST")) {
        reviewRequested = true;
        return success({ requested_reviewers: [{ login: "copilot-pull-request-reviewer[bot]" }] });
      }
      return success({ users: reviewRequested ? [{ login: "Copilot" }] : [], teams: [] });
    }
    if (contains("/issues/17/comments") || contains("/pulls/17/reviews")) return success([]);
    if (contains("/commits/newsha/check-runs")) {
      return success({ check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] });
    }
    if (contains("/commits/newsha/status")) return success({ statuses: [] });
    if (args[0] === "pr" && args[1] === "view") {
      if (args.some((arg) => arg.includes("headRefName"))) {
        return success({ headRefName: "copilot/session-branch" });
      }
      return success({
        isDraft: false,
        state: "OPEN",
        number: 17,
        headRefOid: "newsha",
        reviews,
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
      });
    }
    if (args[0] === "run" && args[1] === "list") return success(workflowRuns);
    if (args[0] === "run" && args[1] === "watch") return success();
    return { code: 97, stdout: "", stderr: `unexpected gh args: ${args.join(" ")}\n` };
  };
}

test("watchWorkflowRun waits for close after a spawn error", async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let settled = false;

  const result = watchWorkflowRun(
    { repo: "owner/repo", runId: 42 },
    {
      env: {},
      ghCommand: "gh",
      spawnImpl: () => child,
    },
  ).finally(() => {
    settled = true;
  });

  child.emit("error", new Error("spawn failed"));
  await Promise.resolve();
  assert.equal(settled, false);

  child.emit("close", -1);
  await assert.rejects(result, /spawn failed/);
  assert.equal(settled, true);
});

test("watchWorkflowRun terminates a timed-out child and waits for close", async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  const killSignals = [];
  child.kill = (signal) => {
    killSignals.push(signal);
    return true;
  };
  let timeoutCallback;
  let settled = false;

  const result = watchWorkflowRun(
    { repo: "owner/repo", runId: 42, timeoutMs: 10 },
    {
      env: {},
      ghCommand: "gh",
      spawnImpl: () => child,
      setTimeoutImpl: (callback) => {
        timeoutCallback = callback;
        return 7;
      },
      clearTimeoutImpl: () => {},
    },
  ).finally(() => {
    settled = true;
  });

  timeoutCallback();
  await Promise.resolve();
  assert.deepEqual(killSignals, ["SIGTERM"]);
  assert.equal(settled, false);

  child.emit("close", null);
  assert.deepEqual(await result, { status: "timed_out" });
  assert.equal(settled, true);
});

test("parseWatchCycleCliArgs rejects --probe-only as a removed policy flag", () => {
  assert.throws(
    () => parseWatchCycleCliArgs(["--repo", "owner/repo", "--pr", "17", "--probe-only"]),
    /--probe-only has been removed/,
  );
});

test("runWatchCycle uses emitted non-zero watchArgs for normal async waiting", async () => {
  let watcherOptions;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "watch",
        state: "waiting_for_copilot_review",
        allowedTransitions: ["unresolved_feedback_present"],
        nextAction: "Wait for Copilot review via scripts/github/probe-copilot-review.mjs",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "pending",
        terminal: false,
        requestWatchContract: {
          action: "watch",
          nextAction: "Wait for Copilot review via scripts/github/probe-copilot-review.mjs",
          requestStatus: "requested",
          routingState: "copilot_request_confirmed_waiting",
          watchEntryConfirmed: true,
          watchArgs: {
            repo: "owner/repo",
            pr: 17,
            pollIntervalMs: 60_000,
            timeoutMs: 1_800_000,
          },
        },
        watchArgs: {
          repo: "owner/repo",
          pr: 17,
          pollIntervalMs: 60_000,
          timeoutMs: 1_800_000,
        },
      }),
      watchCopilotReviewImpl: async (options) => {
        watcherOptions = options;
        return {
          ok: true,
          status: "timeout",
          repo: options.repo,
          pr: options.pr,
          attempts: 30,
          newComments: [],
          newReviews: [],
          newIssueComments: [],
        };
      },
    },
  );

  assert.equal(watcherOptions.timeoutMs, 1_800_000);
  assert.notEqual(watcherOptions.timeoutMs, 0);
  assert.equal(result.watchTimeoutPolicy.minimumTimeoutMs, 1_800_000);
  assert.equal(result.loopDisposition, "pending");
  assert.equal(result.cycleDisposition, "pending");
  assert.equal(result.terminal, false);
  assert.equal(result.watchStatus, "timeout");
  assert.equal(result.state, "waiting_for_copilot_review");
  assert.equal(result.requestWatchContract.routingState, "copilot_request_confirmed_waiting");
  assert.equal(result.contractTrace.waitStrategy.mode, "persistent_watch");
  assert.equal(result.contractTrace.waitStrategy.effectiveTimeoutMs, 1_800_000);
  assert.equal(result.contractTrace.waitStrategy.effectivePollIntervalMs, 60_000);
  assert.equal(result.contractTrace.orchestration.emittedWatchArgs.timeoutMs, 1_800_000);
  assert.equal(result.contractTrace.orchestration.effectiveWatchArgs.timeoutMs, 1_800_000);
  assert.equal(result.contractTrace.stateRefresh.boundaryKind, "post_watch_or_probe");
  assert.equal(result.contractTrace.stopReason.classification, "healthy_wait");
});

test("runWatchCycle rejects persistent watch budgets below the unattended external minimum", async () => {
  await assert.rejects(
    () => runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        runHandoffImpl: async () => ({
          ok: true,
          action: "watch",
          state: "waiting_for_copilot_review",
          allowedTransitions: ["unresolved_feedback_present"],
          nextAction: "Wait for Copilot review via scripts/github/probe-copilot-review.mjs",
          snapshot: { repo: "owner/repo", pr: 17 },
          loopDisposition: "pending",
          terminal: false,
          watchArgs: {
            repo: "owner/repo",
            pr: 17,
            pollIntervalMs: 60_000,
            timeoutMs: 60_000,
          },
        }),
      },
    ),
    /requires at least 1800000 ms/i,
  );
});

test("runWatchCycle keeps shared loopDisposition and reports needs_followup in cycleDisposition when fresh Copilot activity appears", async () => {
  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "watch",
        state: "waiting_for_copilot_review",
        allowedTransitions: ["unresolved_feedback_present"],
        nextAction: "Wait for Copilot review via scripts/github/probe-copilot-review.mjs",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "pending",
        terminal: false,
        watchArgs: {
          repo: "owner/repo",
          pr: 17,
          pollIntervalMs: 60_000,
          timeoutMs: 1_800_000,
        },
      }),
      watchCopilotReviewImpl: async (options) => ({
        ok: true,
        status: "changed",
        repo: options.repo,
        pr: options.pr,
        attempts: 3,
        newComments: [{ id: "comment-1" }],
        newReviews: [],
        newIssueComments: [],
      }),
    },
  );

  assert.equal(result.loopDisposition, "pending");
  assert.equal(result.cycleDisposition, "needs_followup");
  assert.equal(result.terminal, false);
  assert.equal(result.watchStatus, "changed");
  assert.equal(result.contractTrace.stopReason.classification, "routed_followup");
  assert.match(result.contractTrace.stopReason.reason, /Fresh watcher activity requires follow-up/i);
});

test("runWatchCycle preserves unresolved_feedback loopDisposition for fix states without invoking the watcher", async () => {
  let watcherCalled = false;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "fix",
        state: "unresolved_feedback_present",
        allowedTransitions: ["already_fixed_needs_reply_resolve"],
        nextAction: "Address unresolved feedback",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "unresolved_feedback",
        terminal: false,
      }),
      watchCopilotReviewImpl: async () => {
        watcherCalled = true;
        return { ok: true, status: "timeout", repo: "owner/repo", pr: 17, attempts: 1, newComments: [], newReviews: [], newIssueComments: [] };
      },
    },
  );

  assert.equal(watcherCalled, false);
  assert.equal(result.loopDisposition, "unresolved_feedback");
  assert.equal(result.cycleDisposition, "needs_followup");
  assert.equal(result.terminal, false);
  assert.equal(result.watchStatus, undefined);
});

test("runWatchCycle routes a waiting_for_ci boundary to the provider-agnostic CI watcher", async () => {
  let copilotWatcherCalled = false;
  let ciWatchArgs = null;

  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "stop",
        state: "waiting_for_ci",
        allowedTransitions: ["ready_to_rerequest_review"],
        nextAction: "Wait for CI checks to complete or become available",
        snapshot: { repo: "owner/repo", pr: 17, ciStatus: "pending" },
        loopDisposition: "pending",
        terminal: false,
      }),
      watchCopilotReviewImpl: async () => {
        copilotWatcherCalled = true;
        return { ok: true, status: "timeout" };
      },
      watchCiStatusImpl: async (args) => {
        ciWatchArgs = args;
        return { ok: true, status: "failure", settled: true, ciStatus: "failure", failedChecks: [{ name: "circleci/build" }], headSha: "sha-a", attempts: 1 };
      },
    },
  );

  assert.equal(copilotWatcherCalled, false);
  assert.equal(ciWatchArgs.repo, "owner/repo");
  assert.equal(ciWatchArgs.pr, 17);
  // CI wait path uses the external-healthy-wait policy default (CI-specific
  // label only changes diagnostics; the effective budget is unchanged).
  assert.equal(ciWatchArgs.timeoutMs, 1_800_000);
  assert.equal(result.watchStatus, "failure");
  assert.equal(result.ciWatch.status, "failure");
  assert.deepEqual(result.ciWatch.failedChecks, [{ name: "circleci/build" }]);
  assert.equal(result.cycleDisposition, "needs_followup");
  assert.equal(result.terminal, false);
});

test("runWatchCycle keeps a pending CI watch boundary non-terminal", async () => {
  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "stop",
        state: "waiting_for_ci",
        allowedTransitions: ["ready_to_rerequest_review"],
        nextAction: "Wait for CI checks to complete or become available",
        snapshot: { repo: "owner/repo", pr: 17, ciStatus: "pending" },
        loopDisposition: "pending",
        terminal: false,
      }),
      watchCiStatusImpl: async () => ({ ok: true, status: "timeout", settled: false, ciStatus: "pending", failedChecks: [], headSha: "sha-a", attempts: 3 }),
    },
  );

  assert.equal(result.watchStatus, "timeout");
  assert.equal(result.cycleDisposition, "pending");
  assert.equal(result.terminal, false);
  // A quiet CI-watch timeout is a HEALTHY_WAIT (mirrors the Copilot-watch
  // timeout), and the trace records the CI watcher helper + ciWatchArgs.
  assert.equal(result.contractTrace.stopReason.classification, "healthy_wait");
  assert.equal(result.contractTrace.waitStrategy.helper, "scripts/github/probe-ci-status.mjs");
  assert.equal(result.contractTrace.waitStrategy.mode, "persistent_watch");
  assert.equal(result.contractTrace.waitStrategy.effectiveTimeoutMs, 1_800_000);
  assert.equal(result.contractTrace.stateRefresh.observedStatus, "timeout");
  assert.equal(result.contractTrace.orchestration.ciWatchArgs.repo, "owner/repo");
  assert.equal(result.contractTrace.orchestration.ciWatchArgs.pr, 17);
  assert.equal(result.contractTrace.orchestration.effectiveWatchArgs.timeoutMs, 1_800_000);
});

test("runWatchCycle preserves done loopDisposition for stop states without invoking the watcher", async () => {
  let watcherCalled = false;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "stop",
        state: "done",
        allowedTransitions: [],
        nextAction: "Report completion",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "done",
        terminal: true,
      }),
      watchCopilotReviewImpl: async () => {
        watcherCalled = true;
        return { ok: true, status: "timeout", repo: "owner/repo", pr: 17, attempts: 1, newComments: [], newReviews: [], newIssueComments: [] };
      },
    },
  );

  assert.equal(watcherCalled, false);
  assert.equal(result.loopDisposition, "done");
  assert.equal(result.cycleDisposition, "terminal");
  assert.equal(result.terminal, true);
  assert.equal(result.watchStatus, undefined);
  assert.equal(result.contractTrace.stopReason.classification, "terminal");
});

test("runWatchCycle preserves blocked classification for stop states without invoking the watcher", async () => {
  let watcherCalled = false;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "stop",
        state: "blocked_needs_user_decision",
        allowedTransitions: [],
        nextAction: "Stop for a human decision",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "blocked",
        terminal: true,
      }),
      watchCopilotReviewImpl: async () => {
        watcherCalled = true;
        return { ok: true, status: "timeout", repo: "owner/repo", pr: 17, attempts: 1, newComments: [], newReviews: [], newIssueComments: [] };
      },
    },
  );

  assert.equal(watcherCalled, false);
  assert.equal(result.loopDisposition, "blocked");
  assert.equal(result.cycleDisposition, "terminal");
  assert.equal(result.terminal, true);
  assert.equal(result.contractTrace.stopReason.classification, "blocked");
});

test("runWatchCycle integration keeps initial request-review -> waiting_for_copilot_review non-terminal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-cycle-initial-request-"));
  let watcherOptions;

  try {
    const runChild = makeWatchCycleGhRunner();
    const env = runIdFreeEnv({ DEVLOOPS_RUN_ID: "" });

    const result = await runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        env,
        runChild,
        detectSessionActivity: false,
        watchCopilotReviewImpl: async (options) => {
          watcherOptions = options;
          return {
            ok: true,
            status: "timeout",
            repo: options.repo,
            pr: options.pr,
            attempts: 30,
            newComments: [],
            newReviews: [],
            newIssueComments: [],
          };
        },
      },
    );

    assert.equal(result.handoffAction, "watch");
    assert.equal(result.state, "waiting_for_copilot_review");
    assert.equal(result.reviewRequestStatus, "requested");
    assert.equal(result.loopDisposition, "pending");
    assert.equal(result.terminal, false);
    assert.equal(result.watchStatus, "timeout");
    assert.equal(watcherOptions.timeoutMs, 1_800_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runWatchCycle integration keeps re-requested newer-head wait state non-terminal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-cycle-rerequest-"));
  let watcherOptions;

  try {
    const runChild = makeWatchCycleGhRunner({
      reviews: [{
        id: "r-1",
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "COMMENTED",
        commit: { oid: "oldsha" },
      }],
    });
    const env = runIdFreeEnv({ DEVLOOPS_RUN_ID: "" });

    const result = await runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        env,
        runChild,
        detectSessionActivity: false,
        watchCopilotReviewImpl: async (options) => {
          watcherOptions = options;
          return {
            ok: true,
            status: "timeout",
            repo: options.repo,
            pr: options.pr,
            attempts: 30,
            newComments: [],
            newReviews: [],
            newIssueComments: [],
          };
        },
      },
    );

    assert.equal(result.handoffAction, "watch");
    assert.equal(result.state, "waiting_for_copilot_review");
    assert.equal(result.reviewRequestStatus, "requested");
    assert.equal(result.loopDisposition, "pending");
    assert.equal(result.terminal, false);
    assert.equal(result.watchStatus, "timeout");
    assert.equal(watcherOptions.timeoutMs, 1_800_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runWatchCycle integration keeps checks non-blocking with active Copilot workflow run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-cycle-session-active-"));
  let watcherOptions;

  try {
    const env = runIdFreeEnv({ DEVLOOPS_RUN_ID: "" });
    const runChild = makeWatchCycleGhRunner({
      requested: true,
      workflowRuns: [{
        databaseId: 444,
        name: "Addressing comment on PR owner/repo#17",
        status: "in_progress",
        conclusion: "",
        createdAt: "2026-05-27T13:08:48Z",
      }],
    });

    const result = await runWatchCycle(
      { repo: "owner/repo", pr: 17 },
      {
        env,
        runChild,
        detectSessionActivity: true,
        watchWorkflowRunImpl: async () => ({ status: "completed" }),
        watchCopilotReviewImpl: async (options) => {
          watcherOptions = options;
          return {
            ok: true,
            status: "idle",
            repo: options.repo,
            pr: options.pr,
            attempts: 1,
            newComments: [],
            newReviews: [],
            newIssueComments: [],
          };
        },
      },
    );

    assert.equal(result.handoffAction, "watch");
    assert.equal(result.sessionActivity.activity, "active");
    assert.equal(result.sessionActivity.runId, 444);
    assert.equal(result.watchStatus, "idle");
    assert.equal(watcherOptions.repo, "owner/repo");
    assert.equal(watcherOptions.pr, 17);
    assert.equal(watcherOptions.timeoutMs, 1_800_000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test("runWatchCycle integration bounds active Copilot workflow waits by the emitted watch budget", async () => {
  let receivedTimeoutMs = null;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "watch",
        state: "waiting_for_copilot_review",
        allowedTransitions: ["unresolved_feedback_present"],
        nextAction: "Wait for Copilot review via scripts/github/probe-copilot-review.mjs",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "pending",
        terminal: false,
        watchArgs: {
          repo: "owner/repo",
          pr: 17,
          pollIntervalMs: 60_000,
          timeoutMs: 1_800_000,
        },
      }),
      detectSessionActivity: true,
      fetchPrHeadBranchImpl: async () => "copilot/session-branch",
      detectCopilotSessionActivityImpl: async () => ({
        ok: true,
        activity: "active",
        runId: 444,
        runName: "Addressing comment on PR owner/repo#17",
        runStatus: "in_progress",
        runConclusion: null,
        runCreatedAt: "2026-05-27T13:08:48Z",
        branch: "copilot/session-branch",
        confidence: "high",
      }),
      watchWorkflowRunImpl: async ({ timeoutMs }) => {
        receivedTimeoutMs = timeoutMs;
        return { status: "timed_out" };
      },
      watchCopilotReviewImpl: async (options) => ({
        ok: true,
        status: "idle",
        repo: options.repo,
        pr: options.pr,
        attempts: 1,
        newComments: [],
        newReviews: [],
        newIssueComments: [],
      }),
    },
  );

  assert.equal(receivedTimeoutMs, 1_800_000);
  assert.equal(result.sessionActivity.activity, "active");
  assert.equal(result.watchStatus, "idle");
  assert.equal(result.contractTrace.orchestration.workflowRunWatch.attempted, true);
  assert.equal(result.contractTrace.orchestration.workflowRunWatch.timeoutMs, 1_800_000);
  assert.equal(result.contractTrace.orchestration.workflowRunWatch.runId, 444);
  assert.equal(result.contractTrace.orchestration.workflowRunWatch.status, "timed_out");
});

test("runWatchCycle integration keeps the full persistent watch timeout after active Copilot workflow waits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-cycle-session-active-"));
  let watcherOptions;

  try {
    const env = runIdFreeEnv({ DEVLOOPS_RUN_ID: "" });
    const runChild = makeWatchCycleGhRunner({
      requested: true,
      workflowRuns: [{
        databaseId: 444,
        name: "Addressing comment on PR owner/repo#17",
        status: "in_progress",
        conclusion: "",
        createdAt: "2026-05-27T13:08:48Z",
      }],
    });

    const result = await runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        env,
        runChild,
        detectSessionActivity: true,
        watchWorkflowRunImpl: async () => ({ status: "completed" }),
        watchCopilotReviewImpl: async (options) => {
          watcherOptions = options;
          return {
            ok: true,
            status: "idle",
            repo: options.repo,
            pr: options.pr,
            attempts: 1,
            newComments: [],
            newReviews: [],
            newIssueComments: [],
          };
        },
      },
    );

    assert.equal(result.handoffAction, "watch");
    assert.equal(result.sessionActivity.activity, "active");
    assert.equal(watcherOptions.timeoutMs, 1_800_000);
    assert.equal(result.watchStatus, "idle");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runWatchCycle stops with round cap clean fallback when maxCopilotRounds is exceeded with clean PR", async () => {
  let watcherCalled = false;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "stop",
        state: "round_cap_clean_fallback",
        allowedTransitions: [],
        nextAction: "Round cap reached with clean PR; continue to pre_approval_gate instead of re-requesting Copilot review",
        snapshot: {
          prExists: true,
          prNumber: 17,
          copilotReviewRoundCount: 5,
          unresolvedThreadCount: 0,
          ciStatus: "success",
        },
        loopDisposition: "done",
        terminal: true,
        roundCapCleanEligible: true,
      }),
      watchCopilotReviewImpl: async () => {
        watcherCalled = true;
        return { ok: true, status: "timeout" };
      },
    },
  );

  assert.equal(watcherCalled, false);
  assert.equal(result.handoffAction, "stop");
  assert.equal(result.state, "round_cap_clean_fallback");
  assert.equal(result.loopDisposition, "done");
  assert.equal(result.cycleDisposition, "terminal");
  assert.equal(result.terminal, true);
  assert.equal(result.roundCapCleanEligible, true);
});

test("runWatchCycle stops with round cap reached when maxCopilotRounds is exceeded with unresolved threads", async () => {
  let watcherCalled = false;

  const result = await runWatchCycle(
    {
      repo: "owner/repo",
      pr: 17,
      forceRerequestReview: false,
      probeOnly: false,
    },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "stop",
        state: "round_cap_reached",
        allowedTransitions: [],
        nextAction: "Stop: Copilot review round limit reached with unresolved threads or failing CI",
        snapshot: {
          prExists: true,
          prNumber: 17,
          copilotReviewRoundCount: 5,
          unresolvedThreadCount: 3,
          ciStatus: "success",
        },
        loopDisposition: "blocked",
        terminal: true,
        roundCapCleanEligible: false,
      }),
      watchCopilotReviewImpl: async () => {
        watcherCalled = true;
        return { ok: true, status: "timeout" };
      },
    },
  );

  assert.equal(watcherCalled, false);
  assert.equal(result.handoffAction, "stop");
  assert.equal(result.state, "round_cap_reached");
  assert.equal(result.loopDisposition, "blocked");
  assert.equal(result.cycleDisposition, "terminal");
  assert.equal(result.terminal, true);
  assert.equal(result.roundCapCleanEligible, false);
});

test("run-watch-cycle parses --concise/--summary, --jq, --silent flags", () => {
  assert.equal(parseWatchCycleCliArgs(["--repo", "o/r", "--pr", "1", "--concise"]).concise, true);
  assert.equal(parseWatchCycleCliArgs(["--repo", "o/r", "--pr", "1", "--summary"]).concise, true);
  assert.equal(parseWatchCycleCliArgs(["--repo", "o/r", "--pr", "1", "--jq", ".state"]).jq, ".state");
  assert.equal(parseWatchCycleCliArgs(["--repo", "o/r", "--pr", "1", "--silent"]).silent, true);
  assert.equal(parseWatchCycleCliArgs(["--repo", "o/r", "--pr", "1", "-s"]).silent, true);
});

test("formatWatchCycleConcise surfaces loop state, rounds, threads, CI, round-cap, next action, and new bodies", () => {
  const text = formatWatchCycleConcise({
    ok: true,
    state: "waiting_for_copilot_review",
    handoffAction: "watch",
    roundCapCleanEligible: false,
    loopDisposition: "pending",
    cycleDisposition: "needs_followup",
    watchStatus: "changed",
    terminal: false,
    nextAction: "address feedback",
    snapshot: {
      prNumber: 17,
      copilotReviewRoundCount: 3,
      unresolvedThreadCount: 2,
      actionableThreadCount: 1,
      ciStatus: "pending",
    },
    watch: { newComments: [{ body: "line 12 still wrong" }], newReviews: [], newIssueComments: [] },
  });
  assert.match(text, /loop state:\s+waiting_for_copilot_review/);
  assert.match(text, /copilot rounds:\s+3/);
  assert.match(text, /unresolved threads:\s+2/);
  assert.match(text, /actionable threads:\s+1/);
  assert.match(text, /round-cap clean:\s+no/);
  assert.match(text, /CI status:\s+pending/);
  assert.match(text, /next action:\s+address feedback/);
  assert.match(text, /new Copilot comment bodies this round:/);
  assert.match(text, /line 12 still wrong/);
});
