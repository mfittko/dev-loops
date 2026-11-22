import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, gatherLiveFacts } from "../../scripts/projects/reconcile-queue.mjs";

// Facts consumed by planReconcile via deriveReconcileColumn. A ready open
// non-draft linked PR on an open issue derives → In Progress.
const READY_LINKED_PR = { itemKind: "issue", issueState: "OPEN", prState: "OPEN", prIsDraft: false };
// Nothing to derive (no linked PR) → untouched.
const UNTOUCHED = { itemKind: "issue", issueState: "OPEN", prState: null, prIsDraft: null };
// An open DRAFT linked PR now derives → In Progress (a runner owns it, #2029).
const DRAFT_LINKED_PR = { itemKind: "issue", issueState: "OPEN", prState: "OPEN", prIsDraft: true };

const READY_LINKED_PR_NO_DRAFT = { itemKind: "issue", issueState: "OPEN", prState: "OPEN", prIsDraft: null };

// Batched-query alias payload helpers (detectLinkedIssuePrs).
const batchTimeline = (nodes) => ({ timelineItems: { pageInfo: { hasNextPage: false }, nodes } });
const crossRef = (number, willCloseTarget = true) => ({
  __typename: "CrossReferencedEvent",
  createdAt: "2026-05-12T10:00:00Z",
  willCloseTarget,
  source: { __typename: "PullRequest", number, state: "OPEN", url: `https://github.com/o/r/pull/${number}`, repository: { nameWithOwner: "o/r" } },
});

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

  it("#2029: a Next Up item with an open draft linked PR → one move to In Progress (leaves the pickup column)", async () => {
    const moveCalls = [];
    const result = await run({
      items: [{ itemId: "I_9", issueNumber: 9, prNumber: null, status: "Next Up" }],
      facts: [["I_9", DRAFT_LINKED_PR]],
      moveCalls,
    });
    assert.equal(result.ok, true);
    assert.equal(result.moved, 1);
    assert.equal(moveCalls.length, 1);
    assert.equal(moveCalls[0].toColumn, "In Progress");
  });

  it("gatherLiveFacts with doneColumn skips a Done-status item but still gathers a non-Done item", async () => {
    const calls = [];
    const runChild = async (cmd, argv) => {
      calls.push({ cmd, argv });
      return { code: 0, stdout: JSON.stringify({ data: { repository: { i2: batchTimeline([]) } } }), stderr: "" };
    };
    const items = [
      { itemId: "I_done", issueNumber: 1, prNumber: null, status: "Done", contentState: "OPEN" },
      { itemId: "I_backlog", issueNumber: 2, prNumber: null, status: "Backlog", contentState: "OPEN" },
    ];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild, doneColumn: "Done" });
    assert.equal(facts.has("I_done"), false);
    assert.equal(facts.has("I_backlog"), true);
    // Only the non-Done issue is queried, in one batch call.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argv.some((a) => a.includes("i2:") && !a.includes("i1:")));
  });

  it("maps contentState to facts: merged PR, closed issue, open issue with an open linked PR", async () => {
    const runChild = async () => ({
      code: 0,
      stdout: JSON.stringify({ data: { repository: { i3: batchTimeline([crossRef(300)]), i4: batchTimeline([]) } } }),
      stderr: "",
    });
    const items = [
      { itemId: "P", issueNumber: null, prNumber: 1, status: "Backlog", contentState: "MERGED" },
      { itemId: "C", issueNumber: 2, prNumber: null, status: "Backlog", contentState: "CLOSED" },
      { itemId: "L", issueNumber: 3, prNumber: null, status: "Backlog", contentState: "OPEN" },
      { itemId: "N", issueNumber: 4, prNumber: null, status: "Backlog", contentState: "OPEN" },
    ];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild });
    assert.deepEqual(facts.get("P"), { itemKind: "pr", issueState: null, prState: "MERGED", prIsDraft: null });
    assert.deepEqual(facts.get("C"), { itemKind: "issue", issueState: "CLOSED", prState: null, prIsDraft: null });
    assert.deepEqual(facts.get("L"), { itemKind: "issue", issueState: "OPEN", prState: "OPEN", prIsDraft: null });
    assert.deepEqual(facts.get("N"), UNTOUCHED);
  });

  it("a PR that only body-mentions a sibling issue does NOT link it (no move)", async () => {
    const runChild = async () => ({
      code: 0,
      stdout: JSON.stringify({ data: { repository: { i1084: batchTimeline([crossRef(1128, false)]) } } }),
      stderr: "",
    });
    const items = [{ itemId: "I_B", issueNumber: 1084, prNumber: null, status: "Backlog", contentState: "OPEN" }];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild });
    assert.deepEqual(facts.get("I_B"), UNTOUCHED);
    const moveCalls = [];
    const result = await run({ items, facts: [...facts], moveCalls });
    assert.equal(result.moved, 0);
    assert.equal(moveCalls.length, 0);
  });

  it("gatherLiveFacts WITHOUT doneColumn gathers a Done-status item (explicit-run recovery)", async () => {
    const runChild = async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { i1: batchTimeline([crossRef(5)]) } } }), stderr: "" });
    const items = [{ itemId: "I_done", issueNumber: 1, prNumber: null, status: "Done", contentState: "OPEN" }];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild });
    assert.deepEqual(facts.get("I_done"), READY_LINKED_PR_NO_DRAFT);
  });

  it("a failed batch query or missing contentState leaves items untouched and never fails the run", async () => {
    const runChild = async () => ({ code: 1, stdout: "", stderr: "rate limited" });
    const items = [
      { itemId: "I_1", issueNumber: 1, prNumber: null, status: "Backlog", contentState: "OPEN" },
      { itemId: "I_2", issueNumber: 2, prNumber: null, status: "Backlog" },
    ];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild });
    assert.deepEqual(facts.get("I_1"), UNTOUCHED);
    assert.deepEqual(facts.get("I_2"), UNTOUCHED);
    const moveCalls = [];
    const result = await run({ items, facts: [...facts], moveCalls });
    assert.equal(result.ok, true);
    assert.equal(result.moved, 0);
  });

  it("a 150-item board makes at most 15 gh calls and no issue view or pr view", async () => {
    const calls = [];
    const board = [];
    for (let n = 1; n <= 144; n++) board.push({ id: `PVTI_${n}`, number: n, typename: "Issue", state: "OPEN" });
    for (let n = 1001; n <= 1006; n++) board.push({ id: `PVTI_${n}`, number: n, typename: "PullRequest", state: "MERGED" });
    const nodes = board.map((b) => ({
      id: b.id,
      fieldValues: { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: "Backlog" }] },
      content: { __typename: b.typename, id: `c${b.number}`, number: b.number, title: "t", url: `https://x/${b.number}`, state: b.state },
    }));
    const runChild = async (cmd, argv) => {
      calls.push(argv);
      const query = argv.find((a) => a.startsWith("query=")) ?? "";
      let payload;
      if (query.includes(": issue(number:")) {
        const repository = {};
        for (let n = 1; n <= 144; n++) if (query.includes(`i${n}: issue(`)) repository[`i${n}`] = batchTimeline(n === 7 ? [crossRef(900)] : n === 120 ? [crossRef(901)] : []);
        payload = { data: { repository } };
      } else if (query.includes("projectsV2")) {
        payload = { data: { user: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PVT_1", number: 7, title: "Q", url: "u" }] } } } };
      } else if (query.includes("fields(")) {
        payload = { data: { node: { fields: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PVTSSF_status", name: "Status", options: [{ id: "o1", name: "Backlog" }, { id: "o2", name: "In Progress" }, { id: "o3", name: "Done" }] }] } } } };
      } else if (query.includes("items(")) {
        payload = { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
      } else {
        payload = { data: { user: { id: "U_1" } } };
      }
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    };
    const moveCalls = [];
    const result = await main(
      { repo: "o/r", project: "7" },
      { env: {}, runChild, skipTerminalColumn: true, moveItem: async (a) => { moveCalls.push(a); return { ok: true }; } },
    );
    assert.equal(result.ok, true);
    assert.ok(calls.length <= 15, `made ${calls.length} gh calls`);
    assert.ok(calls.every((argv) => argv[0] !== "issue" && argv[0] !== "pr"));
    // Issues 7 (chunk 1) and 120 (chunk 3) move to In Progress and the six merged PR items move to Done.
    assert.equal(moveCalls.length, 8);
  });

  it("resolves .devloops boardTitle when --project is omitted and forwards projectTitle to list/move", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reconcile-board-"));
    try {
      writeFileSync(path.join(dir, ".devloops"), 'tracker:\n  board:\n    title: "My Board"\n');

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

  // Regression (#1227): reconcile passes the item's stable node id straight
  // through to the REAL move-queue-item main() (moveItem left undefined here,
  // unlike the mocked-moveItem tests above), so this exercises the actual
  // --item validator end to end against a live-shaped node ID with a hyphen
  // in its base64url payload. Only `gh` (runChild) is mocked, per house seams.
  it("reconcile end-to-end moves an item whose node ID contains a hyphen (real move-queue-item validator)", async () => {
    const hyphenId = "PVTI_lAHOAAT8js4BaBePzgxz5-I";
    const items = [{ itemId: hyphenId, issueNumber: 1196, prNumber: null, status: "Backlog" }];

    const ghResponses = [
      { data: { user: { id: "U_kgDOABC123" } } },
      {
        data: {
          user: {
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "PVT_proj1", number: 7, title: "Dev Loop Queue", url: "https://github.com/users/o/projects/7" }],
            },
          },
        },
      },
      {
        data: {
          node: {
            fields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: "PVTSSF_status",
                name: "Status",
                options: [{ id: "opt-backlog", name: "Backlog" }, { id: "opt-progress", name: "In Progress" }],
              }],
            },
          },
        },
      },
      {
        // Direct item node lookup (`node(id)` as a ProjectV2Item on the project).
        data: {
          node: {
            id: hyphenId,
            isArchived: false,
            project: { id: "PVT_proj1" },
            fieldValues: { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: "Backlog" }] },
            content: { __typename: "Issue", number: 1196, repository: { nameWithOwner: "o/r" } },
          },
        },
      },
      { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: hyphenId } } } },
    ];
    let ghCall = 0;
    const runChild = async (cmd, argv, _env) => {
      if (ghCall >= ghResponses.length) {
        throw new Error(`Unexpected gh call #${ghCall + 1} (only ${ghResponses.length} mocked): ${cmd} ${argv.join(" ")}`);
      }
      const payload = ghResponses[ghCall++];
      return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
    };

    const result = await main(
      { repo: "o/r", project: "7" },
      {
        env: {},
        runChild,
        listItems: async () => ({ items }),
        gatherFacts: async () => new Map([[hyphenId, READY_LINKED_PR]]),
        // moveItem intentionally omitted → real move-queue-item main() runs.
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.moved, 1);
    assert.deepEqual(result.reconciled, [{ number: 1196, from: "Backlog", to: "In Progress", ok: true }]);
  });
});
