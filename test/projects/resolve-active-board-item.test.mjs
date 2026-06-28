import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collapseToTarget, runCli } from "../../scripts/projects/resolve-active-board-item.mjs";

// A runChild stub that drives list-queue-items end to end with an EMPTY board
// (zero In-Progress items), so the resolver fails closed. Matches on the
// GraphQL query substring to answer each step.
function emptyBoardRunChild() {
  return async (_cmd, argv) => {
    const query = (argv.find((a) => a.startsWith("query=")) ?? "");
    const json = (data) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
    if (query.includes("projectsV2(first")) {
      return json({ user: { projectsV2: { nodes: [{ id: "P_1", number: 7, title: "Board" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("user(login")) return json({ user: { id: "U_1" } });
    if (query.includes("fields(first")) {
      return json({ node: { fields: { nodes: [{ name: "Status", options: [{ id: "O_1", name: "In Progress" }] }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    // items query -> empty
    return json({ node: { items: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
}

function captureCli(extraArgs = []) {
  let out = "";
  let err = "";
  const prev = process.exitCode;
  process.exitCode = undefined;
  return runCli(["--repo", "o/r", "--project", "7", ...extraArgs], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    runChild: emptyBoardRunChild(),
  }).then(() => {
    const code = process.exitCode;
    process.exitCode = prev;
    return { code, out, err };
  });
}

describe("resolve-active-board-item collapseToTarget (#988)", () => {
  it("exactly one issue item -> that issue target", () => {
    const r = collapseToTarget([{ issueNumber: 42, prNumber: null, title: "Do thing" }]);
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 } });
  });

  it("exactly one item with a linked PR -> prefers the PR target", () => {
    const r = collapseToTarget([{ issueNumber: 42, prNumber: 99, title: "Do thing" }]);
    assert.deepEqual(r, { ok: true, target: { kind: "pr", number: 99 } });
  });

  it("zero items -> fail closed asking for explicit #N", () => {
    const r = collapseToTarget([]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /No in-progress board item/);
    assert.match(r.reason, /\/continue #N/);
    assert.equal(r.target, undefined);
  });

  it("multiple items -> fail closed naming the items", () => {
    const r = collapseToTarget([
      { issueNumber: 42, prNumber: null, title: "First" },
      { issueNumber: null, prNumber: 7, title: "Second" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /2 in-progress board items/);
    assert.match(r.reason, /issue #42 \(First\)/);
    assert.match(r.reason, /PR #7 \(Second\)/);
    assert.match(r.reason, /disambiguate/);
  });
});

describe("resolve-active-board-item CLI exit codes (#988)", () => {
  it("fail closed (zero items), unfiltered -> exit 3 with the reason on stdout", async () => {
    const { code, out } = await captureCli();
    assert.equal(code, 3);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /No in-progress board item/);
  });

  it("fail closed under --silent -> jq-output contract exit 1 (not 3)", async () => {
    const { code, out } = await captureCli(["--silent"]);
    assert.equal(code, 1);
    assert.equal(out, "");
  });
});
