import test from "node:test";
import assert from "node:assert/strict";

import { runWatchCycle } from "../../scripts/loop/run-watch-cycle.mjs";

function copilotWatchHandoff() {
  return {
    ok: true,
    action: "watch",
    state: "waiting_for_copilot_review",
    allowedTransitions: [],
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
  };
}

test("runWatchCycle heartbeats the runner-coordination lease around a Copilot watch", async () => {
  let ownershipCalls = 0;

  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    {
      runHandoffImpl: async () => copilotWatchHandoff(),
      watchCopilotReviewImpl: async (options) =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: "idle",
              repo: options.repo,
              pr: options.pr,
              attempts: 1,
              newComments: [],
              newReviews: [],
              newIssueComments: [],
            });
          }, 0);
        }),
      ensureOwnershipImpl: async () => {
        ownershipCalls += 1;
        return { ok: true, status: "owner_confirmed" };
      },
    },
  );

  // On-entry and on-return heartbeats both fired around the blocking watch.
  assert.ok(ownershipCalls >= 2, `expected >= 2 heartbeats, got ${ownershipCalls}`);
  assert.equal(result.ok, true);
  assert.equal(result.watchStatus, "idle");
});

test("runWatchCycle treats a heartbeat failure as non-fatal", async () => {
  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    {
      runHandoffImpl: async () => copilotWatchHandoff(),
      watchCopilotReviewImpl: async (options) =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: "idle",
              repo: options.repo,
              pr: options.pr,
              attempts: 1,
              newComments: [],
              newReviews: [],
              newIssueComments: [],
            });
          }, 0);
        }),
      ensureOwnershipImpl: async () => {
        throw new Error("heartbeat boom");
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.watchStatus, "idle");
});
