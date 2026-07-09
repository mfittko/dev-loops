import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { main, parseCliArgs } from "../../scripts/projects/list-parked-unrefined-items.mjs";

// Isolated default cwd (no .devloops): main() resolves the park column
// (nonSuccessBoardColumn) from cwd, so the default park column is "Backlog".
const ISOLATED_CWD = mkdtempSync(nodePath.join(tmpdir(), "parked-unrefined-isolated-"));
after(() => rmSync(ISOLATED_CWD, { recursive: true, force: true }));

const REFINED_BODY = "## Acceptance criteria\n- [ ] It does the thing\n";
const UNREFINED_BODY = "Just some prose describing a problem. No ACs, no DoD.";

// runChild stub: drives list-queue-items (GraphQL) AND the per-issue
// `gh issue view … --json body` body fetch. `columns` maps a Status column
// name to its items; `bodies` maps an issue number to its body Markdown.
function boardRunChild({ columns = {}, bodies = {}, optionNames = ["Backlog", "Next Up", "In Progress", "Done"] } = {}) {
  const options = optionNames.map((name, i) => ({ id: `O_${i}`, name }));
  const nodes = [];
  for (const [status, items] of Object.entries(columns)) {
    for (const it of items) {
      const isPr = it.prNumber != null;
      nodes.push({
        id: `ITEM_${status}_${it.issueNumber ?? it.prNumber}`,
        fieldValues: { nodes: [{ field: { name: "Status" }, name: status }] },
        content: {
          __typename: isPr ? "PullRequest" : "Issue",
          number: isPr ? it.prNumber : it.issueNumber,
          title: it.title ?? null,
          url: "https://example.test",
          id: "C_1",
        },
      });
    }
  }
  return async (cmd, argv) => {
    if (cmd === "gh" && argv[0] === "issue" && argv[1] === "view") {
      const number = Number(argv[2]);
      const body = bodies[number] ?? "";
      return { code: 0, stdout: JSON.stringify({ body }), stderr: "" };
    }
    const query = argv.find((a) => a.startsWith("query=")) ?? "";
    const json = (data) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
    if (query.includes("projectsV2(first")) {
      return json({ user: { projectsV2: { nodes: [{ id: "P_1", number: 7, title: "Board" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("user(login")) return json({ user: { id: "U_1" } });
    if (query.includes("fields(first")) {
      return json({ node: { fields: { nodes: [{ name: "Status", options }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    return json({ node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
}

const run = (child) => main({ repo: "o/r", project: "7" }, { runChild: child, cwd: ISOLATED_CWD });

describe("list-parked-unrefined-items (#1258 discovery helper)", () => {
  it("returns un-refined issues parked in the park column, with reason + missing", async () => {
    const r = await run(boardRunChild({
      columns: { Backlog: [{ issueNumber: 42, title: "Un-refined" }] },
      bodies: { 42: UNREFINED_BODY },
    }));
    assert.equal(r.ok, true);
    assert.equal(r.parkedColumn, "Backlog");
    assert.equal(r.items.length, 1);
    const [item] = r.items;
    assert.equal(item.issueNumber, 42);
    assert.equal(item.title, "Un-refined");
    assert.equal(item.finding, "missing_refinement_artifact");
    assert.match(item.reason, /no Acceptance criteria/i);
    assert.deepEqual(item.missing, [
      "Acceptance criteria section",
      "Definition of done section",
      "linked refinement doc",
    ]);
  });

  it("excludes refined issues (the fail-safe only parks un-refined ones)", async () => {
    const r = await run(boardRunChild({
      columns: { Backlog: [
        { issueNumber: 42, title: "Un-refined" },
        { issueNumber: 43, title: "Refined" },
      ] },
      bodies: { 42: UNREFINED_BODY, 43: REFINED_BODY },
    }));
    assert.deepEqual(r.items.map((i) => i.issueNumber), [42]);
  });

  it("excludes PRs (the refinement gate is issue-only) — no body fetch for them", async () => {
    const r = await run(boardRunChild({
      columns: { Backlog: [{ prNumber: 99, title: "A PR" }] },
      bodies: {},
    }));
    assert.deepEqual(r.items, []);
  });

  it("empty park column -> empty list, ok:true", async () => {
    const r = await run(boardRunChild({ columns: { Backlog: [], "Next Up": [{ issueNumber: 7, title: "Live" }] } }));
    assert.deepEqual(r, { ok: true, parkedColumn: "Backlog", items: [] });
  });

  it("fail path: an issue still un-refined after a grill attempt stays surfaced with a recorded reason (orchestrator keeps it parked, does not force Next Up)", async () => {
    // Grill ran but produced no usable artifact -> body is unchanged (still no
    // AC/DoD/linked doc). The helper must keep reporting it so the orchestrator
    // re-parks it (re-enqueue --auto diverts to park) rather than promoting it.
    const r = await run(boardRunChild({
      columns: { Backlog: [{ issueNumber: 42, title: "Grill produced nothing" }] },
      bodies: { 42: UNREFINED_BODY },
    }));
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].issueNumber, 42);
    assert.equal(r.items[0].finding, "missing_refinement_artifact");
    assert.ok(typeof r.items[0].reason === "string" && r.items[0].reason.length > 0);
  });

  it("requires --repo (proper usage error, not a downstream failure)", () => {
    assert.throws(() => parseCliArgs(["--project", "7"]), (e) => e.code === "INVALID_REPO" && /--repo is required/.test(e.message));
    // --help short-circuits the requirement.
    assert.equal(parseCliArgs(["--help"]).help, true);
  });

  it("propagates a gh issue-view failure (fails closed, not silently empty)", async () => {
    const child = boardRunChild({
      columns: { Backlog: [{ issueNumber: 42, title: "Un-refined" }] },
      bodies: { 42: UNREFINED_BODY },
    });
    const failing = async (cmd, argv, env) => {
      if (cmd === "gh" && argv[0] === "issue" && argv[1] === "view") {
        return { code: 1, stdout: "", stderr: "gh: not found" };
      }
      return child(cmd, argv, env);
    };
    await assert.rejects(run(failing), /gh command failed/);
  });

  it("resolves the configured non-success park column from .devloops", async () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "parked-unrefined-parkcol-"));
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(nodePath.join(dir, ".devloops"), 'queue:\n  projectNumber: 7\n  nonSuccessStatus: "Parked"\n', "utf-8");
      const child = boardRunChild({
        optionNames: ["Backlog", "Parked", "Next Up", "In Progress", "Done"],
        // The un-refined issue lives ONLY in the renamed park column; if the
        // helper queried the literal "Backlog" it would miss it.
        columns: { Parked: [{ issueNumber: 42, title: "Parked un-refined" }] },
        bodies: { 42: UNREFINED_BODY },
      });
      const r = await main({ repo: "o/r", project: "7" }, { runChild: child, cwd: dir });
      assert.equal(r.parkedColumn, "Parked");
      assert.deepEqual(r.items.map((i) => i.issueNumber), [42]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
