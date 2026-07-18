import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyFailure,
  isRecoverable,
  runQueue,
  DEFAULT_QUEUE_DRIVER_OPTIONS,
} from "../src/loop/queue-driver.mjs";
import { writeQueue, createEntry } from "../src/loop/queue-state.mjs";

// ── classifyFailure ─────────────────────────────────────────────────

test("classifyFailure — acceptance_report_parse_failure", () => {
  assert.equal(classifyFailure(new Error("JSON parse error")), "acceptance_report_parse_failure");
  assert.equal(classifyFailure("acceptance report malformed"), "acceptance_report_parse_failure");
  assert.equal(classifyFailure("unexpected token in report"), "acceptance_report_parse_failure");
});

test("classifyFailure — round_cap_reached", () => {
  assert.equal(classifyFailure("round cap reached after 5 rounds"), "round_cap_reached");
  assert.equal(classifyFailure("max review limit exceeded"), "round_cap_reached");
});

test("classifyFailure — timeout", () => {
  assert.equal(classifyFailure("timeout waiting for review"), "timeout");
  assert.equal(classifyFailure(new Error("watch expired")), "timeout");
  assert.equal(classifyFailure("timed out after 30 minutes"), "timeout");
});

test("classifyFailure — blocked_needs_user_decision", () => {
  assert.equal(classifyFailure("blocked by human comment"), "blocked_needs_user_decision");
  assert.equal(classifyFailure("needs user decision"), "blocked_needs_user_decision");
});

test("classifyFailure — ci_failure", () => {
  assert.equal(classifyFailure("CI failure on main"), "ci_failure");
  assert.equal(classifyFailure("build failed"), "ci_failure");
  assert.equal(classifyFailure("test failure in gate"), "ci_failure");
});

test("classifyFailure — unknown", () => {
  assert.equal(classifyFailure("something weird happened"), "unknown");
  assert.equal(classifyFailure(null), "unknown");
});

// ── isRecoverable ───────────────────────────────────────────────────

test("isRecoverable — recoverable failures", () => {
  assert.equal(isRecoverable("acceptance_report_parse_failure"), true);
  assert.equal(isRecoverable("round_cap_reached"), true);
  assert.equal(isRecoverable("timeout"), true);
});

test("isRecoverable — non-recoverable failures", () => {
  assert.equal(isRecoverable("blocked_needs_user_decision"), false);
  assert.equal(isRecoverable("ci_failure"), false);
  assert.equal(isRecoverable("unknown"), false);
});

// ── runQueue ────────────────────────────────────────────────────────

