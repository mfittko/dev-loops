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
    await writeFile(path.join(dir, ".devloops"), "queue:\n  projectNumber: 7\n");
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
    await writeFile(path.join(dir, ".devloops"), "queue:\n  projectNumber: 7\n");
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
      },
    });

    // Entry stays at gates_passing (merge not authorized) for a future run.
    assert.equal(result.queue.entries[0].status, "gates_passing");
    // running → In Progress, then gates_passing-without-merge → final approval.
    assert.equal(moves.length, 2);
    assert.equal(moves[0].toColumn, "In Progress");
    // final_approval_ready defaults to "In Progress" (no Ready for Review column configured).
    assert.equal(moves[1].toColumn, "In Progress");
    assert.equal(result.results[0].boardSync.length, 2);
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
    await writeFile(path.join(dir, ".devloops"), "queue:\n  projectNumber: 7\n");
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

test("runQueue reorders ready entries by board Next Up order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-driver-order-"));
  try {
    await writeFile(path.join(dir, ".devloops"), "queue:\n  projectNumber: 3\n");
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
