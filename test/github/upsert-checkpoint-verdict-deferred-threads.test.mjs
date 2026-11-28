import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";
import { buildFindingMarker } from "../../scripts/github/_gate-finding-surface.mjs";
import { resolveDeferredGateThreads, upsertCheckpointVerdict } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

// GATE-EXEC-OPERATOR-FOCUS: the clean post closes the gate thread of each deferred fingerprint and no other thread.
const REPO = "owner/repo";
const PR = 17;
const HEAD = "abc1234000000000000000000000000000000000";
const DEFERRED_FP = "da9735d5c9d6ec81";
const OTHER_FP = "20f6d24370c05022";

const node = (id, commentId, fp, author = "gate-bot") => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: "a.mjs",
  line: 1,
  comments: { nodes: [{ id: `gid-${commentId}`, databaseId: commentId, body: `${buildFindingMarker({ fp, severity: "medium", angle: "correctness", round: 1 })}\nfinding ${fp}`, authorAssociation: "OWNER", author: { login: author, __typename: "User" } }] },
});

function makeRunChild(nodes, calls) {
  return async (cmd, args = [], _env, stdin = "") => {
    const a = args.join(" ");
    calls.push({ a, stdin: String(stdin ?? "") });
    if (a.includes("api user")) return { code: 0, stdout: '{"login":"gate-bot"}\n', stderr: "" };
    if (a.includes("resolveReviewThread")) {
      const threadId = args.find((arg) => arg.startsWith("threadId="))?.slice("threadId=".length);
      return { code: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }) + "\n", stderr: "" };
    }
    if (a.includes("graphql")) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }) + "\n", stderr: "" };
    if (a.includes("/replies")) return { code: 0, stdout: '{"id":9001,"html_url":"https://github.com/owner/repo/pull/17#discussion_r9001"}\n', stderr: "" };
    return { code: 0, stdout: "{}\n", stderr: "" };
  };
}

const posted = { ok: true, headSha: HEAD, gate: "draft_gate" };

test("3652: the clean post replies to and resolves only the gate thread of a deferred fingerprint", async () => {
  await withTempDir(async (tempDir) => {
    const focus = path.join(tempDir, "focus.json");
    await writeFile(focus, JSON.stringify({ items: [{ fingerprint: DEFERRED_FP, decision: "defer" }] }), "utf8");
    const calls = [];
    const nodes = [node("T-def", 501, DEFERRED_FP), node("T-other", 502, OTHER_FP), node("T-foreign", 503, DEFERRED_FP, "someone-else")];
    const options = { repo: REPO, pr: PR, gate: "draft_gate", verdict: "clean", operatorFocusFile: focus };
    const out = await resolveDeferredGateThreads(posted, options, { env: runIdFreeEnv(), ghCommand: "gh", runChild: makeRunChild(nodes, calls) });
    assert.equal(out.deferredThreadsResolved, 1);
    const resolves = calls.filter((c) => c.a.includes("resolveReviewThread"));
    assert.equal(resolves.length, 1);
    assert.match(resolves[0].a, /threadId=T-def/);
    const replies = calls.filter((c) => c.a.includes("/replies"));
    assert.equal(replies.length, 1);
    assert.match(replies[0].a, /comments\/501\/replies/);
    assert.match(replies[0].stdin, /Operator deferral/);
    assert.match(replies[0].stdin, new RegExp(HEAD));
  }, { prefix: "dev-loops-deferred-threads-" });
});

test("3652: a merged gate thread with a deferred and an undeferred fingerprint stays open", async () => {
  await withTempDir(async (tempDir) => {
    const focus = path.join(tempDir, "focus.json");
    await writeFile(focus, JSON.stringify({ items: [{ fingerprint: DEFERRED_FP, decision: "defer" }] }), "utf8");
    const calls = [];
    const merged = node("T-merged", 504, DEFERRED_FP);
    merged.comments.nodes[0].body += `\n${buildFindingMarker({ fp: OTHER_FP, severity: "medium", angle: "correctness", round: 1 })}`;
    const options = { repo: REPO, pr: PR, gate: "draft_gate", verdict: "clean", operatorFocusFile: focus };
    const out = await resolveDeferredGateThreads(posted, options, { env: runIdFreeEnv(), ghCommand: "gh", runChild: makeRunChild([merged], calls) });
    assert.equal(out.deferredThreadsResolved, undefined);
    assert.equal(calls.filter((c) => c.a.includes("resolveReviewThread") || c.a.includes("/replies")).length, 0);
  }, { prefix: "dev-loops-deferred-merged-" });
});

test("3652: no thread closes for a non-clean verdict, a focus file without a defer decision or a gate other than draft_gate", async () => {
  await withTempDir(async (tempDir) => {
    const deferFocus = path.join(tempDir, "defer.json");
    await writeFile(deferFocus, JSON.stringify({ items: [{ fingerprint: DEFERRED_FP, decision: "defer" }] }), "utf8");
    const fixFocus = path.join(tempDir, "fix.json");
    await writeFile(fixFocus, JSON.stringify({ items: [{ fingerprint: DEFERRED_FP, decision: "apply remedy 1" }] }), "utf8");
    for (const [name, result, options] of [
      ["findings_present", posted, { verdict: "findings_present", operatorFocusFile: deferFocus }],
      ["blocked by a gate blocker", { ...posted, reviewVerdict: "clean", gateBlockers: ["round_cap_reached"] }, { verdict: "clean", operatorFocusFile: deferFocus }],
      ["no defer decision", posted, { verdict: "clean", operatorFocusFile: fixFocus }],
      ["no focus file", posted, { verdict: "clean" }],
      ["pre_approval_gate", posted, { verdict: "clean", gate: "pre_approval_gate", operatorFocusFile: deferFocus }],
    ]) {
      const calls = [];
      const out = await resolveDeferredGateThreads(result, { repo: REPO, pr: PR, gate: "draft_gate", ...options }, { env: runIdFreeEnv(), ghCommand: "gh", runChild: makeRunChild([node("T-def", 501, DEFERRED_FP)], calls) });
      assert.equal(out.deferredThreadsResolved, undefined, name);
      assert.equal(calls.length, 0, `${name} makes no gh call`);
    }
  }, { prefix: "dev-loops-deferred-threads-skip-" });
});

test("3652: a relative --operator-focus-file resolves once against cwd for every reader", async () => {
  const options = { operatorFocusFile: "focus.json", repo: REPO, pr: PR, gate: "pre_approval_gate" };
  // The refusal for a non-draft gate runs after the path is resolved, so the mutated option shows the one resolution.
  await upsertCheckpointVerdict(options, { env: runIdFreeEnv(), ghCommand: "gh", runChild: async () => ({ code: 1, stdout: "", stderr: "" }) }).catch(() => {});
  assert.equal(options.operatorFocusFile, path.resolve("focus.json"));
});