test("runQueue processes single entry successfully", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [createEntry(556, "issue")],
    };
    await writeQueue(dir, queue);

    let transitions = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => ({ ok: true, pr: 88 }),
      onTransition: (state, entry) => transitions.push({ state, target: entry.target }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].target, 556);
    assert.equal(result.results[0].ok, true);

    // Verify transitions: running → waiting_review → gates_passing → merging → done
    const states = transitions.map((t) => t.state);
    assert.deepEqual(states, ["running", "waiting_review", "gates_passing", "merging", "done"]);

    // Verify final state in queue
    assert.equal(result.queue.entries[0].status, "done");
    assert.equal(result.queue.entries[0].retrospectiveWritten, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue processes multiple entries in order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [
        createEntry(1, "issue"),
        createEntry(2, "issue"),
        createEntry(3, "issue"),
      ],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        processed.push(entry.target);
        return { ok: true, pr: entry.target * 10 };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 3);
    assert.deepEqual(processed, [1, 2, 3]);

    result.results.forEach((r) => assert.equal(r.ok, true));
    result.queue.entries.forEach((e) => assert.equal(e.status, "done"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue respects dependency ordering", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [
        createEntry(1, "issue"),
        createEntry(2, "issue", [1]),
        createEntry(3, "issue", [2]),
      ],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        processed.push(entry.target);
        return { ok: true, pr: entry.target * 10 };
      },
    });

    assert.deepEqual(processed, [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue pauses on blocked entry, continues others", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [
        createEntry(1, "issue"),
        createEntry(2, "issue"),
      ],
    };
    await writeQueue(dir, queue);

    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        if (entry.target === 1) throw new Error("blocked by human comment — needs decision");
        return { ok: true, pr: 20 };
      },
    });

    assert.equal(result.ok, false);
    const e1 = result.queue.entries.find((e) => e.target === 1);
    const e2 = result.queue.entries.find((e) => e.target === 2);
    assert.equal(e1.status, "blocked");
    assert.equal(e1.failureKind, "blocked_needs_user_decision");
    assert.equal(e2.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue retries recoverable failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue")],
    };
    await writeQueue(dir, queue);

    let calls = 0;
    const result = await runQueue(dir, "test/repo", {
      reDispatchMaxRetries: 3,
      mergeAuthorized: true,
      runEntry: async (entry) => {
        calls++;
        if (calls === 1) throw new Error("timeout waiting for review");
        return { ok: true, pr: 10 };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.results.length, 2); // one failed retry + one success
    const finalEntry = result.queue.entries[0];
    assert.equal(finalEntry.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue blocks after max retries exceeded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue")],
    };
    await writeQueue(dir, queue);

    const result = await runQueue(dir, "test/repo", {
      reDispatchMaxRetries: 0,
      runEntry: async () => {
        throw new Error("timeout");
      },
    });

    const entry = result.queue.entries[0];
    assert.equal(entry.status, "blocked");
    assert.equal(entry.failureKind, "timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue leaves entry at gates_passing when merge not authorized", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue")],
    };
    await writeQueue(dir, queue);

    let transitions = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async () => ({ ok: true, pr: 10 }),
      onTransition: (state, entry) => transitions.push(state),
    });

    // Should NOT include "merging" or "done"
    assert.equal(transitions.includes("merging"), false);
    assert.equal(transitions.includes("done"), false);
    // Entry stays at gates_passing so a future run can merge
    assert.equal(result.queue.entries[0].status, "gates_passing");
    assert.equal(result.queue.entries[0].retrospectiveWritten, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue handles empty queue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-"));
  try {
    const queue = { version: 1, entries: [] };
    await writeQueue(dir, queue);

    const result = await runQueue(dir, "test/repo", {
      runEntry: async () => ({ ok: true }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue wires board transitions when configured and records them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-board-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 7\n");
    const queue = {
      version: 1,
      entries: [createEntry(101, "issue")],
    };
    await writeQueue(dir, queue);

    const moves = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async () => ({ ok: true, pr: null }),
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 101 }] }),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(moves.length, 2);
    assert.equal(moves[0].toColumn, "In Progress");
    assert.equal(moves[1].toColumn, "Done");
    assert.equal(result.results[0].boardSync.length, 2);
    assert.equal(result.results[0].boardSync[0].skipped, false);
    assert.equal(result.results[0].boardSync[1].skipped, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue syncs final-approval column for open PR when merge not authorized (#793)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-final-approval-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 7\n");
    const queue = {
      version: 1,
      entries: [createEntry(201, "issue")],
    };
    await writeQueue(dir, queue);

    const moves = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async () => ({ ok: true, pr: 42 }),
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 201 }] }),
      },
    });

    // Entry stays at gates_passing (merge not authorized) for a future run.
    assert.equal(result.queue.entries[0].status, "gates_passing");
    // running → In Progress; final_approval_ready resolves to the SAME column
    // ("In Progress") so the redundant board write is deduped — only ONE move.
    assert.equal(moves.length, 1, "redundant same-column final-approval sync is deduped");
    assert.equal(moves[0].toColumn, "In Progress");
    // Both syncs still accounted for; the second is a skipped "column unchanged".
    assert.equal(result.results[0].boardSync.length, 2);
    assert.equal(result.results[0].boardSync[0].skipped, false);
    assert.equal(result.results[0].boardSync[1].skipped, true);
    assert.equal(result.results[0].boardSync[1].reason, "column unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue does sync a distinct Ready for Review column for open PR (#793)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-ready-review-"));
  try {
    await writeFile(
      path.join(dir, ".devloops"),
      "queue:\n  board:\n    number: 7\n  statusColumns:\n    ready_for_review: \"Ready for Review\"\n",
    );
    const queue = {
      version: 1,
      entries: [createEntry(203, "issue")],
    };
    await writeQueue(dir, queue);

    const moves = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async () => ({ ok: true, pr: 42 }),
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 203 }] }),
      },
    });

    assert.equal(result.queue.entries[0].status, "gates_passing");
    // Distinct column configured → both moves land (no dedup).
    assert.equal(moves.length, 2);
    assert.equal(moves[0].toColumn, "In Progress");
    assert.equal(moves[1].toColumn, "Ready for Review");
    assert.equal(result.results[0].boardSync[1].skipped, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue final-approval board sync is a no-op when board unconfigured (#793)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-final-approval-noop-"));
  try {
    const queue = {
      version: 1,
      entries: [createEntry(202, "issue")],
    };
    await writeQueue(dir, queue);

    const moves = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async () => ({ ok: true, pr: 42 }),
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
      },
    });

    assert.equal(result.queue.entries[0].status, "gates_passing");
    assert.equal(moves.length, 0, "no board mutations when board is unconfigured");
    // Both syncs (running + final approval) recorded as skipped no-ops.
    assert.equal(result.results[0].boardSync.length, 2);
    assert.equal(result.results[0].boardSync.every((s) => s.skipped), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue records fallback board transition on failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-board-fail-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 7\n");
    const queue = {
      version: 1,
      entries: [createEntry(102, "issue")],
    };
    await writeQueue(dir, queue);

    const moves = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async () => {
        throw new Error("blocked by human comment — needs decision");
      },
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 102 }] }),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(moves.length, 2);
    assert.equal(moves[0].toColumn, "In Progress");
    assert.equal(moves[1].toColumn, "Backlog");
    assert.equal(result.results[0].boardSync.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #913: adapter must not fabricate `done` without an orchestrator ──

test("runQueue with no orchestrator is a no-op: no entry marked done, board unchanged (#913)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-noorch-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 7\n");
    const queue = {
      version: 1,
      entries: [createEntry(911, "issue"), createEntry(909, "issue"), createEntry(912, "issue")],
    };
    await writeQueue(dir, queue);

    const moves = [];
    // No `runEntry` supplied — exactly the CLI default path that fabricated done.
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
      },
    });

    assert.equal(result.noop, true);
    assert.equal(result.reason, "no-orchestrator");
    assert.deepEqual(result.results, []);
    // Board columns untouched — not a single move was issued.
    assert.equal(moves.length, 0);
    // Every entry left exactly where it was; none fabricated to done.
    for (const e of result.queue.entries) {
      assert.equal(e.status, "queued");
      assert.equal(e.pr, null);
      assert.equal(e.runId, null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue reflects a real merged-PR terminal signal to Done (#913 legit path)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-merged-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 7\n");
    const queue = { version: 1, entries: [createEntry(101, "issue")] };
    await writeQueue(dir, queue);

    const moves = [];
    // An orchestrator supplies a verifiable terminal signal (PR) and merge is
    // authorized — the adapter correctly reflects that to Done.
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async () => ({ ok: true, pr: 555 }),
      queueBoardSyncDependencies: {
        moveQueueItem: async (args) => {
          moves.push({ ...args });
          return { ok: true, item: { newColumn: args.toColumn } };
        },
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 101 }] }),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.queue.entries[0].status, "done");
    assert.equal(moves[moves.length - 1].toColumn, "Done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue reorders ready entries by board Next Up order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-order-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 3\n");
    const queue = {
      version: 1,
      entries: [
        createEntry(1, "issue"),
        createEntry(2, "issue"),
        createEntry(3, "issue"),
      ],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: false,
      runEntry: async (entry) => {
          processed.push(entry.target);
          return { ok: true, pr: null };
        },
      queueBoardSyncDependencies: {
        moveQueueItem: async () => ({ ok: true, item: {} }),
        listQueueItems: async () => ({
          ok: true,
          items: [
            { issueNumber: 3 },
            { issueNumber: 1 },
            { issueNumber: 2 },
          ],
        }),
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(processed, [3, 1, 2]);
    assert.deepEqual(
      result.results.map((r) => r.target),
      [3, 1, 2],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #1091: Next Up is the normative, fail-closed pickup source ──────────

test("runQueue picks Next Up members by position ascending; a local entry ABSENT from Next Up is NOT picked (#1091)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-nextup-gate-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 3\n");
    // 4 is present locally but ABSENT from Next Up → must never run.
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue"), createEntry(2, "issue"), createEntry(4, "issue")],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        processed.push(entry.target);
        return { ok: true, pr: entry.target * 10 };
      },
      queueBoardSyncDependencies: {
        moveQueueItem: async () => ({ ok: true, item: {} }),
        // Next Up (position order): 2 then 1. Entry 4 is deliberately excluded.
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 2 }, { issueNumber: 1 }] }),
      },
    });

    assert.equal(result.ok, true);
    // Only Next Up members, by position ascending.
    assert.deepEqual(processed, [2, 1]);
    // Absent-from-Next-Up entry left untouched (still queued), never auto-picked.
    assert.equal(result.queue.entries.find((e) => e.target === 4).status, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue fails CLOSED on empty Next Up: idle outcome, explicit reason, NO Backlog fallback (#1091)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-nextup-empty-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 3\n");
    // Local queue HAS work, but none of it is in Next Up → must NOT run.
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue"), createEntry(2, "issue")],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        processed.push(entry.target);
        return { ok: true, pr: 10 };
      },
      queueBoardSyncDependencies: {
        moveQueueItem: async () => ({ ok: true, item: {} }),
        // Successful query, zero items → genuinely empty Next Up.
        listQueueItems: async () => ({ ok: true, items: [] }),
      },
    });

    assert.equal(result.idle, true);
    assert.equal(result.reason, "next-up-empty");
    assert.match(result.message, /prioritize Backlog items into Next Up/);
    // Fail closed: nothing ran, no Backlog fallback.
    assert.deepEqual(processed, []);
    assert.deepEqual(result.results, []);
    for (const e of result.queue.entries) assert.equal(e.status, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue fails CLOSED when a Next Up target has no local queue entry: actionable stop, NO Backlog pickup (#1091)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-nextup-missing-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 3\n");
    // Local queue has 1; Next Up lists 1 AND 99. 99 has no local entry (reconcile
    // not run/persisted, or the board changed since reconcile).
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue")],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        processed.push(entry.target);
        return { ok: true, pr: 10 };
      },
      queueBoardSyncDependencies: {
        moveQueueItem: async () => ({ ok: true, item: {} }),
        listQueueItems: async () => ({ ok: true, items: [{ issueNumber: 1 }, { issueNumber: 99 }] }),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, "next-up-target-missing-locally");
    assert.deepEqual(result.missingTargets, [99]);
    assert.match(result.message, /no local queue entry/);
    // Fail closed: nothing ran, no Backlog fallback, local entry untouched.
    assert.deepEqual(processed, []);
    assert.deepEqual(result.results, []);
    assert.equal(result.queue.entries.find((e) => e.target === 1).status, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runQueue surfaces a board-query ERROR and stops; no Backlog/local fallback (#1091)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-nextup-error-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  board:\n    number: 3\n");
    const queue = {
      version: 1,
      entries: [createEntry(1, "issue"), createEntry(2, "issue")],
    };
    await writeQueue(dir, queue);

    const processed = [];
    const result = await runQueue(dir, "test/repo", {
      mergeAuthorized: true,
      runEntry: async (entry) => {
        processed.push(entry.target);
        return { ok: true, pr: 10 };
      },
      queueBoardSyncDependencies: {
        moveQueueItem: async () => ({ ok: true, item: {} }),
        listQueueItems: async () => { throw new Error("GraphQL timeout"); },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, "board-query-error");
    assert.match(result.error, /GraphQL timeout/);
    // Error path: nothing ran, no fallback to Backlog/local order.
    assert.deepEqual(processed, []);
    assert.deepEqual(result.results, []);
    for (const e of result.queue.entries) assert.equal(e.status, "queued");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
