import test from "node:test";
import assert from "node:assert/strict";

import { runWatchCycle } from "../../scripts/loop/run-watch-cycle.mjs";

// The CI and Copilot waits are heartbeated inside their shared engines
// (probe-ci-status / probe-copilot-review), so run-watch-cycle no longer wraps
// them. The `gh run watch` workflow-run watch blocks as a single child with no
// poll loop / no shared engine, so it is still wrapped here with the
// interval-heartbeat lease holder. These cases guard that remaining wrap.

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

const idleCopilotWatch = (options) => ({
  ok: true,
  status: "idle",
  repo: options.repo,
  pr: options.pr,
  attempts: 1,
  newComments: [],
  newReviews: [],
  newIssueComments: [],
});

// Deps that drive session-activity detection to an active run so the
// workflow-run watch (the wrapped call) is exercised.
function sessionActiveDeps(overrides = {}) {
  return {
    detectSessionActivity: true,
    runHandoffImpl: async () => copilotWatchHandoff(),
    fetchPrHeadBranchImpl: async () => "feature-branch",
    detectCopilotSessionActivityImpl: async () => ({ activity: "active", runId: 4242 }),
    watchCopilotReviewImpl: async (options) => idleCopilotWatch(options),
    ...overrides,
  };
}

test("runWatchCycle heartbeats the runner-coordination lease around the workflow-run watch", async () => {
  let ownershipCalls = 0;

  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    sessionActiveDeps({
      watchWorkflowRunImpl: async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed" }), 0);
        }),
      ensureOwnershipImpl: async () => {
        ownershipCalls += 1;
        return { ok: true, status: "owner_confirmed" };
      },
    }),
  );

  // On-entry and on-return heartbeats both fired around the blocking workflow watch.
  assert.ok(ownershipCalls >= 2, `expected >= 2 heartbeats, got ${ownershipCalls}`);
  assert.equal(result.ok, true);
  assert.equal(result.watchStatus, "idle");
});

test(
  "runWatchCycle fires the periodic mid-watch heartbeat while the workflow-run watch is in-flight",
  { timeout: 5000 },
  async (t) => {
    // Deterministic clock: the mid-watch interval is the load-bearing mechanism
    // that keeps the claim fresh during a full-length (~30 min) watch. Mock
    // timers let us advance past the interval without any real waiting.
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

    // Shrink the stale window so the interval is floor(20/2) = 10ms.
    const env = { ...process.env, DEVLOOPS_STALE_RUNNER_MAX_AGE_MS: "20" };

    let ownershipCalls = 0;
    let resolveWatch;
    const watchPending = new Promise((resolve) => {
      resolveWatch = resolve;
    });

    // setImmediate is NOT mocked, so this yields a real macrotask boundary that
    // drains all pending microtasks between ticks.
    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    // Kick off the cycle WITHOUT awaiting: the workflow watch stays in-flight so
    // we can advance the clock while runWatchHoldingLease is blocked on it.
    const cyclePromise = runWatchCycle(
      { repo: "owner/repo", pr: 17 },
      sessionActiveDeps({
        env,
        watchWorkflowRunImpl: async () => watchPending,
        ensureOwnershipImpl: async () => {
          ownershipCalls += 1;
          return { ok: true, status: "owner_confirmed" };
        },
      }),
    );

    // Let the async chain (handoff + head branch + session detection) run and
    // register setInterval + the on-entry heartbeat.
    await flushMicrotasks();
    await flushMicrotasks();
    const afterEntry = ownershipCalls;
    assert.equal(afterEntry, 1, `expected exactly the on-entry heartbeat, got ${afterEntry}`);

    // Advance well past several 10ms intervals. The workflow watch is still
    // pending, so the on-return heartbeat has NOT fired yet: every call beyond
    // the on-entry one is interval-driven.
    t.mock.timers.tick(50);
    await flushMicrotasks();
    t.mock.timers.tick(50);
    await flushMicrotasks();

    const duringWatch = ownershipCalls;
    const periodicCalls = duringWatch - afterEntry;
    // Fails if the setInterval heartbeat is removed.
    assert.ok(
      periodicCalls >= 1,
      `expected >= 1 periodic interval heartbeat, got ${periodicCalls}`,
    );
    assert.ok(
      duringWatch >= 3,
      `expected >= 3 heartbeats during the in-flight watch, got ${duringWatch}`,
    );

    // Now let the workflow watch complete and the cycle finish cleanly.
    resolveWatch({ status: "completed" });
    const result = await cyclePromise;

    assert.equal(result.ok, true);
    assert.equal(result.watchStatus, "idle");
  },
);

test("runWatchCycle treats a workflow-watch heartbeat failure as non-fatal", async () => {
  const result = await runWatchCycle(
    { repo: "owner/repo", pr: 17 },
    sessionActiveDeps({
      watchWorkflowRunImpl: async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: "completed" }), 0);
        }),
      ensureOwnershipImpl: async () => {
        throw new Error("heartbeat boom");
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.watchStatus, "idle");
});
