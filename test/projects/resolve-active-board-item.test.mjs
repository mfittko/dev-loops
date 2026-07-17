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
//
// Ownership gate (#1377): `assignees` maps an issue/PR number to its current
// assignees (defaults to `[]`, i.e. unassigned, for any number not listed).
// `assigneesSequence` maps a number to an ARRAY of assignee-lists consumed in
// order across successive view calls for that number (last entry repeats once
// exhausted) — lets a test simulate a concurrent claim race: first read
// unassigned, second read (the post-claim re-verify) shows a contender who
// claimed concurrently. Falls back to `assignees` when no sequence is given.
// `viewerLoginError` forces `gh api user` to fail (viewer-login resolution
// failure). `claims` (mutated in place) records every `issue/pr edit
// --add-assignee|--remove-assignee @me` call as `{kind, number, action}`.
function boardRunChild({
  columns = {},
  itemsError = false,
  optionNames = ["Backlog", "Next Up", "In Progress", "Done"],
  assignees = {},
  assigneesSequence = {},
  viewerLogin = "test-viewer",
  viewerLoginError = false,
  claims = [],
} = {}) {
  let itemsQueryCount = 0;
  const viewCallCounts = {};
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
    if (argv[0] === "api" && argv[1] === "user") {
      if (viewerLoginError) return { code: 1, stdout: "", stderr: "gh: not authenticated\n" };
      return { code: 0, stdout: JSON.stringify({ login: viewerLogin }), stderr: "" };
    }
    if ((argv[0] === "issue" || argv[0] === "pr") && argv[1] === "view") {
      const number = Number(argv[2]);
      const seq = assigneesSequence[number];
      let list = assignees[number] ?? [];
      if (Array.isArray(seq)) {
        const idx = viewCallCounts[number] ?? 0;
        viewCallCounts[number] = idx + 1;
        list = seq[Math.min(idx, seq.length - 1)] ?? [];
      }
      return { code: 0, stdout: JSON.stringify({ assignees: list }), stderr: "" };
    }
    if ((argv[0] === "issue" || argv[0] === "pr") && argv[1] === "edit") {
      const number = Number(argv[2]);
      const action = argv.includes("--remove-assignee") ? "remove-assignee" : "add-assignee";
      claims.push({ kind: argv[0], number, action });
      return { code: 0, stdout: "{}", stderr: "" };
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

describe("resolve-active-board-item Next Up single-contributor ownership gate (#1377)", () => {
  it("claims (@me) an unassigned Next Up head item as part of pickup", async () => {
    const claims = [];
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assignees: { 7: [] },
      claims,
    }));
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
    assert.deepEqual(claims, [{ kind: "issue", number: 7, action: "add-assignee" }]);
  });

  it("does NOT claim an item already assigned to the viewer", async () => {
    const claims = [];
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assignees: { 7: [{ login: "test-viewer" }] },
      viewerLogin: "test-viewer",
      claims,
    }));
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
    assert.deepEqual(claims, []);
  });

  it("skips a Next Up item assigned to another human, reports the skip reason, and picks + claims the next unassigned item", async () => {
    const claims = [];
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [
        { issueNumber: 7, title: "Foreign" },
        { issueNumber: 8, title: "Free" },
      ] },
      assignees: { 7: [{ login: "someone-else" }], 8: [] },
      claims,
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.target, { kind: "issue", number: 8 });
    assert.equal(r.source, "next-up");
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /issue #7 \(Foreign\) is assigned to someone-else, not the current viewer/);
    assert.deepEqual(claims, [{ kind: "issue", number: 8, action: "add-assignee" }]);
  });

  it("fails closed when every Next Up item is owned by another human", async () => {
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [
        { issueNumber: 7, title: "Foreign one" },
        { prNumber: 9, title: "Foreign two" },
      ] },
      assignees: { 7: [{ login: "someone-else" }], 9: [{ login: "another-dev" }] },
    }));
    assert.equal(r.ok, false);
    assert.equal(r.source, "next-up");
    assert.equal(r.skipped.length, 2);
    assert.match(r.reason, /issue #7 \(Foreign one\) is assigned to someone-else/);
    assert.match(r.reason, /PR #9 \(Foreign two\) is assigned to another-dev/);
  });

  it("a copilot-assigned Next Up item is picked as-is (no claim, no viewer-login lookup)", async () => {
    const claims = [];
    let apiUserCalls = 0;
    const child = boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Copilot" }] },
      assignees: { 7: [{ login: "copilot-swe-agent" }] },
      claims,
    });
    const wrapped = async (cmd, argv) => {
      if (argv[0] === "api" && argv[1] === "user") apiUserCalls += 1;
      return child(cmd, argv);
    };
    const r = await runArgs(wrapped);
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
    assert.deepEqual(claims, []);
    assert.equal(apiUserCalls, 0);
  });

  it("resolves the current viewer's login only once, even across multiple candidates", async () => {
    let apiUserCalls = 0;
    const claims = [];
    const child = boardRunChild({
      columns: { "In Progress": [], "Next Up": [
        { issueNumber: 7, title: "Foreign" },
        { issueNumber: 8, title: "Free" },
      ] },
      assignees: { 7: [{ login: "someone-else" }], 8: [] },
      claims,
    });
    const wrapped = async (cmd, argv) => {
      if (argv[0] === "api" && argv[1] === "user") apiUserCalls += 1;
      return child(cmd, argv);
    };
    await runArgs(wrapped);
    assert.equal(apiUserCalls, 1);
  });

  it("post-claim re-verify: claim contested but the viewer wins the deterministic tiebreak -> proceeds, no self-unassign", async () => {
    const claims = [];
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      // First read: unassigned -> claim. Second read (post-claim re-verify):
      // another looper landed "zzz-other" concurrently. "test-viewer" sorts
      // before "zzz-other", so the viewer wins the tiebreak.
      assigneesSequence: { 7: [[], [{ login: "test-viewer" }, { login: "zzz-other" }]] },
      viewerLogin: "test-viewer",
      claims,
    }));
    assert.deepEqual(r, { ok: true, target: { kind: "issue", number: 7 }, source: "next-up" });
    assert.deepEqual(claims, [{ kind: "issue", number: 7, action: "add-assignee" }]);
  });

  it("post-claim re-verify: claim contested and the viewer LOSES the tiebreak -> self-unassigns, skips with claim_contested_lost_tiebreak, and picks the next item", async () => {
    const claims = [];
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [
        { issueNumber: 7, title: "Contested" },
        { issueNumber: 8, title: "Free" },
      ] },
      // "aaa-other" sorts before "test-viewer" -> the viewer loses.
      assigneesSequence: { 7: [[], [{ login: "test-viewer" }, { login: "aaa-other" }]] },
      assignees: { 8: [] },
      viewerLogin: "test-viewer",
      claims,
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.target, { kind: "issue", number: 8 });
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /issue #7 \(Contested\) claim contested by aaa-other/);
    assert.match(r.skipped[0].reason, /claim_contested_lost_tiebreak/);
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee" },
      { kind: "issue", number: 7, action: "remove-assignee" },
      { kind: "issue", number: 8, action: "add-assignee" },
    ]);
  });

  it("post-claim re-read failure fails closed (does not silently trust the claim call alone)", async () => {
    const child = boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assignees: { 7: [] },
    });
    let viewCallsFor7 = 0;
    const wrapped = async (cmd, argv) => {
      if (argv[0] === "issue" && argv[1] === "view" && Number(argv[2]) === 7) {
        viewCallsFor7 += 1;
        if (viewCallsFor7 === 2) {
          return { code: 1, stdout: "", stderr: "boom: gh outage" };
        }
      }
      return child(cmd, argv);
    };
    await assert.rejects(() => runArgs(wrapped), /gh issue view 7 failed/);
  });

  it("fails closed when the viewer login cannot be resolved (distinct reason from an assignee-read failure)", async () => {
    await assert.rejects(
      () => runArgs(boardRunChild({
        columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
        assignees: { 7: [{ login: "someone-else" }] },
        viewerLoginError: true,
      })),
      /Unable to resolve the current GitHub viewer login/,
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
