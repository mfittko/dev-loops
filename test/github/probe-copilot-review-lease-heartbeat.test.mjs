import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

import { watchCopilotReview } from "../../scripts/github/probe-copilot-review.mjs";

function emptyActivityPayload() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [] },
          reviews: { nodes: [] },
          comments: { nodes: [] },
        },
      },
    },
  };
}

async function withGhStub(fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-copilot-lease-hb-"));
  try {
    // Every poll returns the same empty activity, so the watch runs its full
    // budget and times out -> the inter-poll heartbeat loop runs on each poll.
    const { env } = await writeGhStubHelper(tempDir, [{ stdout: JSON.stringify(emptyActivityPayload()) + "\n" }], {
      repeatLastOnOverflow: true,
      defaultStdout: "null\n",
    });
    return await fn(env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// No real sleeping: a no-op delay that advances the injected clock by less than
// a heartbeat chunk, so the inter-poll loop always leaves remainingMs > 0 for at
// least one iteration and the co-located lease heartbeat fires.
function advancingClockDeps(env, extra = {}) {
  let nowMs = 1_000;
  return {
    env,
    ghCommand: "gh",
    delayImpl: async (ms) => { nowMs += Math.min(ms, 1_000); },
    now: () => nowMs,
    ...extra,
  };
}

test("watchCopilotReview heartbeats the runner-coordination lease during the inter-poll wait", async () => {
  await withGhStub(async (env) => {
    let ownershipCalls = 0;
    const result = await watchCopilotReview(
      { repo: "owner/repo", pr: 17, pollIntervalMs: 60_000, timeoutMs: 120_000 },
      advancingClockDeps(env, {
        ensureOwnershipImpl: async () => {
          ownershipCalls += 1;
          return { ok: true, status: "owner_confirmed" };
        },
      }),
    );
    assert.equal(result.status, "timeout");
    // Fails if the engine-level lease heartbeat is removed.
    assert.ok(ownershipCalls >= 1, `expected >= 1 lease heartbeat during the wait, got ${ownershipCalls}`);
  });
});

test("watchCopilotReview treats a rejecting lease heartbeat as non-fatal", async () => {
  await withGhStub(async (env) => {
    const result = await watchCopilotReview(
      { repo: "owner/repo", pr: 17, pollIntervalMs: 60_000, timeoutMs: 120_000 },
      advancingClockDeps(env, {
        ensureOwnershipImpl: async () => { throw new Error("lease boom"); },
      }),
    );
    // The watch still returns its normal terminal result despite the failure.
    assert.equal(result.status, "timeout");
  });
});
