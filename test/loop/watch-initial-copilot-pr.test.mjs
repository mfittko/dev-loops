import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  parseWatchInitialCopilotPrCliArgs,
  watchInitialCopilotPr,
} from "../../scripts/loop/watch-initial-copilot-pr.mjs";

const scriptPath = path.resolve("scripts/loop/watch-initial-copilot-pr.mjs");

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// ---------------------------------------------------------------------------
// gh stub helpers (for subprocess / CLI integration tests)
// ---------------------------------------------------------------------------

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return env;
}

function linkedPrPayload({ hasOpenLinkedPr = true, prNumber = 79, prUrl = "https://github.com/owner/repo/pull/79" } = {}) {
  return `${JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: hasOpenLinkedPr ? [
              {
                __typename: "ConnectedEvent",
                createdAt: "2026-05-21T09:49:32Z",
                subject: {
                  __typename: "PullRequest",
                  number: prNumber,
                  state: "OPEN",
                  url: prUrl,
                  repository: { nameWithOwner: "owner/repo" },
                },
              },
            ] : [],
          },
        },
      },
    },
  })}\n`;
}

function linkedPrClosedPayload({ closedPrNumber = 149, closedPrUrl = "https://github.com/owner/repo/pull/149" } = {}) {
  return `${JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                __typename: "ConnectedEvent",
                createdAt: "2026-05-01T09:49:32Z",
                subject: {
                  __typename: "PullRequest",
                  number: closedPrNumber,
                  state: "CLOSED",
                  url: closedPrUrl,
                  repository: { nameWithOwner: "owner/repo" },
                },
              },
            ],
          },
        },
      },
    },
  })}\n`;
}

function pullRequestFactsPayload({
  number = 79,
  url = "https://github.com/owner/repo/pull/79",
  headRefName = "copilot/example-branch",
  state = "OPEN",
  isDraft = true,
  repo = "owner/repo",
  authorLogin = "Copilot",
  authorType = "Bot",
  changedFiles = 0,
  commitCount = 1,
  messageHeadline = "Initial plan",
} = {}) {
  const nodes = commitCount > 0 ? [{ commit: { messageHeadline } }] : [];

  return `${JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number,
          url,
          headRefName,
          state,
          isDraft,
          changedFiles,
          repository: { nameWithOwner: repo },
          author: { login: authorLogin, __typename: authorType },
          commits: { totalCount: commitCount, nodes },
        },
      },
    },
  })}\n`;
}

// ---------------------------------------------------------------------------
// Injectable mock factory for watchInitialCopilotPr unit tests
// ---------------------------------------------------------------------------

/**
 * Build a mock detectInitialCopilotPrState function that replays a sequence
 * of state responses.  Each element of `states` is returned on successive calls.
 * If all states are consumed the last element is repeated indefinitely.
 */
function makeDetectMock(states) {
  let callCount = 0;
  return async () => {
    const index = Math.min(callCount, states.length - 1);
    callCount += 1;
    return states[index];
  };
}

/** Monotonically advancing fake clock.  Advances by `step` on each call. */
function makeFakeNow(startMs = 0, step = 0) {
  let current = startMs;
  return () => {
    const t = current;
    current += step;
    return t;
  };
}

// ---------------------------------------------------------------------------
// CLI arg-parsing unit tests
// ---------------------------------------------------------------------------

test("parseWatchInitialCopilotPrCliArgs parses required args", () => {
  const opts = parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "59"]);
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.issue, 59);
  assert.equal(opts.pollIntervalMs, 60_000);
  assert.equal(opts.timeoutMs, 3_600_000);
});

test("parseWatchInitialCopilotPrCliArgs rejects --poll-interval-ms as a removed policy flag", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "59", "--poll-interval-ms", "5000"]),
    /--poll-interval-ms has been removed/,
  );
});

test("parseWatchInitialCopilotPrCliArgs rejects --timeout-ms 0 as a removed policy flag", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "59", "--timeout-ms", "0"]),
    /--timeout-ms has been removed/,
  );
});

test("parseWatchInitialCopilotPrCliArgs rejects --timeout-ms 30000 as a removed policy flag", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "59", "--timeout-ms", "30000"]),
    /--timeout-ms has been removed/,
  );
});

test("parseWatchInitialCopilotPrCliArgs trims whitespace from --repo", () => {
  const opts = parseWatchInitialCopilotPrCliArgs(["--repo", "  owner/repo  ", "--issue", "59"]);
  assert.equal(opts.repo, "owner/repo");
});

test("parseWatchInitialCopilotPrCliArgs throws on missing --repo", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--issue", "59"]),
    /watch-initial-copilot-pr requires both --repo.*and --issue/i,
  );
});

test("parseWatchInitialCopilotPrCliArgs throws on missing --issue", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo"]),
    /watch-initial-copilot-pr requires both --repo.*and --issue/i,
  );
});

