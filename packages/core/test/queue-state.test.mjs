import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  QUEUE_VERSION,
  ENTRY_STATUS,
  VALID_TRANSITIONS,
  RECOVERABLE_FAILURES,
  readQueue,
  writeQueue,
  createEntry,
  findEntry,
  findEntryIndex,
  isValidTransition,
  transitionEntry,
  entryDependenciesSatisfied,
  topologicalOrder,
  nextReadyEntry,
  allDone,
  pendingEntries,
  appendBugIssue,
  queueFilePath,
  reconcileEntriesFromBoard,
} from "../src/loop/queue-state.mjs";

// ── Constants ───────────────────────────────────────────────────────

test("QUEUE_VERSION is 1", () => {
  assert.equal(QUEUE_VERSION, 1);
});

test("ENTRY_STATUS has all expected states", () => {
  const expected = [
    "queued", "running", "waiting_review", "gates_passing",
    "merging", "done", "blocked", "failed",
  ];
  assert.deepEqual([...ENTRY_STATUS].sort(), [...expected].sort());
});

test("RECOVERABLE_FAILURES are acceptance_report_parse_failure, round_cap_reached, timeout", () => {
  assert.equal(RECOVERABLE_FAILURES.has("acceptance_report_parse_failure"), true);
  assert.equal(RECOVERABLE_FAILURES.has("round_cap_reached"), true);
  assert.equal(RECOVERABLE_FAILURES.has("timeout"), true);
  assert.equal(RECOVERABLE_FAILURES.has("blocked_needs_user_decision"), false);
  assert.equal(RECOVERABLE_FAILURES.has("ci_failure"), false);
});

// ── queueFilePath ───────────────────────────────────────────────────

test("queueFilePath returns .pi/dev-loop-queue.json under repoRoot", () => {
  const fp = queueFilePath("/tmp/test-repo");
  assert.equal(fp, path.join("/tmp/test-repo", ".pi", "dev-loop-queue.json"));
});

// ── readQueue / writeQueue ──────────────────────────────────────────

