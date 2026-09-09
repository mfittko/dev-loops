import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { makeGhMock, runIdFreeEnv } from "../_helpers.mjs";
import {
  parseVerifyFixerDispositionCliArgs,
  verifyFixerDisposition,
} from "../../scripts/github/verify-fixer-disposition.mjs";

const REPO = "owner/repo";
const PR = 1975;
const HEAD_SHA = "a".repeat(40);
const FIX_SHA = "b".repeat(40);

function threadsPayload(threads) {
  return `${JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } },
  })}\n`;
}

function threadsCallEntry(threads, extra = {}) {
  return {
    assertArgs: ["api", "graphql", "--field", `owner=owner`, "--field", `name=repo`, "--field", `pr=${PR}`],
    stdout: threadsPayload(threads),
    ...extra,
  };
}

function compareEntry(sha, status) {
  return {
    assertArgs: ["api", `repos/${REPO}/compare/${sha}...${HEAD_SHA}`],
    stdout: `${JSON.stringify({ status })}\n`,
  };
}

async function withRepoRoot(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "verify-fixer-disposition-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function runtime(entries, repoRoot) {
  const { runChild, calls } = makeGhMock(entries);
  return { deps: { env: runIdFreeEnv(), ghCommand: "gh", runChild, repoRoot }, calls };
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

test("parseVerifyFixerDispositionCliArgs requires repo/pr/head-sha", () => {
  assert.throws(() => parseVerifyFixerDispositionCliArgs(["--repo", REPO]), /Missing required arguments/);
});

test("parseVerifyFixerDispositionCliArgs rejects a short head SHA", () => {
  assert.throws(
    () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", "abc1234"]),
    /FULL head commit SHA/,
  );
});

test("parseVerifyFixerDispositionCliArgs rejects --dispositions with --dispositions-file", () => {
  assert.throws(
    () => parseVerifyFixerDispositionCliArgs([
      "--repo", REPO, "--pr", "1", "--head-sha", "a".repeat(40),
      "--dispositions", "[]", "--dispositions-file", "x.json",
    ]),
    /mutually exclusive/,
  );
});

// ---------------------------------------------------------------------------
// AC row 3 — ordering integration: commit -> containment -> reply -> resolve -> reread
// ---------------------------------------------------------------------------

test("records a checkpoint, replies+resolves a tackled thread with missing evidence, and reports complete", async () => {
  await withRepoRoot(async (repoRoot) => {
    const dispositions = JSON.stringify([
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. reply POST
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      // 4. resolve GraphQL mutation
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } })}\n` },
      // 5. re-read live threads
      threadsCallEntry([
        { id: "T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, dispositions, tmpRoot: "tmp" }, deps);

    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.incomplete, []);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].step, "replied_and_resolved");
    assert.equal(calls.length, 5);

    const checkpointRaw = await readFile(path.join(repoRoot, result.checkpointPath), "utf8");
    const checkpoint = JSON.parse(checkpointRaw);
    assert.equal(checkpoint.headSha, HEAD_SHA);
    assert.equal(checkpoint.dispositions[0].threadId, "T1");
  });
});

// ---------------------------------------------------------------------------
// AC row 2 — uncontained commit blocks; no mutation is ever attempted
// ---------------------------------------------------------------------------

test("uncontained commit stays incomplete and never triggers a reply/resolve mutation", async () => {
  await withRepoRoot(async (repoRoot) => {
    const dispositions = JSON.stringify([
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "diverged"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, dispositions, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, false);
    assert.equal(result.incomplete.length, 1);
    assert.equal(result.incomplete[0].failedStep, "commit_not_contained");
    assert.equal(result.actions.length, 0);
    // Exactly the 2 read-only calls (threads capture + compare) — no reply/resolve/re-read.
    assert.equal(calls.length, 2);
    assert.ok(result.forbiddenActions.includes("request_copilot_review"));
    assert.ok(result.forbiddenActions.includes("rerequest_copilot_review"));
  });
});

// ---------------------------------------------------------------------------
// AC row 5/7 — idempotent re-entry: no duplicate evidence reply
// ---------------------------------------------------------------------------

test("re-entry after reply-succeeded/resolve-failed only resolves, never posts a second reply", async () => {
  await withRepoRoot(async (repoRoot) => {
    const dispositions = JSON.stringify([
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    // First run: reply succeeds, then the mock's resolveReviewThread call
    // reports the thread as NOT resolved (simulating a resolve failure).
    const first = runtime([
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: false } } } })}\n` },
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const firstResult = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, dispositions, tmpRoot: "tmp" }, first.deps);
    assert.equal(firstResult.complete, false);
    assert.equal(firstResult.incomplete[0].failedStep, "not_resolved");
    assert.equal(firstResult.actions[0].ok, false);

    // Second run (re-entry, no --dispositions): reads the persisted checkpoint,
    // sees the reply already carries the commit evidence live, and must ONLY
    // call resolveThread — never postReply again.
    const second = runtime([
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const secondResult = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, tmpRoot: "tmp" }, second.deps);
    assert.equal(secondResult.complete, true);
    assert.equal(secondResult.actions[0].step, "resolved");
    // No POST .../replies call anywhere in this run's gh call log.
    assert.ok(second.calls.every((call) => !call.args.some((arg) => String(arg).includes("/replies"))));
  });
});