test("parseWatchInitialCopilotPrCliArgs throws on bad issue number", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "0"]),
    /--issue must be a positive integer/i,
  );
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "abc"]),
    /--issue must be a positive integer/i,
  );
});

test("parseWatchInitialCopilotPrCliArgs rejects --poll-interval-ms 0 as a removed policy flag", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "1", "--poll-interval-ms", "0"]),
    /--poll-interval-ms has been removed/,
  );
});

test("parseWatchInitialCopilotPrCliArgs rejects --timeout-ms -1 as a removed policy flag", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "1", "--timeout-ms", "-1"]),
    /--timeout-ms has been removed/,
  );
});

test("parseWatchInitialCopilotPrCliArgs throws on unknown flag", () => {
  assert.throws(
    () => parseWatchInitialCopilotPrCliArgs(["--repo", "owner/repo", "--issue", "1", "--unknown"]),
    /Unknown argument: --unknown/i,
  );
});

test("parseWatchInitialCopilotPrCliArgs sets help flag and returns early", () => {
  const opts = parseWatchInitialCopilotPrCliArgs(["--help"]);
  assert.equal(opts.help, true);
});

// ---------------------------------------------------------------------------
// watchInitialCopilotPr unit tests (injected mocks, no real gh calls)
// ---------------------------------------------------------------------------

