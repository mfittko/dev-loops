import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, gatherLiveFacts } from "../../scripts/projects/reconcile-queue.mjs";

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

  it("gatherLiveFacts with doneColumn skips a Done-status item (zero gh calls) but still gathers a non-Done item", async () => {
    const calls = [];
    const runChild = async (cmd, argv) => {
      calls.push({ cmd, argv });
      // Minimal shape for `issue view --json state` on the non-Done item.
      return { code: 0, stdout: JSON.stringify({ state: "CLOSED" }), stderr: "" };
    };
    const items = [
      { itemId: "I_done", issueNumber: 1, prNumber: null, status: "Done" },
      { itemId: "I_backlog", issueNumber: 2, prNumber: null, status: "Backlog" },
    ];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild, doneColumn: "Done" });
    // Done item never fetched → absent from the facts Map (planReconcile leaves it in place).
    assert.equal(facts.has("I_done"), false);
    // Non-Done item still gathered.
    assert.equal(facts.has("I_backlog"), true);
    // Every gh call was for the non-Done issue #2, none for the Done item #1.
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.argv.includes("2")));
    assert.ok(calls.every((c) => !c.argv.includes("1")));
  });

  it("#1128-shaped: a PR that only body-mentions a sibling issue does NOT link it (no move) [#1130]", async () => {
    // Live shape of the regression: open PR #1128 closes issue A but merely
    // body-mentions siblings B/C. gatherLiveFacts must resolve B as having NO
    // linked open PR, so it derives null and is left untouched — otherwise the
    // resolver sees multiple in-progress and fails closed.
    const prViewCalls = [];
    const runChild = async (cmd, argv) => {
      if (argv.includes("graphql")) {
        // detectLinkedIssuePr timeline query: only a bare body-mention xref
        // (willCloseTarget:false) references this sibling issue.
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        __typename: "CrossReferencedEvent",
                        createdAt: "2026-05-12T10:00:00Z",
                        willCloseTarget: false,
                        source: {
                          __typename: "PullRequest",
                          number: 1128,
                          state: "OPEN",
                          url: "https://github.com/o/r/pull/1128",
                          repository: { nameWithOwner: "o/r" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (argv.includes("pr") && argv.includes("view")) {
        prViewCalls.push(argv);
        return { code: 0, stdout: JSON.stringify({ state: "OPEN", isDraft: false, mergedAt: null }), stderr: "" };
      }
      // issue view --json state
      return { code: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    };

    const items = [{ itemId: "I_B", issueNumber: 1084, prNumber: null, status: "Backlog" }];
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild });

    // Body-mention only → not linked → inert facts → deriveReconcileColumn yields null.
    assert.deepEqual(facts.get("I_B"), { itemKind: "issue", issueState: "OPEN", prState: null, prIsDraft: null });
    // The mentioning PR must never be fetched as an owning link.
    assert.equal(prViewCalls.length, 0);

    // End-to-end through main(): the sibling stays put (zero moves).
    const moveCalls = [];
    const result = await run({ items, facts: [...facts], moveCalls });
    assert.equal(result.moved, 0);
    assert.equal(moveCalls.length, 0);
  });

  it("gatherLiveFacts WITHOUT doneColumn gathers a Done-status item (explicit-run recovery)", async () => {
    const calls = [];
    const runChild = async (cmd, argv) => {
      calls.push({ cmd, argv });
      return { code: 0, stdout: JSON.stringify({ state: "CLOSED" }), stderr: "" };
    };
    const items = [{ itemId: "I_done", issueNumber: 1, prNumber: null, status: "Done" }];
    // No doneColumn (explicit `dev-loops queue reconcile`) → the Done item IS gathered.
    const facts = await gatherLiveFacts(items, "o/r", { env: {}, runChild });
    assert.equal(facts.has("I_done"), true);
    assert.ok(calls.some((c) => c.argv.includes("1")));
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
        data: {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: hyphenId,
                fieldValues: { nodes: [{ field: { id: "PVTSSF_status", name: "Status" }, name: "Backlog" }] },
                content: { __typename: "Issue", number: 1196, repository: { nameWithOwner: "o/r" } },
              }],
            },
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
