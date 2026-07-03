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
  it("#1057-shaped: Backlog issue with a ready linked PR → one move to In Progress by item node id", async () => {
    const moveCalls = [];
    const result = await run({
      items: [{ itemId: "I_42", issueNumber: 42, prNumber: null, status: "Backlog" }],
      facts: [["I_42", READY_LINKED_PR]],
      moveCalls,
    });
    assert.equal(result.ok, true);
    assert.equal(result.moved, 1);
    assert.equal(moveCalls.length, 1);
    // Move is applied by the stable node id, not the bare number.
    assert.deepEqual(moveCalls[0], { repo: "o/r", project: "7", projectTitle: undefined, item: "I_42", toColumn: "In Progress" });
    assert.deepEqual(result.reconciled, [{ number: 42, from: "Backlog", to: "In Progress", ok: true }]);
  });

  it("multi-repo number collision: two items share number 5 but each moves by its own itemId", async () => {
    const moveCalls = [];
    const result = await run({
      items: [
        { itemId: "I_prA", issueNumber: null, prNumber: 5, status: "Backlog" },
        { itemId: "I_issB", issueNumber: 5, prNumber: null, status: "Backlog" },
      ],
      facts: [
        ["I_prA", { itemKind: "pr", issueState: null, prState: "MERGED", prIsDraft: false }],
        ["I_issB", READY_LINKED_PR],
      ],
      moveCalls,
    });
    assert.equal(result.moved, 2);
    const byItem = new Map(moveCalls.map((c) => [c.item, c.toColumn]));
    assert.equal(byItem.get("I_prA"), "Done");
    assert.equal(byItem.get("I_issB"), "In Progress");
  });

  it("idempotent: item already In Progress → no moves, and a second run also moves nothing", async () => {
    const items = [{ itemId: "I_42", issueNumber: 42, prNumber: null, status: "In Progress" }];
    const facts = [["I_42", READY_LINKED_PR]];

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
      items: [{ itemId: "I_7", issueNumber: 7, prNumber: null, status: "Next Up" }],
      facts: [["I_7", UNTOUCHED]],
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
          listItems: async (a) => { listArgs.push(a); return { items: [{ itemId: "I_42", issueNumber: 42, prNumber: null, status: "Backlog" }] }; },
          gatherFacts: async () => new Map([["I_42", READY_LINKED_PR]]),
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