test("readQueue returns empty queue when file does not exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-state-"));
  try {
    const queue = await readQueue(dir);
    assert.deepEqual(queue, { version: 1, entries: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeQueue + readQueue round-trips", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-state-"));
  try {
    const queue = {
      version: 1,
      entries: [createEntry(556, "issue")],
    };
    await writeQueue(dir, queue);
    const read = await readQueue(dir);
    assert.equal(read.version, 1);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].target, 556);
    assert.equal(read.entries[0].kind, "issue");
    assert.equal(read.entries[0].status, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── createEntry ─────────────────────────────────────────────────────

test("createEntry creates a queued entry with defaults", () => {
  const entry = createEntry(556, "issue");
  assert.deepEqual(entry, {
    target: 556,
    kind: "issue",
    status: "queued",
    dependsOn: [],
    pr: null,
    runId: null,
    retrospectiveWritten: false,
    failureReason: null,
    failureKind: null,
    retryCount: 0,
  });
});

test("createEntry with dependsOn", () => {
  const entry = createEntry(556, "issue", [42, 99]);
  assert.deepEqual(entry.dependsOn, [42, 99]);
});

test("createEntry for PR kind", () => {
  const entry = createEntry(88, "pr");
  assert.equal(entry.kind, "pr");
});

// ── findEntry / findEntryIndex ──────────────────────────────────────

test("findEntry returns matching entry", () => {
  const queue = {
    version: 1,
    entries: [createEntry(1, "issue"), createEntry(2, "issue")],
  };
  const found = findEntry(queue, 2);
  assert.equal(found.target, 2);
});

test("findEntry returns undefined when not found", () => {
  const queue = { version: 1, entries: [] };
  assert.equal(findEntry(queue, 99), undefined);
});

test("findEntryIndex returns correct index", () => {
  const queue = {
    version: 1,
    entries: [createEntry(1, "issue"), createEntry(2, "issue")],
  };
  assert.equal(findEntryIndex(queue, 1), 0);
  assert.equal(findEntryIndex(queue, 2), 1);
  assert.equal(findEntryIndex(queue, 99), -1);
});

// ── isValidTransition ───────────────────────────────────────────────

test("isValidTransition valid transitions", () => {
  assert.equal(isValidTransition("queued", "running"), true);
  assert.equal(isValidTransition("running", "waiting_review"), true);
  assert.equal(isValidTransition("waiting_review", "gates_passing"), true);
  assert.equal(isValidTransition("gates_passing", "merging"), true);
  assert.equal(isValidTransition("merging", "done"), true);
});

test("isValidTransition invalid transitions", () => {
  assert.equal(isValidTransition("queued", "done"), false);
  assert.equal(isValidTransition("done", "queued"), false);
  assert.equal(isValidTransition("done", "running"), false);
  assert.equal(isValidTransition("queued", "merging"), false);
});

test("isValidTransition unknown states", () => {
  assert.equal(isValidTransition("unknown", "queued"), false);
  assert.equal(isValidTransition("queued", "unknown"), false);
});

test("isValidTransition blocked → queued (resume)", () => {
  assert.equal(isValidTransition("blocked", "queued"), true);
});

test("isValidTransition failed → queued (retry)", () => {
  assert.equal(isValidTransition("failed", "queued"), true);
});

// ── transitionEntry ─────────────────────────────────────────────────

test("transitionEntry updates status", () => {
  const entry = createEntry(556, "issue");
  transitionEntry(entry, "running");
  assert.equal(entry.status, "running");
});

test("transitionEntry throws on invalid transition", () => {
  const entry = createEntry(556, "issue");
  assert.throws(() => transitionEntry(entry, "done"), /Invalid transition/);
});

test("transitionEntry sets metadata", () => {
  const entry = createEntry(556, "issue");
  transitionEntry(entry, "running", { pr: 88, runId: "run-1" });
  assert.equal(entry.pr, 88);
  assert.equal(entry.runId, "run-1");
});

// ── entryDependenciesSatisfied ──────────────────────────────────────

test("entryDependenciesSatisfied true when no deps", () => {
  const entry = createEntry(556, "issue");
  const queue = { version: 1, entries: [entry] };
  assert.equal(entryDependenciesSatisfied(queue, entry), true);
});

test("entryDependenciesSatisfied true when deps are done", () => {
  const dep = createEntry(42, "issue");
  dep.status = "done";
  const entry = createEntry(556, "issue", [42]);
  const queue = { version: 1, entries: [dep, entry] };
  assert.equal(entryDependenciesSatisfied(queue, entry), true);
});

test("entryDependenciesSatisfied false when dep not done", () => {
  const dep = createEntry(42, "issue");
  const entry = createEntry(556, "issue", [42]);
  const queue = { version: 1, entries: [dep, entry] };
  assert.equal(entryDependenciesSatisfied(queue, entry), false);
});

test("entryDependenciesSatisfied false when dep missing", () => {
  const entry = createEntry(556, "issue", [999]);
  const queue = { version: 1, entries: [entry] };
  assert.equal(entryDependenciesSatisfied(queue, entry), false);
});

// ── topologicalOrder ────────────────────────────────────────────────

test("topologicalOrder simple order", () => {
  const entries = [
    createEntry(1, "issue"),
    createEntry(2, "issue"),
    createEntry(3, "issue"),
  ];
  const ordered = topologicalOrder(entries);
  assert.deepEqual(ordered.map((e) => e.target), [1, 2, 3]);
});

test("topologicalOrder respects dependencies", () => {
  const entries = [
    createEntry(3, "issue", [2]),
    createEntry(2, "issue", [1]),
    createEntry(1, "issue"),
  ];
  const ordered = topologicalOrder(entries);
  // 1 must come before 2, 2 before 3
  const idx = (t) => ordered.findIndex((e) => e.target === t);
  assert.ok(idx(1) < idx(2), "1 before 2");
  assert.ok(idx(2) < idx(3), "2 before 3");
});

test("topologicalOrder throws on circular dependency", () => {
  const entries = [
    { target: 1, dependsOn: [2], kind: "issue" },
    { target: 2, dependsOn: [1], kind: "issue" },
  ];
  assert.throws(() => topologicalOrder(entries), /Circular dependency/);
});

// ── nextReadyEntry ──────────────────────────────────────────────────

test("nextReadyEntry returns first queued entry with satisfied deps", () => {
  const queue = {
    version: 1,
    entries: [
      createEntry(1, "issue"),
      createEntry(2, "issue"),
    ],
  };
  const next = nextReadyEntry(queue);
  assert.equal(next.target, 1);
});

test("nextReadyEntry skips blocked entries", () => {
  const e1 = createEntry(1, "issue");
  e1.status = "blocked";
  const e2 = createEntry(2, "issue");
  const queue = { version: 1, entries: [e1, e2] };
  const next = nextReadyEntry(queue);
  assert.equal(next.target, 2);
});

test("nextReadyEntry returns null when all done", () => {
  const e = createEntry(1, "issue");
  e.status = "done";
  const queue = { version: 1, entries: [e] };
  assert.equal(nextReadyEntry(queue), null);
});

test("nextReadyEntry returns recoverable failed entry for retry", () => {
  const entry = createEntry(1, "issue");
  entry.status = "failed";
  entry.failureKind = "acceptance_report_parse_failure";
  entry.retryCount = 0;
  const queue = { version: 1, entries: [entry] };
  const next = nextReadyEntry(queue, 3);
  assert.equal(next.target, 1);
});

test("nextReadyEntry skips non-recoverable failed entry", () => {
  const entry = createEntry(1, "issue");
  entry.status = "failed";
  entry.failureKind = "ci_failure";
  const queue = { version: 1, entries: [entry] };
  assert.equal(nextReadyEntry(queue), null);
});

test("nextReadyEntry skips when max retries exceeded", () => {
  const entry = createEntry(1, "issue");
  entry.status = "failed";
  entry.failureKind = "timeout";
  entry.retryCount = 1;
  const queue = { version: 1, entries: [entry] };
  assert.equal(nextReadyEntry(queue, 1), null);
});

// ── allDone / pendingEntries ────────────────────────────────────────

test("allDone true when all done or blocked", () => {
  const e1 = createEntry(1, "issue"); e1.status = "done";
  const e2 = createEntry(2, "issue"); e2.status = "blocked";
  const queue = { version: 1, entries: [e1, e2] };
  assert.equal(allDone(queue), true);
});

test("allDone false when any running", () => {
  const e1 = createEntry(1, "issue"); e1.status = "done";
  const e2 = createEntry(2, "issue"); e2.status = "running";
  const queue = { version: 1, entries: [e1, e2] };
  assert.equal(allDone(queue), false);
});

test("pendingEntries returns non-done, non-blocked entries", () => {
  const e1 = createEntry(1, "issue"); e1.status = "done";
  const e2 = createEntry(2, "issue"); e2.status = "running";
  const e3 = createEntry(3, "issue"); e3.status = "queued";
  const queue = { version: 1, entries: [e1, e2, e3] };
  const pending = pendingEntries(queue);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((e) => e.target), [2, 3]);
});

