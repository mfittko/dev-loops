import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { collapseToTarget, main, runCli, attemptClaimAndArbitrate } from "../../scripts/projects/resolve-active-board-item.mjs";

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
// --add-assignee|--remove-assignee` call as `{kind, number, action, logins}`
// (`logins` is `@me` for a self claim/unclaim, or the actual login(s) the
// tiebreak WINNER removes from a contested claim).
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
      const loginsAfterFlag = (flag) => argv.reduce((acc, a, i) => (argv[i - 1] === flag ? [...acc, a] : acc), []);
      const removed = loginsAfterFlag("--remove-assignee");
      const added = loginsAfterFlag("--add-assignee");
      const action = removed.length > 0 ? "remove-assignee" : "add-assignee";
      claims.push({ kind: argv[0], number, action, logins: removed.length > 0 ? removed : added });
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
    assert.deepEqual(claims, [{ kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] }]);
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
    assert.deepEqual(claims, [{ kind: "issue", number: 8, action: "add-assignee", logins: ["@me"] }]);
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

  it("post-claim re-verify: claim contested but the viewer wins the deterministic tiebreak -> proceeds and removes the loser's login (claim_contested_won_tiebreak)", async () => {
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
    assert.equal(r.ok, true);
    assert.deepEqual(r.target, { kind: "issue", number: 7 });
    assert.equal(r.source, "next-up");
    assert.match(r.claimNote, /issue #7 \(Head\) claim was contested by zzz-other/);
    assert.match(r.claimNote, /claim_contested_won_tiebreak/);
    // Convergence: the winner removes the raced-past contender so the item
    // leaves pickup solely-owned — that contender's later startup re-read
    // then sees only the winner, not itself, and fails closed as foreign.
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["zzz-other"] },
    ]);
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
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
      { kind: "issue", number: 8, action: "add-assignee", logins: ["@me"] },
    ]);
  });

  it("post-claim re-read shows ONLY another human (our own claim not yet visible) -> not our item to arbitrate: no tiebreak, no removal, best-effort self-unclaim, fails closed with claim_not_visible_post_read", async () => {
    const claims = [];
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      // First read: unassigned -> claim. Second read (post-claim re-verify):
      // read-after-write lag / a degraded claim means OUR OWN @me never shows
      // up — only "someone-else" is visible. This must NOT be treated as a
      // contest the viewer is part of.
      assigneesSequence: { 7: [[], [{ login: "someone-else" }]] },
      viewerLogin: "test-viewer",
      claims,
    }));
    assert.equal(r.ok, false);
    assert.equal(r.source, "next-up");
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /issue #7 \(Head\) claim was not visible on re-read \(only someone-else showed up\)/);
    assert.match(r.skipped[0].reason, /claim_not_visible_post_read/);
    // No --remove-assignee call ever targets "someone-else" — the winner-side
    // removal path must never fire here. Only our own claim + a best-effort
    // self-unclaim of it.
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
    ]);
  });

  it("post-claim re-read failure fails closed AND best-effort self-unclaims (no orphaned claim left behind)", async () => {
    const claims = [];
    const child = boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assignees: { 7: [] },
      claims,
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
    // Original error still fails the run closed, but the cleanup attempt ran.
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
    ]);
  });

  it("post-claim viewer-login resolution failure fails closed AND best-effort self-unclaims (no orphaned claim left behind)", async () => {
    // All-unassigned scan → the viewer login is first resolved AFTER the
    // claim; a failure there must not strand the just-made claim.
    const claims = [];
    await assert.rejects(
      () => runArgs(boardRunChild({
        columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
        assignees: { 7: [] },
        viewerLoginError: true,
        claims,
      })),
      /Unable to resolve the current GitHub viewer login/,
    );
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
    ]);
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

  it("tiebreak compares logins case-insensitively on BOTH sides (mixed-case viewer AND contender)", async () => {
    const claims = [];
    // Naive (non-lowercased) string comparison would sort "Viewer-Z" before
    // "apple-A" (uppercase 'V' < lowercase 'a' in ASCII) — i.e. the viewer
    // would incorrectly win. Case-folded, "apple-a" < "viewer-z", so the
    // OTHER contender wins and the viewer must self-unassign.
    const r = await runArgs(boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assigneesSequence: { 7: [[], [{ login: "Viewer-Z" }, { login: "apple-A" }]] },
      viewerLogin: "Viewer-Z",
      claims,
    }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /claim_contested_lost_tiebreak/);
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
    ]);
  });

  it("orphaned-claim cleanup: the tiebreak-loser's own unclaim call failing still fails closed, with a best-effort retry", async () => {
    const claims = [];
    const child = boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assigneesSequence: { 7: [[], [{ login: "test-viewer" }, { login: "aaa-other" }]] },
      viewerLogin: "test-viewer",
      claims,
    });
    let removeCallsFor7 = 0;
    const wrapped = async (cmd, argv) => {
      if (argv[0] === "issue" && argv[1] === "edit" && Number(argv[2]) === 7 && argv.includes("--remove-assignee")) {
        removeCallsFor7 += 1;
        if (removeCallsFor7 === 1) {
          return { code: 1, stdout: "", stderr: "boom: gh outage" };
        }
      }
      return child(cmd, argv);
    };
    await assert.rejects(() => runArgs(wrapped), /gh issue edit failed/);
    // First unclaim attempt failed (not recorded by the stub since it errored
    // before the stub could record it); the best-effort retry succeeded.
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
    ]);
  });

  it("orphaned-claim cleanup: the tiebreak-winner's foreign-login removal failing self-unassigns and still fails closed", async () => {
    const claims = [];
    const child = boardRunChild({
      columns: { "In Progress": [], "Next Up": [{ issueNumber: 7, title: "Head" }] },
      assigneesSequence: { 7: [[], [{ login: "test-viewer" }, { login: "zzz-other" }]] },
      viewerLogin: "test-viewer",
      claims,
    });
    const wrapped = async (cmd, argv) => {
      if (argv[0] === "issue" && argv[1] === "edit" && Number(argv[2]) === 7 && argv.includes("--remove-assignee") && argv.includes("zzz-other")) {
        return { code: 1, stdout: "", stderr: "boom: gh outage" };
      }
      return child(cmd, argv);
    };
    await assert.rejects(() => runArgs(wrapped), /gh issue edit failed/);
    // The winner's removal of the foreign login failed; best-effort cleanup
    // then self-unassigns so this run doesn't strand the viewer's own claim.
    assert.deepEqual(claims, [
      { kind: "issue", number: 7, action: "add-assignee", logins: ["@me"] },
      { kind: "issue", number: 7, action: "remove-assignee", logins: ["@me"] },
    ]);
  });
});

