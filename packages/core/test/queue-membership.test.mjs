import assert from "node:assert/strict";
import test from "node:test";

import { reconcileBoardMembership } from "../src/loop/queue-membership.mjs";
import { createEntry } from "../src/loop/queue-state.mjs";

function makeQueue(entries = []) {
  return { version: 1, entries };
}

function captureLog() {
  const lines = [];
  return { log: (msg) => lines.push(msg), lines };
}

test("configured board + empty local queue reconciles Next Up into entries (no silent 'Queue is empty')", async () => {
  const queue = makeQueue([]);
  let written = null;
  const { log, lines } = captureLog();

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true, projectNumber: 7 }),
    resolveNextUpOrder: async (repo, repoRoot) => {
      assert.equal(repo, "owner/name");
      assert.equal(repoRoot, "/repo");
      return { ok: true, order: [10, 20], reason: null };
    },
    writeQueue: async (_root, q) => { written = q; },
    log,
  });

  assert.equal(result.boardConfigured, true);
  assert.deepEqual(result.added, [10, 20]);
  // Not empty: the caller should run the queue (emptiness is null).
  assert.equal(result.emptiness, null);
  assert.deepEqual(queue.entries.map((e) => e.target), [10, 20]);
  // Reconciled membership is persisted.
  assert.equal(written, queue);
  assert.ok(lines.some((l) => l.includes("added 2 entries from board Next Up")));
});

test("configured board + existing local entries: board adds only missing members, preserves existing", async () => {
  const existing = createEntry(10, "issue");
  existing.status = "running";
  const queue = makeQueue([existing]);

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    resolveNextUpOrder: async () => ({ ok: true, order: [10, 30], reason: null }),
    writeQueue: async () => {},
  });

  assert.deepEqual(result.added, [30]);
  assert.equal(result.emptiness, null);
  assert.deepEqual(queue.entries.map((e) => e.target), [10, 30]);
  assert.equal(queue.entries[0].status, "running");
});

test("configured board with empty Next Up reports 'board_empty', not 'queue_empty'", async () => {
  const queue = makeQueue([]);
  let written = null;

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    resolveNextUpOrder: async () => ({ ok: true, order: [], reason: "Next Up empty" }),
    writeQueue: async (_root, q) => { written = q; },
  });

  assert.equal(result.boardConfigured, true);
  assert.deepEqual(result.added, []);
  assert.equal(result.emptiness, "board_empty");
  assert.equal(result.reason, "Next Up empty");
  // Nothing added → no write.
  assert.equal(written, null);
});

test("unconfigured board + empty local queue reports 'queue_empty' (legacy behavior)", async () => {
  const queue = makeQueue([]);
  let resolveCalled = false;

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: false }),
    resolveNextUpOrder: async () => { resolveCalled = true; return { ok: true, order: [99] }; },
    writeQueue: async () => {},
  });

  assert.equal(result.boardConfigured, false);
  assert.deepEqual(result.added, []);
  assert.equal(result.emptiness, "queue_empty");
  // Board not configured: Next Up is never consulted.
  assert.equal(resolveCalled, false);
});

test("unconfigured board + non-empty local queue runs (emptiness null), no board read", async () => {
  const queue = makeQueue([createEntry(5, "issue")]);

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: false }),
    resolveNextUpOrder: async () => { throw new Error("should not be called"); },
    writeQueue: async () => {},
  });

  assert.equal(result.boardConfigured, false);
  assert.equal(result.emptiness, null);
});

test("board resolution error fails open to local queue (no crash)", async () => {
  const queue = makeQueue([createEntry(5, "issue")]);
  const { log, lines } = captureLog();

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    resolveNextUpOrder: async () => { throw new Error("GraphQL boom"); },
    writeQueue: async () => {},
    log,
  });

  // Falls back to the local queue: existing pending entry means run it.
  assert.deepEqual(result.added, []);
  assert.equal(result.emptiness, null);
  assert.equal(result.reason, "GraphQL boom");
  assert.ok(lines.some((l) => l.includes("Next Up resolution failed")));
});

test("board config read error fails open to unconfigured (no crash)", async () => {
  const queue = makeQueue([]);
  const { log } = captureLog();

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => { throw new Error("bad .devloops"); },
    resolveNextUpOrder: async () => ({ ok: true, order: [1] }),
    writeQueue: async () => {},
    log,
  });

  assert.equal(result.boardConfigured, false);
  assert.equal(result.emptiness, "queue_empty");
});

test("persist failure does not crash; entries still drive the in-memory run", async () => {
  const queue = makeQueue([]);

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    resolveNextUpOrder: async () => ({ ok: true, order: [10] }),
    writeQueue: async () => { throw new Error("disk full"); },
    log: () => {},
  });

  assert.deepEqual(result.added, [10]);
  assert.equal(result.emptiness, null);
  assert.deepEqual(queue.entries.map((e) => e.target), [10]);
});