test("watchInitialCopilotPr returns ready_for_followup immediately when PR is already substantive", async () => {
  const detect = makeDetectMock([
    { ok: true, state: "linked_pr_ready_for_followup", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 3_600_000 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_for_followup");
  assert.equal(result.repo, "owner/repo");
  assert.equal(result.issue, 59);
  assert.equal(result.prNumber, 79);
  assert.equal(result.prUrl, "https://github.com/owner/repo/pull/79");
  assert.equal(result.attempts, 1);
});

test("watchInitialCopilotPr bootstrap-only draft PR is a healthy wait state (not a failure)", async () => {
  // Single-check mode: bootstrap-only → timed_out (not an error)
  const detect = makeDetectMock([
    {
      ok: true,
      state: "waiting_for_initial_copilot_implementation",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
    },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 0 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.prNumber, 79);
  assert.equal(result.attempts, 1);
});

test("watchInitialCopilotPr no_linked_pr is a healthy wait state (not a failure)", async () => {
  // no_linked_pr is transient and must not surface as an error
  const detect = makeDetectMock([
    { ok: true, state: "no_linked_pr", prNumber: null, prUrl: null },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 0 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.prNumber, null);
  assert.equal(result.attempts, 1);
});

test("watchInitialCopilotPr rejects short non-zero persistent budgets for direct callers", async () => {
  await assert.rejects(
    () => watchInitialCopilotPr(
      { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 30_000 },
      {
        detectInitialCopilotPrStateImpl: makeDetectMock([
          { ok: true, state: "no_linked_pr", prNumber: null, prUrl: null },
        ]),
      },
    ),
    /requires at least 3600000 ms/,
  );
});

test("watchInitialCopilotPr transitions to ready_for_followup when PR becomes substantive", async () => {
  // Simulates the durable-auto path: first poll = still bootstrap-only,
  // second poll = substantive.  This is the core handoff scenario.
  const detect = makeDetectMock([
    {
      ok: true,
      state: "waiting_for_initial_copilot_implementation",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
    },
    {
      ok: true,
      state: "linked_pr_ready_for_followup",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
    },
  ]);

  let delayCount = 0;
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 3_600_000 },
    {
      detectInitialCopilotPrStateImpl: detect,
      delayImpl: async () => { delayCount += 1; },
      nowMs: makeFakeNow(0, 0),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_for_followup");
  assert.equal(result.prNumber, 79);
  assert.equal(result.attempts, 2);
  assert.equal(delayCount, 1); // waited once between the two polls
});

test("watchInitialCopilotPr blocks on active Copilot session run before continuing", async () => {
  const detect = makeDetectMock([
    {
      ok: true,
      state: "copilot_session_active",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
      sessionRunId: 444,
    },
    {
      ok: true,
      state: "linked_pr_ready_for_followup",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
    },
  ]);

  let watchCalls = 0;
  let delayCount = 0;
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 3_600_000 },
    {
      detectInitialCopilotPrStateImpl: detect,
      watchCopilotRunUntilCompleteImpl: async ({ runId }) => {
        watchCalls += 1;
        assert.equal(runId, 444);
      },
      delayImpl: async () => { delayCount += 1; },
      nowMs: makeFakeNow(0, 0),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_for_followup");
  assert.equal(result.attempts, 2);
  assert.equal(watchCalls, 1);
  assert.equal(delayCount, 0);
});

test("watchInitialCopilotPr honors an exhausted timeout before blocking on an active Copilot session", async () => {
  const detect = makeDetectMock([
    {
      ok: true,
      state: "copilot_session_active",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
      sessionRunId: 444,
    },
  ]);

  let watchCalls = 0;
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 0 },
    {
      detectInitialCopilotPrStateImpl: detect,
      watchCopilotRunUntilCompleteImpl: async () => {
        watchCalls += 1;
      },
      nowMs: makeFakeNow(0, 0),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.attempts, 1);
  assert.equal(watchCalls, 0);
});

test("watchInitialCopilotPr returns timed_out when the active-session watch exhausts the remaining budget", async () => {
  const detect = makeDetectMock([
    {
      ok: true,
      state: "copilot_session_active",
      prNumber: 79,
      prUrl: "https://github.com/owner/repo/pull/79",
      sessionRunId: 444,
    },
  ]);

  let receivedTimeoutMs = null;
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 3_600_000 },
    {
      detectInitialCopilotPrStateImpl: detect,
      watchCopilotRunUntilCompleteImpl: async ({ timeoutMs }) => {
        receivedTimeoutMs = timeoutMs;
        return { status: "timed_out" };
      },
      nowMs: makeFakeNow(0, 0),
    },
  );

  assert.equal(receivedTimeoutMs, 3_600_000);
  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.attempts, 1);
});

test("watchInitialCopilotPr quiet idle/timeout cycles are healthy non-terminal waits", async () => {
  // Multiple bootstrap-only cycles before eventual transition.
  // None of the quiet cycles should surface as failures.
  const detect = makeDetectMock([
    { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
    { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
    { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
    { ok: true, state: "linked_pr_ready_for_followup", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 3_600_000 },
    {
      detectInitialCopilotPrStateImpl: detect,
      delayImpl: async () => {},
      nowMs: makeFakeNow(0, 0),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_for_followup");
  assert.equal(result.attempts, 4);
});

test("watchInitialCopilotPr 1-hour watch budget expiry produces explicit timed_out outcome (not implementation failure)", async () => {
  // After 3 polls the fake clock exceeds the budget.
  // The result must be timed_out, not a runtime error.
  const detect = makeDetectMock([
    { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
    { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
  ]);

  // Clock: 0 → 30 min → 60 min (= timeoutMs) → triggers timed_out on 2nd poll
  // The first two 0s are the start-time read and the elapsed check after poll 1;
  // 1_800_000 is the elapsed check after delayImpl; 3_600_000 is elapsed after poll 2.
  const HALF_HOUR_MS = 1_800_000;
  const ONE_HOUR_MS = 3_600_000;
  let tick = 0;
  const nowMs = () => {
    const times = [0, 0, HALF_HOUR_MS, ONE_HOUR_MS];
    return times[Math.min(tick++, times.length - 1)];
  };

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 1_800_000, timeoutMs: 3_600_000 },
    {
      detectInitialCopilotPrStateImpl: detect,
      delayImpl: async () => {},
      nowMs,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.attempts, 2);
  // elapsedMs should be at or beyond the timeout
  assert.ok(result.elapsedMs >= 3_600_000, `expected elapsedMs >= 3600000, got ${result.elapsedMs}`);
});

test("watchInitialCopilotPr no regression: bootstrap-only PR never triggers implementation-style failure", async () => {
  // Ensures the existing bug (subagent failure for no-edit implementation task)
  // is not re-introduced.  The ok field must be true for all healthy wait outcomes.
  for (const state of ["waiting_for_initial_copilot_implementation", "no_linked_pr"]) {
    const detect = makeDetectMock([
      { ok: true, state, prNumber: state === "no_linked_pr" ? null : 79, prUrl: null },
    ]);

    const result = await watchInitialCopilotPr(
      { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 0 },
      { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
    );

    assert.equal(result.ok, true, `expected ok=true for state=${state}`);
    assert.equal(result.status, "timed_out", `expected timed_out for state=${state}`);
  }
});

test("watchInitialCopilotPr false-positive prevention: unrelated no_linked_pr does not trigger follow-up handoff", async () => {
  // no_linked_pr is a wait state, not a signal to continue or fail.
  const detect = makeDetectMock([
    { ok: true, state: "no_linked_pr", prNumber: null, prUrl: null },
    { ok: true, state: "no_linked_pr", prNumber: null, prUrl: null },
    { ok: true, state: "linked_pr_ready_for_followup", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 3_600_000 },
    {
      detectInitialCopilotPrStateImpl: detect,
      delayImpl: async () => {},
      nowMs: makeFakeNow(0, 0),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_for_followup");
  assert.equal(result.prNumber, 79);
  assert.equal(result.attempts, 3);
});

test("watchInitialCopilotPr re-checks the authoritative linked PR state on each watch cycle", async () => {
  // Validates that each cycle calls detectInitialCopilotPrState with the same
  // repo+issue target (not a stale cached value).
  const calls = [];
  const detect = async ({ repo, issue }) => {
    calls.push({ repo, issue });
    return calls.length < 3
      ? { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: null }
      : { ok: true, state: "linked_pr_ready_for_followup", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" };
  };

  await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 100, timeoutMs: 3_600_000 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.repo, "owner/repo");
    assert.equal(call.issue, 59);
  }
});

test("watchInitialCopilotPr output shape includes all required fields", async () => {
  const detect = makeDetectMock([
    { ok: true, state: "linked_pr_ready_for_followup", prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 10, pollIntervalMs: 60_000, timeoutMs: 3_600_000 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.status, "string");
  assert.equal(typeof result.repo, "string");
  assert.equal(typeof result.issue, "number");
  assert.ok("prNumber" in result);
  assert.ok("prUrl" in result);
  assert.equal(typeof result.attempts, "number");
  assert.equal(typeof result.elapsedMs, "number");
});

test("watchInitialCopilotPr prior_linked_pr_closed_unmerged exits immediately without polling further", async () => {
  // prior_linked_pr_closed_unmerged is a terminal non-wait state and must not
  // be treated as a healthy bootstrap wait: the loop must exit on the first poll.
  const detect = makeDetectMock([
    { ok: true, state: "prior_linked_pr_closed_unmerged", prNumber: 149, prUrl: "https://github.com/owner/repo/pull/149" },
    // A second entry that should never be reached:
    { ok: true, state: "linked_pr_ready_for_followup", prNumber: 150, prUrl: "https://github.com/owner/repo/pull/150" },
  ]);

  let delayCount = 0;
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 130, pollIntervalMs: 60_000, timeoutMs: 3_600_000 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => { delayCount += 1; }, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "prior_linked_pr_closed_unmerged");
  assert.equal(result.prNumber, 149);
  assert.equal(result.prUrl, "https://github.com/owner/repo/pull/149");
  assert.equal(result.attempts, 1);
  assert.equal(delayCount, 0); // no delay — immediate exit
});

test("watchInitialCopilotPr prior_linked_pr_closed_unmerged exits even when timeout is nonzero", async () => {
  const detect = makeDetectMock([
    { ok: true, state: "prior_linked_pr_closed_unmerged", prNumber: 149, prUrl: null },
  ]);

  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 130, pollIntervalMs: 60_000, timeoutMs: 3_600_000 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {}, nowMs: makeFakeNow(0, 0) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "prior_linked_pr_closed_unmerged");
  assert.equal(result.attempts, 1);
});



test("watch-initial-copilot-pr returns ready_for_followup via CLI when PR is immediately substantive", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-initial-pr-ready-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "-F", "issue=59", "owner=owner", "name=repo"],
        stdout: linkedPrPayload(),
      },
      {
        assertArgs: ["api", "graphql", "-F", "pr=79", "owner=owner", "name=repo"],
        stdout: pullRequestFactsPayload({ changedFiles: 3, commitCount: 2, messageHeadline: "Add feature" }),
      },
      {
        assertArgs: ["run", "list", "--repo", "owner/repo", "--branch", "copilot/example-branch"],
        stdout: `${JSON.stringify([
          {
            databaseId: 12,
            name: "Copilot coding for issue owner/repo#59",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-05-21T09:49:32Z",
          },
        ])}\n`,
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--issue", "59"],
      { env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready_for_followup");
    assert.equal(payload.prNumber, 79);
    assert.equal(payload.issue, 59);
    assert.equal(payload.repo, "owner/repo");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("watch-initial-copilot-pr returns timed_out for bootstrap-only PR", async () => {
  const detect = makeDetectMock([
    { ok: true, state: "waiting_for_initial_copilot_implementation", prNumber: 79, prUrl: "https://github.com/owner/repo/pull/79" },
  ]);
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 0 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.prNumber, 79);
});
test("watch-initial-copilot-pr returns timed_out for no_linked_pr", async () => {
  const detect = makeDetectMock([
    { ok: true, state: "no_linked_pr", prNumber: null, prUrl: null },
  ]);
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 0 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "timed_out");
  assert.equal(result.prNumber, null);
});
test("watch-initial-copilot-pr returns prior_linked_pr_closed_unmerged", async () => {
  const detect = makeDetectMock([
    { ok: true, state: "prior_linked_pr_closed_unmerged", prNumber: 101, prUrl: "https://github.com/owner/repo/pull/101" },
  ]);
  const result = await watchInitialCopilotPr(
    { repo: "owner/repo", issue: 59, pollIntervalMs: 60_000, timeoutMs: 0 },
    { detectInitialCopilotPrStateImpl: detect, delayImpl: async () => {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "prior_linked_pr_closed_unmerged");
  assert.equal(result.prNumber, 101);
});
