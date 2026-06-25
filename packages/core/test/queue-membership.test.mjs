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

test("configured board with genuinely empty Next Up (reason null) reports 'board_empty', not 'queue_empty'", async () => {
  const queue = makeQueue([]);
  let written = null;

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    // Clean resolution that returns no items: reason is null, so this is a
    // genuinely empty Next Up rather than a resolution failure.
    resolveNextUpOrder: async () => ({ ok: true, order: [], reason: null }),
    writeQueue: async (_root, q) => { written = q; },
  });

  assert.equal(result.boardConfigured, true);
  assert.deepEqual(result.added, []);
  assert.equal(result.emptiness, "board_empty");
  assert.equal(result.reason, null);
  // Nothing added → no write.
  assert.equal(written, null);
});

test("configured board + empty order WITH a reason (fail-open resolution failure) is NOT board_empty", async () => {
  const queue = makeQueue([]);
  let written = null;
  const { log, lines } = captureLog();

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    // resolveNextUpOrder is fail-open: an API error yields ok:true, an empty
    // order, AND a non-null reason. This must NOT be mistaken for an empty board.
    resolveNextUpOrder: async () => ({ ok: true, order: [], reason: "GraphQL 502 Bad Gateway" }),
    writeQueue: async (_root, q) => { written = q; },
    log,
  });

  assert.equal(result.boardConfigured, true);
  assert.deepEqual(result.added, []);
  // Critical: a resolution failure must not be reported as board_empty.
  assert.notEqual(result.emptiness, "board_empty");
  assert.equal(result.emptiness, "board_unavailable");
  assert.equal(result.reason, "GraphQL 502 Bad Gateway");
  assert.equal(written, null);
  // The real reason is logged so the failure is not silently swallowed.
  assert.ok(lines.some((l) => l.includes("Next Up resolution failed") && l.includes("GraphQL 502 Bad Gateway")));
});

test("configured board + empty order WITH a reason but non-empty local queue falls through to running (emptiness null)", async () => {
  const queue = makeQueue([createEntry(5, "issue")]);

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: true }),
    resolveNextUpOrder: async () => ({ ok: true, order: [], reason: "board lookup failed" }),
    writeQueue: async () => {},
    log: () => {},
  });

  assert.equal(result.boardConfigured, true);
  assert.deepEqual(result.added, []);
  // Local queue has pending work: fail-open runs it rather than reporting empty.
  assert.equal(result.emptiness, null);
  assert.equal(result.reason, "board lookup failed");
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

test("loadBoardConfig read/parse failure reason (enabled:false + reason) is logged", async () => {
  // loadBoardConfig does not throw on a read/parse error; it returns
  // { enabled:false, reason }. That reason must be surfaced via the log seam so
  // a real config failure is visible rather than silently swallowed.
  const queue = makeQueue([]);
  const { log, lines } = captureLog();

  const result = await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: false, reason: "config read/parse error: bad yaml" }),
    resolveNextUpOrder: async () => { throw new Error("should not be called"); },
    writeQueue: async () => {},
    log,
  });

  assert.equal(result.boardConfigured, false);
  assert.equal(result.emptiness, "queue_empty");
  assert.ok(
    lines.some((l) => l.includes("config read/parse error: bad yaml")),
    "the config failure reason should be logged",
  );
});

test("ordinary 'board not configured' (enabled:false, no reason) is not logged", async () => {
  const queue = makeQueue([]);
  const { log, lines } = captureLog();

  await reconcileBoardMembership("/repo", "owner/name", queue, {
    loadBoardConfig: () => ({ enabled: false }),
    resolveNextUpOrder: async () => { throw new Error("should not be called"); },
    writeQueue: async () => {},
    log,
  });

  // No reason => no config-unavailable log line (quiet legacy path).
  assert.ok(!lines.some((l) => l.includes("board config unavailable")));
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