// ── appendBugIssue ──────────────────────────────────────────────────

test("appendBugIssue adds entry to end of queue", () => {
  const queue = { version: 1, entries: [createEntry(1, "issue")] };
  const entry = appendBugIssue(queue, 999);
  assert.equal(queue.entries.length, 2);
  assert.equal(queue.entries[1].target, 999);
  assert.equal(entry.status, "queued");
});

test("appendBugIssue with dependency", () => {
  const queue = { version: 1, entries: [createEntry(1, "issue")] };
  appendBugIssue(queue, 999, 1);
  assert.deepEqual(queue.entries[1].dependsOn, [1]);
});

// ── reconcileEntriesFromBoard ───────────────────────────────────────

test("reconcileEntriesFromBoard adds missing board targets as queued board entries", () => {
  const queue = { version: 1, entries: [] };
  const { queue: out, added } = reconcileEntriesFromBoard(queue, [10, 20, 30]);
  assert.equal(out, queue, "mutates/returns the same queue object");
  assert.deepEqual(added, [10, 20, 30]);
  assert.deepEqual(out.entries.map((e) => e.target), [10, 20, 30]);
  // Board Next Up can hold issues OR PRs and resolveNextUpOrder discards the
  // kind, so board-sourced entries use a neutral "board" kind rather than
  // falsely asserting "issue". The driver resolves the artifact by number.
  assert.ok(out.entries.every((e) => e.kind === "board"));
  assert.ok(out.entries.every((e) => e.status === "queued"));
});

