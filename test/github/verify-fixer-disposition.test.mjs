import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { initGitFixture, makeGhMock, runIdFreeEnv } from "../_helpers.mjs";
import {
  parseVerifyFixerDispositionCliArgs,
  verifyFixerDisposition,
} from "../../scripts/github/verify-fixer-disposition.mjs";
import { pullReceiptPath } from "../../scripts/github/_work-order-protocol.mjs";

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

const REF = `fixer:${REPO}#${PR}:${HEAD_SHA}:f1-0000abcd`;

// ADR 0106 delivery evidence for a full-phase fixer: the emit plan, its pull
// receipt under <repoRoot>/tmp, and the disposition handoff at the plan's outputRef.
async function deliver(repoRoot, dispositions, {
  handoffHead = HEAD_SHA, orderHead = HEAD_SHA, phase = "full", receipt = {}, writeReceipt = true, writeHandoff = true, pulledAt = new Date(Date.now() - 1000).toISOString(),
} = {}) {
  const dir = path.join(repoRoot, "tmp", "gate-fixer", "owner-repo", `pr-${PR}`);
  const outputRef = path.join(dir, "f1-0000abcd", "fixer-disposition.json");
  const plan = {
    workOrderRef: REF, workOrderDigest: "d".repeat(64), executionIdentity: "f1-0000abcd",
    workOrder: { role: "fixer", phase, target: { repo: REPO, pr: PR }, headSha: orderHead, outputRefs: [outputRef] },
  };
  const planPath = path.join(dir, "fixer-emit-plan.json");
  await mkdir(path.dirname(outputRef), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan));
  if (writeReceipt) {
    const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({
      role: "fixer", workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity, pulledAt, ...receipt,
    }));
  }
  if (writeHandoff) await writeFile(outputRef, JSON.stringify({ headSha: handoffHead, dispositions }));
  return planPath;
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

test("parseVerifyFixerDispositionCliArgs requires repo/pr/head-sha/fixer-plan", () => {
  assert.throws(() => parseVerifyFixerDispositionCliArgs(["--repo", REPO]), /Missing required arguments/);
  assert.throws(
    () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", HEAD_SHA]),
    /Missing required arguments: fixerPlan/,
  );
});

test("parseVerifyFixerDispositionCliArgs rejects a short head SHA", () => {
  assert.throws(
    () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", "abc1234"]),
    /FULL head commit SHA/,
  );
});

test("F6: a caller-supplied --dispositions or --dispositions-file is rejected", () => {
  for (const flag of ["--dispositions", "--dispositions-file"]) {
    assert.throws(
      () => parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", "1", "--head-sha", HEAD_SHA, "--fixer-plan", "p.json", flag, "[]"]),
      /Unknown argument/,
    );
  }
});

// ---------------------------------------------------------------------------
// F6 — delivery evidence: receipt + handoff + observed head, or no advance
// ---------------------------------------------------------------------------

const TACKLED = [{ threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }];

for (const [name, setup, expected] of [
  ["a missing receipt", { writeReceipt: false }, /receipt_missing/],
  ["a malformed receipt", { receipt: { workOrderRef: 7 } }, /unit_mismatch/],
  ["a receipt for another role", { receipt: { role: "review" } }, /role_mismatch/],
  ["a receipt for another execution", { receipt: { executionIdentity: "f2-0000abcd" } }, /execution_mismatch/],
  ["a receipt for another digest", { receipt: { workOrderDigest: "e".repeat(64) } }, /digest_mismatch/],
  ["a receipt without a handoff (receipt-only)", { writeHandoff: false }, /result_missing/],
  ["a handoff written before the pull (stale or replayed)", { pulledAt: new Date(Date.now() + 60_000).toISOString() }, /result_predates_pull/],
  ["a handoff whose head is not the observed head", { handoffHead: FIX_SHA }, /not the observed head/],
  ["a commit_only plan", { phase: "commit_only" }, /not a full-phase fixer work order/],
]) {
  test(`F6: ${name} refuses and writes no checkpoint`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, TACKLED, setup);
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps), expected);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(path.join(repoRoot, "tmp", "gate-findings")), false);
    });
  });
}

test("F6: a plan for another target, or a missing plan, refuses", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const { deps } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR + 1, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps), /not a full-phase fixer work order for owner\/repo#1976/);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: "nope.json", tmpRoot: "tmp" }, deps), /Cannot read --fixer-plan/);
  });
});

test("F6: a work order head not contained by the observed head refuses; a contained one passes and the checkpoint records delivery", async () => {
  await withRepoRoot(async (repoRoot) => {
    const orderHead = "c".repeat(40);
    const fixerPlan = await deliver(repoRoot, [], { orderHead });
    const diverged = runtime([compareEntry(orderHead, "diverged")], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, diverged.deps), /not contained by the observed head/);
    const ahead = runtime([compareEntry(orderHead, "ahead"), threadsCallEntry([])], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, ahead.deps);
    assert.equal(result.complete, true);
    const checkpoint = JSON.parse(await readFile(path.join(repoRoot, result.checkpointPath), "utf8"));
    assert.deepEqual(
      { workOrderRef: checkpoint.workOrderRef, workOrderDigest: checkpoint.workOrderDigest, executionIdentity: checkpoint.executionIdentity },
      { workOrderRef: REF, workOrderDigest: "d".repeat(64), executionIdentity: "f1-0000abcd" },
    );
  });
});

// ---------------------------------------------------------------------------
// AC row 3 — ordering integration: commit -> containment -> reply -> resolve -> reread
// ---------------------------------------------------------------------------

test("records a checkpoint, replies+resolves a tackled thread with missing evidence, and reports complete", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
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

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

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
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "diverged"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

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
    const fixerPlan = await deliver(repoRoot, [
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

    const firstResult = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, first.deps);
    assert.equal(firstResult.complete, false);
    assert.equal(firstResult.incomplete[0].failedStep, "not_resolved");
    assert.equal(firstResult.actions[0].ok, false);

    // Second run (re-entry with the same plan): re-verifies the receipt, sees
    // the reply already carries the commit evidence live, and must ONLY call
    // resolveThread — never postReply again.
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

    const secondResult = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, second.deps);
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
    const fixerPlan = await deliver(repoRoot, [
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

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

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
    const fixerPlan = await deliver(repoRoot, [
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

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

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
    const fixerPlan = await deliver(repoRoot, [
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

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    // Only the read-only calls (threads capture + one compare) — T2/T3 never touched.
    assert.equal(calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// main-anchored checkpoint and receipt root
// ---------------------------------------------------------------------------

test("the checkpoint and receipt root default to the main worktree's tmp/ and a --tmp-root in a linked worktree is refused", async () => {
  await withRepoRoot(async (dir) => {
    const main = path.join(await realpath(dir), "main");
    await mkdir(main);
    initGitFixture(main);
    const linked = path.join(main, "tmp/worktrees/dev-loops/issue-1");
    execFileSync("git", ["worktree", "add", "-q", "-b", "issue-1", linked], { cwd: main, stdio: "ignore", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    const fixerPlan = await deliver(main, []);
    const { deps } = runtime([threadsCallEntry([])], linked);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan }, deps);
    assert.ok(result.checkpointPath.startsWith(path.join(main, "tmp", "gate-findings")), result.checkpointPath);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, runtime([], linked).deps),
      /inside the linked worktree/,
    );
  });
});
