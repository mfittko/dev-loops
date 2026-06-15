import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseWatchCycleCliArgs, runWatchCycle } from "../../scripts/loop/run-watch-cycle.mjs";

const EMPTY_THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [] },
      },
    },
  },
});

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return { ...env, PI_SUBAGENT_RUN_ID: "" };
}

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

test("runWatchCycle uses emitted non-zero watchArgs for normal async waiting", async () => {
  let watcherOptions;
  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    {
      runHandoffImpl: async () => ({
        ok: true,
        action: "watch",
        state: "waiting_for_copilot_review",
        allowedTransitions: [],
        nextAction: "Wait for Copilot review.",
        snapshot: { repo: "owner/repo", pr: 17 },
        loopDisposition: "pending",
        terminal: false,
        watchArgs: { repo: "owner/repo", pr: 17, pollIntervalMs: 60_000, timeoutMs: 1_800_000 },
        watchTimeoutPolicy: { classification: "external_healthy_wait", minimumTimeoutMs: 1_800_000, defaultTimeoutMs: 1_800_000 },
        requestWatchContract: { action: "watch", nextAction: "Wait", requestStatus: "requested", routingState: "copilot_request_confirmed_waiting", watchEntryConfirmed: true, watchArgs: { repo: "owner/repo", pr: 17, pollIntervalMs: 60_000, timeoutMs: 1_800_000 } },
      }),
      watchCopilotReviewImpl: async (opts) => {
        watcherOptions = opts;
        return { ok: true, status: "idle", repo: "owner/repo", pr: 17, attempts: 1, newComments: [], newReviews: [], newIssueComments: [] };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.watchStatus, "idle");
  assert.equal(watcherOptions.timeoutMs, 1_800_000);
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
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: `${EMPTY_THREADS}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefName"],
        stdout: '{"headRefName":"copilot/session-branch"}\n',
      },
      {
        assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/session-branch"],
        stdout: "[]\n",
      },
    ]);

    const result = await runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        env,
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
    const ghPath = path.join(tempDir, "gh");
    await writeFile(
      ghPath,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const write = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value) + "\\n");
const requestedStatePath = process.env.GH_REREQUEST_STATE_PATH;

if (args[0] === "pr" && args[1] === "view" && !args.includes("--json")) {
  write({
    isDraft: false,
    state: "OPEN",
    number: 17,
    headRefOid: "newsha",
    reviews: [
      {
        id: "r-1",
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "COMMENTED",
        commit: { oid: "oldsha" }
      }
    ],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }]
  });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/17/requested_reviewers") {
  const requested = existsSync(requestedStatePath);
  write(requested ? { users: [{ login: "Copilot" }], teams: [] } : { users: [], teams: [] });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  write(${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })});
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/commits/newsha/check-runs?per_page=100") {
  write({ check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/commits/newsha/status?per_page=100") {
  write({ statuses: [] });
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view" && args.includes("--json") && args.includes("headRefOid,isDraft,state,number,reviews,statusCheckRollup")) {
  write({
    headRefOid: "newsha",
    isDraft: false,
    state: "OPEN",
    number: 17,
    reviews: [
      {
        id: "r-1",
        state: "COMMENTED",
        author: { login: "copilot-pull-request-reviewer[bot]" },
        commit: { oid: "oldsha" }
      }
    ],
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }]
  });
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "edit" && args.includes("--add-reviewer") && args.includes("@copilot")) {
  writeFileSync(requestedStatePath, "requested\\n");
  write("https://github.com/owner/repo/pull/17\\n");
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view" && args.includes("--json") && args.includes("headRefName")) {
  write({ headRefName: "copilot/session-branch" });
  process.exit(0);
}

if (args[0] === "run" && args[1] === "list" && args.includes("--branch") && args.includes("copilot/session-branch")) {
  write([]);
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
process.exit(97);
`,
      "utf8",
    );
    await chmod(ghPath, 0o755);

    const env = {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}`,
      GH_REREQUEST_STATE_PATH: path.join(tempDir, "requested-state.txt"),
      GH_SEQUENCE_PATH: path.join(tempDir, "gh-sequence.json"),
      PI_SUBAGENT_RUN_ID: "",
    };

    const result = await runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        env,
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
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: `${EMPTY_THREADS}\n`,
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefName"],
        stdout: '{"headRefName":"copilot/session-branch"}\n',
      },
      {
        assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/session-branch"],
        stdout: `${JSON.stringify([
          {
            databaseId: 444,
            name: "Addressing comment on PR owner/repo#17",
            status: "in_progress",
            conclusion: "",
            createdAt: "2026-05-27T13:08:48Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["run", "watch", "444", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runWatchCycle(
      { repo: "owner/repo", pr: 17 },
      {
        env,
        detectSessionActivity: true,
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
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: `${EMPTY_THREADS}\n`,
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefName"],
        stdout: '{"headRefName":"copilot/session-branch"}\n',
      },
      {
        assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/session-branch"],
        stdout: `${JSON.stringify([
          {
            databaseId: 444,
            name: "Addressing comment on PR owner/repo#17",
            status: "in_progress",
            conclusion: "",
            createdAt: "2026-05-27T13:08:48Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["run", "watch", "444", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runWatchCycle(
      {
        repo: "owner/repo",
        pr: 17,
        forceRerequestReview: false,
        probeOnly: false,
      },
      {
        env,
        detectSessionActivity: true,
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