test("reconcileEntriesFromBoard preserves existing entries and their status/order", () => {
  const done = createEntry(10, "issue"); done.status = "done";
  const running = createEntry(20, "issue"); running.status = "running";
  const queue = { version: 1, entries: [done, running] };
  // Board reports 20 (already present) and 30 (new).
  const { added } = reconcileEntriesFromBoard(queue, [20, 30]);
  assert.deepEqual(added, [30]);
  // Existing entries untouched and in original order; new one appended last.
  assert.deepEqual(queue.entries.map((e) => e.target), [10, 20, 30]);
  assert.equal(queue.entries[0].status, "done");
  assert.equal(queue.entries[1].status, "running");
  assert.equal(queue.entries[2].status, "queued");
});

test("reconcileEntriesFromBoard dedups targets already present", () => {
  const queue = { version: 1, entries: [createEntry(10, "issue")] };
  const { added } = reconcileEntriesFromBoard(queue, [10]);
  assert.deepEqual(added, []);
  assert.equal(queue.entries.length, 1);
});

test("reconcileEntriesFromBoard dedups repeated targets within the board list", () => {
  const queue = { version: 1, entries: [] };
  const { added } = reconcileEntriesFromBoard(queue, [10, 10, 11]);
  assert.deepEqual(added, [10, 11]);
  assert.deepEqual(queue.entries.map((e) => e.target), [10, 11]);
});

test("reconcileEntriesFromBoard is a no-op on empty board input", () => {
  const queue = { version: 1, entries: [createEntry(1, "issue")] };
  assert.deepEqual(reconcileEntriesFromBoard(queue, []).added, []);
  assert.deepEqual(reconcileEntriesFromBoard(queue, null).added, []);
  assert.deepEqual(reconcileEntriesFromBoard(queue, undefined).added, []);
  assert.equal(queue.entries.length, 1);
});

test("reconcileEntriesFromBoard ignores non-number targets", () => {
  const queue = { version: 1, entries: [] };
  const { added } = reconcileEntriesFromBoard(queue, [10, "PVTI_abc", null, 11]);
  assert.deepEqual(added, [10, 11]);
});

test("reconcileEntriesFromBoard filters NaN, Infinity, non-integer, negative, and 0 targets", () => {
  const queue = { version: 1, entries: [] };
  const { added } = reconcileEntriesFromBoard(queue, [
    10,
    NaN,
    Infinity,
    -Infinity,
    3.5,
    -7,
    0,
    11,
  ]);
  // Only positive integers survive the numeric guard.
  assert.deepEqual(added, [10, 11]);
  assert.deepEqual(queue.entries.map((e) => e.target), [10, 11]);
});

test("reconcileEntriesFromBoard never creates a NaN entry and does not accumulate across repeated reconciles", () => {
  // NaN never dedups via findEntry (NaN !== NaN), so without the integer guard
  // each reconcile would append a fresh NaN entry. Verify it is filtered and
  // repeated reconciles stay a no-op.
  const queue = { version: 1, entries: [] };
  for (let i = 0; i < 3; i++) {
    const { added } = reconcileEntriesFromBoard(queue, [NaN]);
    assert.deepEqual(added, []);
  }
  assert.equal(queue.entries.length, 0);
  assert.ok(!queue.entries.some((e) => Number.isNaN(e.target)));
});

test("reconcileEntriesFromBoard tolerates a malformed queue", () => {
  assert.deepEqual(reconcileEntriesFromBoard(null, [1]).added, []);
  assert.deepEqual(reconcileEntriesFromBoard({}, [1]).added, []);
});
