import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { collapseToTarget, main, runCli } from "../../scripts/projects/resolve-active-board-item.mjs";

// Isolated default cwd (no .devloops): main() resolves statusColumns from cwd,
// so tests must never read THIS repo's real config as a hidden dependency —
// a future repo-level statusColumns override would silently break them.
const ISOLATED_CWD = mkdtempSync(nodePath.join(tmpdir(), "resolve-active-isolated-"));
after(() => rmSync(ISOLATED_CWD, { recursive: true, force: true }));

// A runChild stub that drives list-queue-items end to end. `columns` maps a
// Status column name to the items GraphQL returns for it; list-queue-items
// fetches the whole board and filters client-side, so we return every column's
// items (each tagged with its own Status field value) on the items query and let
// the resolver's --column filter pick. `itemsError` forces only the SECOND items
// query to fail (the resolver queries In Progress first, then Next Up), so the
// In Progress query succeeds and only the Next Up query errors / hits an outage.
function boardRunChild({ columns = {}, itemsError = false, optionNames = ["Backlog", "Next Up", "In Progress", "Done"] } = {}) {
  let itemsQueryCount = 0;
  const options = optionNames.map((name, i) => ({ id: `O_${i}`, name }));
  const nodes = [];
  for (const [status, items] of Object.entries(columns)) {
    for (const it of items) {
      const isPr = it.prNumber != null;
      nodes.push({
        id: `I_${status}_${it.issueNumber ?? it.prNumber}`,
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
  return async (_cmd, argv) => {
    const query = argv.find((a) => a.startsWith("query=")) ?? "";
    const json = (data) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
    if (query.includes("projectsV2(first")) {
      return json({ user: { projectsV2: { nodes: [{ id: "P_1", number: 7, title: "Board" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("user(login")) return json({ user: { id: "U_1" } });
    if (query.includes("fields(first")) {
      return json({ node: { fields: { nodes: [{ name: "Status", options }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    // items query — fail only the second one (Next Up), leaving In Progress OK
    itemsQueryCount += 1;
    if (itemsError && itemsQueryCount === 2) return { code: 1, stdout: "", stderr: "boom: API unreachable" };
    return json({ node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
}

const runArgs = (child) => main({ repo: "o/r", project: "7" }, { runChild: child, cwd: ISOLATED_CWD });

function captureCli(child, extraArgs = []) {
  let out = "";
  let err = "";
  const prev = process.exitCode;
  process.exitCode = undefined;
  return runCli(["--repo", "o/r", "--project", "7", ...extraArgs], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    runChild: child,
    cwd: ISOLATED_CWD,
  }).then(() => {
    const code = process.exitCode;
    process.exitCode = prev;
    return { code, out, err };
  });
}

describe("resolve-active-board-item collapseToTarget (#988)", () => {
  it("exactly one issue item -> that issue target, source in-progress", () => {
    const r = collapseToTarget([{ issueNumber: 42, prNumber: null, title: "Do thing" }]);
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 }, source: "in-progress" });
  });

  it("exactly one item with a linked PR -> prefers the PR target", () => {
    const r = collapseToTarget([{ issueNumber: 42, prNumber: 99, title: "Do thing" }]);
    assert.deepEqual(r, { ok: true, target: { kind: "pr", number: 99 }, source: "in-progress" });
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

describe("resolve-active-board-item main — In Progress vs Next Up (#1091)", () => {
  it("exactly one In Progress -> that target (unchanged), source in-progress", async () => {
    const r = await runArgs(boardRunChild({ columns: {
      "In Progress": [{ issueNumber: 42, title: "Active" }],
      "Next Up": [{ issueNumber: 7, title: "Later" }],
    } }));
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 }, source: "in-progress" });
  });

  it("multiple In Progress -> still fail closed (never guesses Next Up)", async () => {
    const r = await runArgs(boardRunChild({ columns: {
      "In Progress": [{ issueNumber: 42, title: "A" }, { issueNumber: 43, title: "B" }],
      "Next Up": [{ issueNumber: 7, title: "Later" }],
    } }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /2 in-progress board items/);
    assert.equal(r.source, undefined);
  });

  it("zero In Progress + Next Up has items -> Next Up HEAD by position, source next-up", async () => {
    const r = await runArgs(boardRunChild({ columns: {
      "In Progress": [],
      // list-queue-items preserves GraphQL position order; head is #7.
      "Next Up": [{ issueNumber: 7, title: "Head" }, { issueNumber: 8, title: "Tail" }],
    } }));
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
  });

  it("zero In Progress + Next Up head is a PR -> prefers the PR target", async () => {
    const r = await runArgs(boardRunChild({ columns: {
      "In Progress": [],
      "Next Up": [{ prNumber: 99, title: "Head PR" }],
    } }));
    assert.deepEqual(r, { ok: true, target: { kind: "pr", number: 99 }, source: "next-up" });
  });

  it("zero In Progress + empty Next Up -> fail closed with canonical message, NO Backlog pickup", async () => {
    const r = await runArgs(boardRunChild({ columns: {
      "In Progress": [],
      "Next Up": [],
      // Backlog has items but MUST NOT be picked up.
      "Backlog": [{ issueNumber: 500, title: "Never me" }],
    } }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "queue empty — prioritize Backlog items into Next Up");
    assert.equal(r.source, "next-up");
    assert.equal(r.target, undefined);
  });

  it("zero In Progress + Next Up query error -> fail closed (throws), no fallback", async () => {
    // In Progress query succeeds (empty), Next Up query errors -> propagate.
    await assert.rejects(
      () => runArgs(boardRunChild({ columns: { "In Progress": [] }, itemsError: true })),
      /gh api graphql failed/,
    );
  });
});

describe("resolve-active-board-item CLI exit codes", () => {
  it("Next Up head resolved, unfiltered -> exit 0 with the target on stdout", async () => {
    const { code, out } = await captureCli(boardRunChild({ columns: {
      "In Progress": [],
      "Next Up": [{ issueNumber: 7, title: "Head" }],
    } }));
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
  });

  it("empty Next Up fail closed, unfiltered -> exit 3 with the canonical reason", async () => {
    const { code, out } = await captureCli(boardRunChild({ columns: { "In Progress": [], "Next Up": [] } }));
    assert.equal(code, 3);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "queue empty — prioritize Backlog items into Next Up");
  });

  it("empty Next Up fail closed under --silent -> jq-output contract exit 1 (not 3)", async () => {
    const { code, out } = await captureCli(
      boardRunChild({ columns: { "In Progress": [], "Next Up": [] } }),
      ["--silent"],
    );
    assert.equal(code, 1);
    assert.equal(out, "");
  });

  it("Next Up query error, unfiltered -> exit 2 (GH API error surfaced on stderr)", async () => {
    const { code, err } = await captureCli(boardRunChild({ columns: { "In Progress": [] }, itemsError: true }));
    assert.equal(code, 2);
    const parsed = JSON.parse(err);
    assert.equal(parsed.ok, false);
  });
});

describe("resolve-active-board-item resolves the configured next_up column (#1098)", () => {
  async function withTempCwd(contents, fn) {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "resolve-active-statuscol-"));
    try {
      if (contents !== null) writeFileSync(nodePath.join(dir, ".devloops"), contents, "utf-8");
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("pickup queries the overridden statusColumns.next_up column (\"Todo\"), not the literal", async () => {
    await withTempCwd('queue:\n  projectNumber: 7\n  statusColumns:\n    next_up: "Todo"\n', async (cwd) => {
      // Head item lives ONLY in the renamed "Todo" column. If the resolver still
      // queried the literal "Next Up", it would see an empty column and fail
      // closed — so a resolved target proves it queried the configured name.
      const child = boardRunChild({
        optionNames: ["Backlog", "Todo", "In Progress", "Done"],
        columns: { "In Progress": [], "Todo": [{ issueNumber: 42, title: "Head" }] },
      });
      const r = await main({ repo: "o/r", project: "7" }, { runChild: child, cwd });
      assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 }, source: "next-up" });
    });
  });

  it("default config (no override) still resolves the literal \"Next Up\"", async () => {
    await withTempCwd(null, async (cwd) => {
      const child = boardRunChild({
        columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      });
      const r = await main({ repo: "o/r", project: "7" }, { runChild: child, cwd });
      assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
    });
  });

  it("malformed .devloops → pickup fails CLOSED (surfaces config error), never queries the literal \"Next Up\"", async () => {
    // Zero In Progress → falls through to resolveNextUpHead, which must throw on
    // an un-parseable config rather than silently querying the default column.
    await withTempCwd("queue: renamed\n- broken\n", async (cwd) => {
      const child = boardRunChild({
        columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      });
      await assert.rejects(
        () => main({ repo: "o/r", project: "7" }, { runChild: child, cwd }),
        /config read\/parse error/,
      );
    });
  });
});

describe("resolve-active-board-item resolves the configured in_progress column (#1143)", () => {
  async function withTempCwd(contents, fn) {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "resolve-active-statuscol-inprogress-"));
    try {
      if (contents !== null) writeFileSync(nodePath.join(dir, ".devloops"), contents, "utf-8");
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("pickup queries the overridden statusColumns.in_progress column (\"Doing\"), not the literal", async () => {
    await withTempCwd('queue:\n  projectNumber: 7\n  statusColumns:\n    in_progress: "Doing"\n', async (cwd) => {
      // The single active item lives ONLY in the renamed "Doing" column. If the
      // resolver still queried the literal "In Progress", it would see an empty
      // column and fall through to Next Up instead — proving misdetection.
      const child = boardRunChild({
        optionNames: ["Backlog", "Next Up", "Doing", "Done"],
        columns: { "Doing": [{ issueNumber: 42, title: "Active" }], "Next Up": [{ issueNumber: 7, title: "Later" }] },
      });
      const r = await main({ repo: "o/r", project: "7" }, { runChild: child, cwd });
      assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 }, source: "in-progress" });
    });
  });

  it("default config (no override) still resolves the literal \"In Progress\"", async () => {
    await withTempCwd(null, async (cwd) => {
      const child = boardRunChild({
        columns: { "In Progress": [{ issueNumber: 42, title: "Active" }], "Next Up": [] },
      });
      const r = await main({ repo: "o/r", project: "7" }, { runChild: child, cwd });
      assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 42 }, source: "in-progress" });
    });
  });

  it("malformed .devloops → pickup fails CLOSED (surfaces config error), never queries the literal \"In Progress\"", async () => {
    await withTempCwd("queue: renamed\n- broken\n", async (cwd) => {
      const child = boardRunChild({
        columns: { "In Progress": [{ issueNumber: 42, title: "Active" }], "Next Up": [] },
      });
      await assert.rejects(
        () => main({ repo: "o/r", project: "7" }, { runChild: child, cwd }),
        /config read\/parse error/,
      );
    });
  });
});
