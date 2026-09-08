import assert from "node:assert/strict";
import { test } from "bun:test";
import { waitWithHeartbeat, WATCH_HEARTBEAT_MS } from "../../scripts/github/_watch-heartbeat.mjs";

// Capture stderr watch_heartbeat lines emitted by the shared helper without
// real sleeping: delayImpl is a no-op that advances the injected clock.
async function runWait(pollDelayMs, { onHeartbeat, timeoutMs = 600_000 } = {}) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const heartbeats = [];
  const chunks = [];
  process.stderr.write = (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "watch_heartbeat") heartbeats.push(parsed);
    } catch {
      // non-JSON stderr: ignore
    }
    return true;
  };
  let nowMs = 1_000;
  try {
    await waitWithHeartbeat(pollDelayMs, {
      attempt: 3,
      attemptBudget: 9,
      watchStartedAtMs: 0,
      timeoutMs,
      now: () => nowMs,
      delayImpl: async (ms) => {
        chunks.push(ms);
        nowMs += ms;
      },
      onHeartbeat,
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  return { heartbeats, chunks };
}

test("waits in WATCH_HEARTBEAT_MS chunks and heartbeats between them (no trailing heartbeat)", async () => {
  // 100s budget -> chunks 45s, 45s, 10s; heartbeat only between chunks (after 1
  // and 2), never after the final chunk.
  const { heartbeats, chunks } = await runWait(100_000, { timeoutMs: 100_000 });
  assert.deepEqual(chunks, [WATCH_HEARTBEAT_MS, WATCH_HEARTBEAT_MS, 10_000]);
  assert.equal(heartbeats.length, 2);
  assert.deepEqual(heartbeats.map((h) => h.poll), [3, 3]);
  assert.deepEqual(heartbeats.map((h) => h.maxPolls), [9, 9]);
  assert.equal(heartbeats[0].totalBudgetMs, 100_000);
});

test("a single exact chunk emits no heartbeat (no trailing heartbeat)", async () => {
  const { heartbeats, chunks } = await runWait(WATCH_HEARTBEAT_MS);
  assert.deepEqual(chunks, [WATCH_HEARTBEAT_MS]);
  assert.equal(heartbeats.length, 0);
});

test("a rejecting onHeartbeat is swallowed and never aborts the wait", async () => {
  let calls = 0;
  const { heartbeats } = await runWait(100_000, {
    timeoutMs: 100_000,
    onHeartbeat: async () => {
      calls += 1;
      throw new Error("lease boom");
    },
  });
  // The wait completed (both heartbeats fired) despite every refresh throwing.
  assert.equal(heartbeats.length, 2);
  assert.equal(calls, 2);
});
