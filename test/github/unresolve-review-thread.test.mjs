import assert from "node:assert/strict";
import { test } from "bun:test";
import { unresolveReviewThread } from "../../scripts/github/unresolve-review-thread.mjs";

const target = { repo: "owner/repo", pr: 7, threadId: "T1" };

function fakeRun({ isResolved = true, state = "OPEN", number = 7, login = "copilot-pull-request-reviewer", reviewBody = "" } = {}) {
  const calls = [];
  const run = async (args) => {
    const query = args.find((a) => a.startsWith("query="));
    calls.push(query);
    if (query.includes("unresolveReviewThread")) {
      return JSON.stringify({ data: { unresolveReviewThread: { thread: { id: "T1", isResolved: false } } } });
    }
    return JSON.stringify({ data: { node: {
      id: "T1", isResolved,
      pullRequest: { number, state, repository: { nameWithOwner: "owner/repo" } },
      comments: { nodes: [{ author: { login }, pullRequestReview: { body: reviewBody } }] },
    } } });
  };
  return { run, calls };
}

const mutated = (calls) => calls.some((q) => q.includes("mutation"));

test("unresolves a resolved Copilot thread and reports the new state", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await unresolveReviewThread(target, { run }), { ok: true, threadId: "T1", isResolved: false });
  assert.ok(mutated(calls));
});

test("a null node maps to thread_not_on_pr", async () => {
  const run = async () => JSON.stringify({ data: { node: null } });
  await assert.rejects(unresolveReviewThread(target, { run }), (e) => e.reason === "thread_not_on_pr");
});

test("a gh 'Could not resolve to a node' failure maps to thread_not_on_pr", async () => {
  const run = async () => { throw Object.assign(new Error("exit 1"), { stderr: "Could not resolve to a node with the global id of 'T1'" }); };
  await assert.rejects(unresolveReviewThread(target, { run }), (e) => e.reason === "thread_not_on_pr");
});

test("a CLOSED PR is refused with pr_closed_or_merged", async () => {
  const { run } = fakeRun({ state: "CLOSED" });
  await assert.rejects(unresolveReviewThread(target, { run }), (e) => e.reason === "pr_closed_or_merged");
});

test("malformed gh JSON names the thread id", async () => {
  await assert.rejects(unresolveReviewThread(target, { run: async () => "not json" }), /Malformed gh JSON for thread T1/);
});

test("unresolves a gate-review thread", async () => {
  const { run } = fakeRun({ login: "mfittko", reviewBody: "<!-- dev-loops:gate-findings-review -->\nfindings" });
  assert.equal((await unresolveReviewThread(target, { run })).isResolved, false);
});

test("regression: a wrongly resolved thread now has a sanctioned unresolve path", async () => {
  // PR 2563 / 2573 lockout: the thread was resolved and no sanctioned path could reopen it.
  const { run } = fakeRun({ isResolved: true });
  assert.equal((await unresolveReviewThread(target, { run })).ok, true);
});

for (const [name, opts, reason, remedy] of [
  ["an unresolved thread", { isResolved: false }, "thread_not_resolved", /fixer/],
  ["a thread on another PR", { number: 8 }, "thread_not_on_pr", /capture-threads/],
  ["a closed PR", { state: "MERGED" }, "pr_closed_or_merged", /follow-up issue/],
  ["a human-authored thread", { login: "someone" }, "thread_author_not_reviewer", /operator/],
]) {
  test(`refuses ${name} with ${reason} and never mutates`, async () => {
    const { run, calls } = fakeRun(opts);
    await assert.rejects(unresolveReviewThread(target, { run }), (e) => e.reason === reason && remedy.test(e.message));
    assert.equal(mutated(calls), false);
  });
}