// Focused unit coverage for the extracted per-candidate helper, called
// directly (no board/GraphQL fixture needed) since it only shells out to
// `gh issue|pr view|edit` and `gh api user`.
function directRunChild({ postClaimAssignees, viewerLogin = "test-viewer", claims = [] } = {}) {
  return async (_cmd, argv) => {
    if (argv[0] === "api" && argv[1] === "user") {
      return { code: 0, stdout: JSON.stringify({ login: viewerLogin }), stderr: "" };
    }
    if ((argv[0] === "issue" || argv[0] === "pr") && argv[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ assignees: postClaimAssignees }), stderr: "" };
    }
    if ((argv[0] === "issue" || argv[0] === "pr") && argv[1] === "edit") {
      claims.push({ action: argv.includes("--remove-assignee") ? "remove-assignee" : "add-assignee" });
      return { code: 0, stdout: "{}", stderr: "" };
    }
    throw new Error(`directRunChild: unexpected call: ${argv.join(" ")}`);
  };
}

describe("resolve-active-board-item attemptClaimAndArbitrate (extracted helper)", () => {
  const target = { kind: "issue", number: 7 };

  it("sole owner post-claim -> outcome owned, no claimNote", async () => {
    const result = await attemptClaimAndArbitrate(target, "o/r", {
      env: {},
      runChild: directRunChild({ postClaimAssignees: [{ login: "test-viewer" }] }),
      itemLabel: "issue #7 (Head)",
      viewerLoginBox: { login: null, resolved: false },
    });
    assert.deepEqual(result, { outcome: "owned" });
  });

  it("contested, viewer wins the tiebreak -> outcome owned with claimNote", async () => {
    const claims = [];
    const result = await attemptClaimAndArbitrate(target, "o/r", {
      env: {},
      runChild: directRunChild({
        postClaimAssignees: [{ login: "test-viewer" }, { login: "zzz-other" }],
        claims,
      }),
      itemLabel: "issue #7 (Head)",
      viewerLoginBox: { login: null, resolved: false },
    });
    assert.equal(result.outcome, "owned");
    assert.match(result.claimNote, /claim_contested_won_tiebreak/);
    assert.deepEqual(claims, [{ action: "add-assignee" }, { action: "remove-assignee" }]);
  });

  it("contested, viewer loses the tiebreak -> outcome skip, self-unassigns", async () => {
    const claims = [];
    const result = await attemptClaimAndArbitrate(target, "o/r", {
      env: {},
      runChild: directRunChild({
        postClaimAssignees: [{ login: "test-viewer" }, { login: "aaa-other" }],
        claims,
      }),
      itemLabel: "issue #7 (Head)",
      viewerLoginBox: { login: null, resolved: false },
    });
    assert.equal(result.outcome, "skip");
    assert.match(result.skipReason, /claim_contested_lost_tiebreak/);
    assert.deepEqual(claims, [{ action: "add-assignee" }, { action: "remove-assignee" }]);
  });

  it("our claim not visible post-read (only another human) -> outcome skip, never removes the other login", async () => {
    const claims = [];
    const result = await attemptClaimAndArbitrate(target, "o/r", {
      env: {},
      runChild: directRunChild({ postClaimAssignees: [{ login: "someone-else" }], claims }),
      itemLabel: "issue #7 (Head)",
      viewerLoginBox: { login: null, resolved: false },
    });
    assert.equal(result.outcome, "skip");
    assert.match(result.skipReason, /claim_not_visible_post_read/);
    assert.deepEqual(claims, [{ action: "add-assignee" }, { action: "remove-assignee" }]);
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
    await withTempCwd('queue:\n  board:\n    number: 7\n  statusColumns:\n    next_up: "Todo"\n', async (cwd) => {
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
    await withTempCwd('queue:\n  board:\n    number: 7\n  statusColumns:\n    in_progress: "Doing"\n', async (cwd) => {
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

describe("board resolution from .devloops without --project (#1459)", () => {
  async function withTempCwd(contents, fn) {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "resolve-active-devloops-"));
    try {
      if (contents !== null) writeFileSync(nodePath.join(dir, ".devloops"), contents, "utf-8");
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function cliNoProject(child, cwd) {
    let out = "";
    let err = "";
    const prev = process.exitCode;
    process.exitCode = undefined;
    return runCli(["--repo", "o/r"], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      runChild: child,
      cwd,
    }).then(() => {
      const code = process.exitCode;
      process.exitCode = prev;
      return { code, out, err };
    });
  }

  it("title-configured board resolves the in-progress item with no --project", async () => {
    await withTempCwd('queue:\n  board:\n    title: "Board"\n', async (cwd) => {
      const child = boardRunChild({ columns: { "In Progress": [{ issueNumber: 42, title: "Doing" }] } });
      const { code, out } = await cliNoProject(child, cwd);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), { ok: true, target: { kind: "issue", number: 42 }, source: "in-progress" });
    });
  });

  it("title-configured board resolves the Next Up head with no --project (delegation forwards projectTitle)", async () => {
    await withTempCwd('queue:\n  board:\n    title: "Board"\n', async (cwd) => {
      const child = boardRunChild({ columns: { "In Progress": [], "Next Up": [{ issueNumber: 9, title: "Head" }] } });
      const { code, out } = await cliNoProject(child, cwd);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), { ok: true, target: { kind: "issue", number: 9 }, source: "next-up" });
    });
  });

  it("tracker.board title-configured board (preferred key) resolves with no --project", async () => {
    await withTempCwd('tracker:\n  board:\n    title: "Board"\n', async (cwd) => {
      const child = boardRunChild({ columns: { "In Progress": [{ issueNumber: 11, title: "Doing" }] } });
      const { code, out } = await cliNoProject(child, cwd);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), { ok: true, target: { kind: "issue", number: 11 }, source: "in-progress" });
    });
  });

  it("number-configured board resolves with no --project", async () => {
    await withTempCwd("queue:\n  board:\n    number: 7\n", async (cwd) => {
      const child = boardRunChild({ columns: { "In Progress": [{ issueNumber: 5, title: "Doing" }] } });
      const { code, out } = await cliNoProject(child, cwd);
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(out), { ok: true, target: { kind: "issue", number: 5 }, source: "in-progress" });
    });
  });

  it("no .devloops board and no --project still fails closed with INVALID_PROJECT", async () => {
    await withTempCwd(null, async (cwd) => {
      const child = boardRunChild({ columns: { "In Progress": [] } });
      const { code, err } = await cliNoProject(child, cwd);
      // Exit 1 (usage/config error) specifically — exit 3 is the clean
      // fail-closed idle code (empty Next Up), and a misconfigured board must
      // never present as an idle queue.
      assert.equal(code, 1);
      const parsed = JSON.parse(err);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.code, "INVALID_PROJECT");
    });
  });
});