// ---------------------------------------------------------------------------
// copilot review (PR #2126): a NOT_RESOLVED entry needs only threadId to
// resolve — a missing/filtered REST commentId (e.g. planBatchReplyTargets
// never matches one because the evidenced reply's author has no login) must
// never block a resolve-only action.
// ---------------------------------------------------------------------------

test("resolve-only path (NOT_RESOLVED) proceeds via threadId alone when no commentId is matched", async () => {
  await withRepoRoot(async (repoRoot) => {
    const dispositions = JSON.stringify([
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture: T1 already carries the commit-evidenced
      // reply, but its author has no login (e.g. a deleted GitHub account),
      // so authorMatchesFilter("all") filters it out and planBatchReplyTargets
      // never matches a commentId for T1. This is NOT_RESOLVED only — no
      // reply is missing — so no commentId should ever be required.
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. resolve GraphQL mutation — no reply POST at all.
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } })}\n` },
      // 4. re-read live threads
      threadsCallEntry([
        { id: "T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, dispositions, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, true);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].ok, true);
    assert.equal(result.actions[0].step, "resolved");
    // No POST .../replies call anywhere in this run's gh call log.
    assert.ok(calls.every((call) => !call.args.some((arg) => String(arg).includes("/replies"))));
    assert.equal(calls.length, 4);
  });
});

// ---------------------------------------------------------------------------
// AC row 5 — resolve success / re-read failure: the resolve mutation LIES
// (reports isResolved:true) but the post-mutation live re-read still shows
// the thread unresolved; the CLI must trust the re-read, not the mutation.
// ---------------------------------------------------------------------------

test("resolve mutation reports isResolved:true but the live re-read still shows unresolved, so it stays incomplete", async () => {
  await withRepoRoot(async (repoRoot) => {
    const dispositions = JSON.stringify([
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. reply POST
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      // 4. resolve GraphQL mutation LIES: reports isResolved:true.
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } })}\n` },
      // 5. re-read live threads: still unresolved despite the mutation's claim.
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, dispositions, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, false);
    assert.equal(result.incomplete.length, 1);
    assert.equal(result.incomplete[0].failedStep, "not_resolved");
    // The mutation itself didn't throw (it claimed success) ...
    assert.equal(result.actions[0].ok, true);
    // ... but the CLI re-fetched live rather than trusting that claim, so
    // overall completion still reflects the true unresolved state.
    assert.equal(calls.length, 5);
  });
});

// ---------------------------------------------------------------------------
// AC row 6 — unrelated threads are never touched
// ---------------------------------------------------------------------------

test("deferred/foreign/newly-arrived threads are never replied to or resolved", async () => {
  await withRepoRoot(async (repoRoot) => {
    const dispositions = JSON.stringify([
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
      { threadId: "T2", fixingCommitSha: FIX_SHA, disposition: "deferred" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
        { id: "T2", isResolved: false, comments: { nodes: [{ id: "c2", databaseId: 201, body: "unrelated nit", author: { login: "someone-else", __typename: "User" } }] } },
        { id: "T3", isResolved: false, comments: { nodes: [{ id: "c3", databaseId: 301, body: "brand new finding", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "identical"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, dispositions, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    // Only the read-only calls (threads capture + one compare) — T2/T3 never touched.
    assert.equal(calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// no checkpoint + no --dispositions fails closed
// ---------------------------------------------------------------------------

test("fails closed with a clear error when no checkpoint exists and --dispositions is absent", async () => {
  await withRepoRoot(async (repoRoot) => {
    const { deps } = runtime([], repoRoot);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, tmpRoot: "tmp" }, deps),
      /No fixer disposition handoff checkpoint found/,
    );
  });
});
