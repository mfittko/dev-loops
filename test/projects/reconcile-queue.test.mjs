import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../../scripts/projects/reconcile-queue.mjs";

// Facts consumed by planReconcile via deriveReconcileColumn. A ready open
// non-draft linked PR on an open issue derives → In Progress.
const READY_LINKED_PR = { itemKind: "issue", issueState: "OPEN", prState: "OPEN", prIsDraft: false };
// Nothing to derive (no linked PR / still draft) → untouched.
const UNTOUCHED = { itemKind: "issue", issueState: "OPEN", prState: null, prIsDraft: null };

// Run main() with fully injected deps so no network / gh / .devloops is needed.
// cwd omitted → loadStateColumnMap falls back to the AC1 default column names,
// so "In Progress"/"Done" resolve deterministically.
function run({ items, facts, moveCalls }) {
  return main(
    { repo: "o/r", project: "7" },
    {
      env: {},
      listItems: async () => ({ items }),
      gatherFacts: async () => new Map(facts),
      moveItem: async (args) => { moveCalls.push(args); return { ok: true }; },
    },
  );
}

describe("reconcile-queue main (#1069)", () => {
  it("#1057-shaped: Backlog issue with a ready linked PR → one move to In Progress", async () => {
    const moveCalls = [];
    const result = await run({
      items: [{ issueNumber: 42, prNumber: null, status: "Backlog" }],
      facts: [[42, READY_LINKED_PR]],
      moveCalls,
    });
    assert.equal(result.ok, true);
    assert.equal(result.moved, 1);
    assert.equal(moveCalls.length, 1);
    assert.deepEqual(moveCalls[0], { repo: "o/r", project: "7", projectTitle: undefined, item: "42", toColumn: "In Progress" });
    assert.deepEqual(result.reconciled, [{ number: 42, from: "Backlog", to: "In Progress", ok: true }]);
  });

  it("idempotent: item already In Progress → no moves, and a second run also moves nothing", async () => {
    const items = [{ issueNumber: 42, prNumber: null, status: "In Progress" }];
    const facts = [[42, READY_LINKED_PR]];

    const first = [];
    const r1 = await run({ items, facts, moveCalls: first });
    assert.equal(r1.moved, 0);
    assert.equal(r1.unchanged, items.length);
    assert.deepEqual(r1.reconciled, []);
    assert.equal(first.length, 0);

    const second = [];
    const r2 = await run({ items, facts, moveCalls: second });
    assert.equal(r2.moved, 0);
    assert.equal(second.length, 0);
  });

  it("Backlog/Next Up untouched: a Next Up item deriving null → no move", async () => {
    const moveCalls = [];
    const result = await run({
      items: [{ issueNumber: 7, prNumber: null, status: "Next Up" }],
      facts: [[7, UNTOUCHED]],
      moveCalls,
    });
    assert.equal(result.moved, 0);
    assert.equal(result.unchanged, 1);
    assert.equal(moveCalls.length, 0);
  });

  it("resolves .devloops boardTitle when --project is omitted and forwards projectTitle to list/move", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reconcile-board-"));
    try {
      writeFileSync(path.join(dir, ".devloops"), 'queue:\n  boardTitle: "My Board"\n');

      const listArgs = [];
      const moveCalls = [];
      const result = await main(
        { repo: "o/r" }, // no project → must resolve boardTitle from .devloops
        {
          env: {},
          cwd: dir,
          listItems: async (a) => { listArgs.push(a); return { items: [{ issueNumber: 42, prNumber: null, status: "Backlog" }] }; },
          gatherFacts: async () => new Map([[42, READY_LINKED_PR]]),
          moveItem: async (a) => { moveCalls.push(a); return { ok: true }; },
        },
      );

      assert.equal(result.ok, true);
      assert.equal(result.moved, 1);
      assert.equal(listArgs.length, 1);
      assert.equal(listArgs[0].projectTitle, "My Board");
      assert.equal(listArgs[0].project, undefined);
      assert.equal(moveCalls.length, 1);
      assert.equal(moveCalls[0].projectTitle, "My Board");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
