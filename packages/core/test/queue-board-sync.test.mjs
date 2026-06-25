import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadBoardConfig,
  syncBoardStatus,
  nonSuccessBoardColumn,
  boardColumnForLoopState,
  loadStateColumnMap,
  LOGICAL_COLUMN,
  DEFAULT_STATE_COLUMN_NAMES,
} from "../src/loop/queue-board-sync.mjs";

async function makeRepo(configYaml) {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-board-sync-"));
  if (configYaml) {
    await writeFile(path.join(dir, ".devloops"), configYaml);
  }
  return dir;
}

test("loadBoardConfig returns disabled when no .devloops", async () => {
  const dir = await makeRepo(null);
  try {
    assert.deepEqual(loadBoardConfig(dir), { enabled: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBoardConfig enabled by projectNumber", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 7\n");
  try {
    assert.deepEqual(loadBoardConfig(dir), { enabled: true, projectNumber: 7 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBoardConfig enabled by boardTitle", async () => {
  const dir = await makeRepo('queue:\n  boardTitle: "My Queue"\n');
  try {
    assert.deepEqual(loadBoardConfig(dir), { enabled: true, boardTitle: "My Queue" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus skips when board not configured", async () => {
  const dir = await makeRepo(null);
  try {
    const result = await syncBoardStatus("owner/repo", dir, 42, "In Progress", {});
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "board not configured");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus moves item when configured", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n");
  try {
    const moved = [];
    const result = await syncBoardStatus(
      "owner/repo",
      dir,
      42,
      "In Progress",
      { GH_TOKEN: "mock" },
      {
        moveQueueItem: async (args, _ctx) => {
          moved.push(args);
          return { ok: true, item: { newColumn: args.toColumn } };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(moved.length, 1);
    assert.deepEqual(moved[0], {
      repo: "owner/repo",
      project: 5,
      item: 42,
      toColumn: "In Progress",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus fail-open when move fails", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n");
  try {
    const result = await syncBoardStatus(
      "owner/repo",
      dir,
      42,
      "Done",
      { GH_TOKEN: "mock" },
      {
        moveQueueItem: async () => {
          throw new Error("API rate limit");
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "API rate limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nonSuccessBoardColumn uses default", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n");
  try {
    assert.equal(nonSuccessBoardColumn(dir), "Backlog");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nonSuccessBoardColumn uses configured value", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n  nonSuccessStatus: Todo\n");
  try {
    assert.equal(nonSuccessBoardColumn(dir), "Todo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBoardConfig surfaces config read errors", async () => {
  const dir = await makeRepo(null);
  try {
    await writeFile(path.join(dir, ".devloops"), "queue: [invalid yaml");
    const result = loadBoardConfig(dir);
    assert.equal(result.enabled, false);
    assert.match(result.reason, /config read\/parse error/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── boardColumnForLoopState (AC1, AC3, AC5) ──────────────────────────────

test("boardColumnForLoopState maps issue_opened and pr_draft to Next Up (AC1)", () => {
  assert.equal(boardColumnForLoopState("issue_opened"), "Next Up");
  assert.equal(boardColumnForLoopState("pr_draft"), "Next Up");
});

test("boardColumnForLoopState maps active/feedback states to In Progress (AC1)", () => {
  for (const state of [
    "pr_ready_no_feedback",
    "waiting_for_copilot_review",
    "ready_to_rerequest_review",
    "local_implementation_active",
    "implementation",
    "feedback_resolution",
    "unresolved_feedback_present",
    "already_fixed_needs_reply_resolve",
    "waiting_for_ci",
    "blocked_needs_user_decision",
  ]) {
    assert.equal(boardColumnForLoopState(state), "In Progress", `state ${state}`);
  }
});

test("boardColumnForLoopState maps final_approval_ready to In Progress by default (AC1)", () => {
  assert.equal(boardColumnForLoopState("final_approval_ready"), "In Progress");
});

test("boardColumnForLoopState uses configured Ready for Review column for final_approval_ready when present (AC1)", () => {
  const mapping = {
    columnNames: { ...DEFAULT_STATE_COLUMN_NAMES, [LOGICAL_COLUMN.READY_FOR_REVIEW]: "Ready for Review" },
  };
  assert.equal(boardColumnForLoopState("final_approval_ready", mapping), "Ready for Review");
});

test("boardColumnForLoopState maps merged / issue_closed / done to Done (AC1)", () => {
  assert.equal(boardColumnForLoopState("merged"), "Done");
  assert.equal(boardColumnForLoopState("issue_closed"), "Done");
  assert.equal(boardColumnForLoopState("done"), "Done");
});

test("boardColumnForLoopState falls back to In Progress for unknown states (documented default)", () => {
  assert.equal(boardColumnForLoopState("some_unmapped_state"), "In Progress");
  assert.equal(boardColumnForLoopState(undefined), "In Progress");
  assert.equal(boardColumnForLoopState(null), "In Progress");
});

test("boardColumnForLoopState honors a config-driven column name override (AC3)", () => {
  const mapping = {
    columnNames: {
      ...DEFAULT_STATE_COLUMN_NAMES,
      [LOGICAL_COLUMN.NEXT_UP]: "Todo",
      [LOGICAL_COLUMN.IN_PROGRESS]: "Doing",
      [LOGICAL_COLUMN.DONE]: "Shipped",
    },
  };
  assert.equal(boardColumnForLoopState("pr_draft", mapping), "Todo");
  assert.equal(boardColumnForLoopState("waiting_for_copilot_review", mapping), "Doing");
  assert.equal(boardColumnForLoopState("merged", mapping), "Shipped");
});

test("boardColumnForLoopState honors a per-state override via stateColumnMap (AC3)", () => {
  const mapping = {
    stateColumnMap: { blocked_needs_user_decision: LOGICAL_COLUMN.NEXT_UP },
    columnNames: DEFAULT_STATE_COLUMN_NAMES,
  };
  // overridden logical column, default name
  assert.equal(boardColumnForLoopState("blocked_needs_user_decision", mapping), "Next Up");
});

test("boardColumnForLoopState supports a reverse transition merged->Done then reopened->In Progress (AC5)", () => {
  // forward: merged sits in Done
  assert.equal(boardColumnForLoopState("merged"), "Done");
  // reverted: PR reopened back to ready -> In Progress (moves backward)
  assert.equal(boardColumnForLoopState("pr_ready_no_feedback"), "In Progress");
  // ready -> draft reverts further back to Next Up
  assert.equal(boardColumnForLoopState("pr_draft"), "Next Up");
});

// ── loadStateColumnMap (AC2/AC3/AC6) ─────────────────────────────────────

test("loadStateColumnMap returns defaults when no config present", async () => {
  const dir = await makeRepo(null);
  try {
    const mapping = loadStateColumnMap(dir);
    // Built on null-prototype objects (prototype-pollution hardening), so
    // compare contents rather than prototype identity.
    assert.deepEqual({ ...mapping.columnNames }, { ...DEFAULT_STATE_COLUMN_NAMES });
    assert.deepEqual({ ...mapping.stateColumnMap }, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStateColumnMap reads queue.statusColumns overrides (AC3)", async () => {
  const dir = await makeRepo(
    "queue:\n  projectNumber: 5\n  statusColumns:\n    next_up: Todo\n    done: Shipped\n",
  );
  try {
    const mapping = loadStateColumnMap(dir);
    assert.equal(mapping.columnNames[LOGICAL_COLUMN.NEXT_UP], "Todo");
    assert.equal(mapping.columnNames[LOGICAL_COLUMN.DONE], "Shipped");
    // untouched logical columns keep defaults
    assert.equal(
      mapping.columnNames[LOGICAL_COLUMN.IN_PROGRESS],
      DEFAULT_STATE_COLUMN_NAMES[LOGICAL_COLUMN.IN_PROGRESS],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStateColumnMap reads queue.stateColumnMap per-state overrides (AC3)", async () => {
  const dir = await makeRepo(
    "queue:\n  projectNumber: 5\n  stateColumnMap:\n    final_approval_ready: ready_for_review\n  statusColumns:\n    ready_for_review: \"Ready for Review\"\n",
  );
  try {
    const mapping = loadStateColumnMap(dir);
    assert.equal(boardColumnForLoopState("final_approval_ready", mapping), "Ready for Review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStateColumnMap ignores unknown statusColumns keys (allow-list)", async () => {
  const dir = await makeRepo(
    "queue:\n  projectNumber: 5\n  statusColumns:\n    bogus_column: Nope\n    next_up: Todo\n",
  );
  try {
    const mapping = loadStateColumnMap(dir);
    // valid override applies
    assert.equal(mapping.columnNames[LOGICAL_COLUMN.NEXT_UP], "Todo");
    // unknown logical-column key is not copied in
    assert.equal(Object.prototype.hasOwnProperty.call(mapping.columnNames, "bogus_column"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStateColumnMap ignores stateColumnMap entries with an unknown logical-column value", async () => {
  const dir = await makeRepo(
    "queue:\n  projectNumber: 5\n  stateColumnMap:\n    pr_draft: not_a_column\n    blocked_needs_user_decision: next_up\n",
  );
  try {
    const mapping = loadStateColumnMap(dir);
    // invalid value ignored — pr_draft keeps its default logical column (Next Up)
    assert.equal(Object.prototype.hasOwnProperty.call(mapping.stateColumnMap, "pr_draft"), false);
    assert.equal(boardColumnForLoopState("pr_draft", mapping), "Next Up");
    // valid value applies
    assert.equal(mapping.stateColumnMap["blocked_needs_user_decision"], "next_up");
    assert.equal(boardColumnForLoopState("blocked_needs_user_decision", mapping), "Next Up");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadStateColumnMap is not vulnerable to prototype pollution via config keys", async () => {
  const dir = await makeRepo(
    'queue:\n  projectNumber: 5\n  statusColumns:\n    __proto__: { polluted: yes }\n  stateColumnMap:\n    __proto__: { polluted: yes }\n',
  );
  try {
    const mapping = loadStateColumnMap(dir);
    // Object.prototype must remain unpolluted.
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    // The dangerous key is not copied into the result objects either.
    assert.equal(mapping.columnNames.polluted, undefined);
    assert.equal(mapping.stateColumnMap.polluted, undefined);
    // Valid defaults still intact.
    assert.equal(mapping.columnNames[LOGICAL_COLUMN.IN_PROGRESS], "In Progress");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus is a no-op when board config disabled, driven by mapping (AC2/AC6)", async () => {
  const dir = await makeRepo(null);
  try {
    const column = boardColumnForLoopState("waiting_for_copilot_review", loadStateColumnMap(dir));
    const result = await syncBoardStatus("owner/repo", dir, 42, column, {});
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus is a logged no-op when item is not on the board (AC4)", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n");
  try {
    const logs = [];
    const result = await syncBoardStatus(
      "owner/repo",
      dir,
      42,
      "In Progress",
      { GH_TOKEN: "mock" },
      {
        log: (msg) => logs.push(msg),
        moveQueueItem: async () => {
          throw Object.assign(new Error("item 42 is not on project board 5"), {
            code: "ITEM_NOT_ON_BOARD",
          });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /not on/i);
    assert.equal(logs.length, 1, "expected exactly one log for the no-op");
    assert.match(logs[0], /no-op: item 42 is not on the board/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus also treats ITEM_NOT_FOUND as the not-on-board no-op (AC4)", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n");
  try {
    const logs = [];
    const result = await syncBoardStatus(
      "owner/repo",
      dir,
      42,
      "In Progress",
      { GH_TOKEN: "mock" },
      {
        log: (msg) => logs.push(msg),
        moveQueueItem: async () => {
          throw Object.assign(new Error("Item #42 not found in project"), {
            code: "ITEM_NOT_FOUND",
          });
        },
      },
    );
    assert.equal(result.skipped, true);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /not on the board/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus logs a distinct fail-open message for non-not-on-board errors", async () => {
  const dir = await makeRepo("queue:\n  projectNumber: 5\n");
  try {
    const logs = [];
    const result = await syncBoardStatus(
      "owner/repo",
      dir,
      42,
      "In Progress",
      { GH_TOKEN: "mock" },
      {
        log: (msg) => logs.push(msg),
        moveQueueItem: async () => {
          throw Object.assign(new Error("API rate limit exceeded"), { code: "GH_API_ERROR" });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(logs.length, 1);
    // Must NOT be mistaken for the AC4 not-on-board no-op.
    assert.doesNotMatch(logs[0], /not on the board/);
    assert.match(logs[0], /sync failed \(fail-open\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("syncBoardStatus resolves boardTitle to project number and moves item", async () => {
  const dir = await makeRepo('queue:\n  boardTitle: "BoardTitle Test Queue"\n');
  try {
    const moved = [];
    const result = await syncBoardStatus(
      "owner/repo",
      dir,
      42,
      "In Progress",
      { GH_TOKEN: "mock" },
      {
        moveQueueItem: async (args, _ctx) => {
          moved.push(args);
          return { ok: true, item: { newColumn: args.toColumn } };
        },
        runChild: async (_cmd, args, _env) => {
          const queryField = args.find((a) => typeof a === "string" && a.startsWith("query="));
          const query = queryField ? queryField.slice(6) : "";
          if (query.includes("user(login:$login) { id }")) {
            return { code: 0, stdout: JSON.stringify({ data: { user: { id: "U_owner" } } }), stderr: "" };
          }
          if (query.includes("projectsV2(first:50")) {
            return {
              code: 0,
              stdout: JSON.stringify({
                data: {
                  user: {
                    projectsV2: {
                      nodes: [
                        { id: "P_9", number: 9, title: "BoardTitle Test Queue", url: "http://example.com/9" },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              }),
              stderr: "",
            };
          }
          return { code: 1, stdout: "", stderr: "unexpected query" };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(moved.length, 1);
    assert.deepEqual(moved[0], {
      repo: "owner/repo",
      project: 9,
      item: 42,
      toColumn: "In Progress",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
