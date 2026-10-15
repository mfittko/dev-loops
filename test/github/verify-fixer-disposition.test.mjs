import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { decideDeltaNextStep, startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { parseReviewThreads } from "@dev-loops/core/github/review-threads";

import { initGitFixture, makeGhMock, runIdFreeEnv } from "../_helpers.mjs";
import {
  parseVerifyFixerDispositionCliArgs,
  verifyFixerDisposition,
} from "../../scripts/github/verify-fixer-disposition.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { pullReceiptPath, verifyPulledResult, workOrderDigest } from "../../scripts/github/_work-order-protocol.mjs";
import { resolveFixerDispositionInput } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { buildLogPath } from "../../scripts/github/write-gate-findings-log.mjs";

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

function liveHeadEntry(headRefOid = HEAD_SHA) {
  return { assertArgs: ["pr", "view", String(PR), "--json", "headRefOid"], stdout: `${JSON.stringify({ headRefOid })}\n` };
}

// Prepends the live-head read the verifier makes before any checkpoint write.
function runtime(entries, repoRoot, { live = true } = {}) {
  const { runChild, calls } = makeGhMock(live ? [liveHeadEntry(), ...entries] : entries);
  return { deps: { env: runIdFreeEnv(), ghCommand: "gh", runChild, repoRoot }, calls };
}

const REF = `fixer:${REPO}#${PR}:${HEAD_SHA}:f1-0000abcd`;

// ADR 0106 delivery evidence for a full-phase fixer: the emit plan, its pull
// receipt under <repoRoot>/tmp, and the disposition handoff at the plan's outputRef.
async function deliver(repoRoot, dispositions, {
  handoffHead = HEAD_SHA, orderHead = HEAD_SHA, phase = "full", receipt = {}, writeReceipt = true, writeHandoff = true, pulledAt = new Date(Date.now() - 1000).toISOString(),
  receiptMtime = null, handoffText = null, actList = null, editActListAfter = false, threads = null, delta = null, decision = null, semanticAuthority = true,
} = {}) {
  const dir = path.join(repoRoot, "tmp", "gate-fixer", "owner-repo", `pr-${PR}`);
  const outputRef = path.join(dir, "f1-0000abcd", "fixer-disposition.json");
  const actListPath = path.join(dir, "act-list.json");
  const workOrder = { role: "fixer", phase, target: { repo: REPO, pr: PR }, headSha: orderHead, mutationAuthority: { branch: "issue-1" }, outputRefs: [outputRef], ...(actList ? { requiredReads: [{ kind: "act-list", path: actListPath, sha256: createHash("sha256").update(JSON.stringify(actList)).digest("hex") }] } : {}) };
  const plan = { workOrderRef: REF, workOrderDigest: workOrderDigest(workOrder), executionIdentity: "f1-0000abcd", workOrder };
  if (threads) {
    const source = path.join(dir, "threads.json");
    workOrder.requiredReads = [{ kind: "threads", path: source, sha256: createHash("sha256").update(JSON.stringify(threads)).digest("hex") }];
    workOrder.authority = { sourceDigest: sha256Hex(threads).slice(7) };
    await mkdir(dir, { recursive: true });
    await writeFile(source, JSON.stringify(threads));
    plan.workOrderDigest = workOrderDigest(workOrder);
  }
  if (delta) {
    const deltaPath = path.join(dir, "delta.json");
    workOrder.requiredReads.push({ kind: "delta-result", path: deltaPath, sha256: createHash("sha256").update(JSON.stringify(delta)).digest("hex") });
    if (semanticAuthority) workOrder.authority = { sourceDigest: sha256Hex(actList).slice(7), deltaResultDigest: sha256Hex(delta).slice(7) };
    await mkdir(dir, { recursive: true });
    await writeFile(deltaPath, JSON.stringify(delta));
    plan.workOrderDigest = workOrderDigest(workOrder);
    if (decision) {
      const recordPath = path.join(repoRoot, "tmp", "gate-delta", `${orderHead}.json`);
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(recordPath, JSON.stringify(decision));
    }
  }
  const planPath = path.join(dir, "fixer-emit-plan.json");
  await mkdir(path.dirname(outputRef), { recursive: true });
  await writeFile(planPath, JSON.stringify(plan));
  if (actList) await writeFile(actListPath, JSON.stringify(editActListAfter ? [] : actList));
  if (writeReceipt) {
    const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({
      role: "fixer", workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity, pulledAt, subject: { planPath }, ...receipt,
    }));
  }
  if (writeHandoff) await writeFile(outputRef, handoffText ?? JSON.stringify({ headSha: handoffHead, dispositions }));
  if (receiptMtime) {
    await utimes(pullReceiptPath(path.join(repoRoot, "tmp"), REF), receiptMtime, receiptMtime);
    if (writeHandoff) await utimes(outputRef, 1, 1);
  }
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

const TACKLED = [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }];

for (const check of [false, true]) for (const [name, setup, expected] of [
  ["a missing receipt", { writeReceipt: false }, /receipt_missing/],
  ["a malformed receipt", { receipt: { workOrderRef: 7 } }, /unit_mismatch/],
  ["a receipt for another role", { receipt: { role: "review" } }, /role_mismatch/],
  ["a receipt for another execution", { receipt: { executionIdentity: "f2-0000abcd" } }, /execution_mismatch/],
  ["a receipt for another digest", { receipt: { workOrderDigest: "e".repeat(64) } }, /digest_mismatch/],
  ["a receipt without a handoff (receipt-only)", { writeHandoff: false }, /result_missing/],
  ["a prose-only handoff", { handoffText: "Fixed all threads." }, /is not valid JSON/],
  ["a handoff with a malformed dispositions list", { handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: "x" }) }, /dispositions must be an array/],
  ["a handoff written before the pull (stale or replayed)", { receiptMtime: new Date("2000-01-01T00:00:00Z") }, /result_predates_pull/],
  ["a handoff whose head is not the observed head", { handoffHead: FIX_SHA }, /not the observed head/],
  ["a commit_only plan", { phase: "commit_only" }, /not a full-phase fixer work order/],
  ["an act item with a siteQuery and no coverage record", { actList: [{ fingerprint: "fp1", severity: "high", summary: "s", judgeDisposition: "act", siteQuery: "git grep -n x" }] }, /act item fp1 has a site query and no site coverage record/],
  ["an act list edited after emission", { editActListAfter: true, actList: [{ fingerprint: "fp1", severity: "high", summary: "s", judgeDisposition: "act", siteQuery: "git grep -n x" }] }, /differs from the sha256 the work order binds/],
  ["a handoff leaving a returned site neither fixed nor skipped", { handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: [{ threadId: "PRRT_kwDOabc", fixingCommitSha: FIX_SHA, disposition: "tackled", returnedSites: ["src/a.mjs:guard", "src/b.mjs:guard"], sites: [{ site: "src/a.mjs:guard", status: "fixed" }] }] }) }, /leaves returned site src\/b\.mjs:guard neither fixed nor skipped/],
  ["a handoff skipping a returned site without a reason", { handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: [{ threadId: "PRRT_kwDOabc", fixingCommitSha: FIX_SHA, disposition: "tackled", returnedSites: ["src/a.mjs:guard"], sites: [{ site: "src/a.mjs:guard", status: "skipped" }] }] }) }, /records no skip reason/],
]) {
  test(`F6 (${check ? "check" : "default"}): ${name} refuses and writes no checkpoint`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, TACKLED, setup);
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), expected);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(path.join(repoRoot, "tmp", "gate-findings")), false);
    });
  });
}

test("F6: a handoff written in the same clock tick as the pull (equal mtimes) passes verifyPulledResult", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    const receiptTmpRoot = path.join(repoRoot, "tmp");
    const tick = new Date(Date.now() - 5000);
    await utimes(pullReceiptPath(receiptTmpRoot, REF), tick, tick);
    await utimes(plan.workOrder.outputRefs[0], tick, tick);
    const check = await verifyPulledResult({
      resultPath: plan.workOrder.outputRefs[0], receiptTmpRoot, role: "fixer", workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity,
    });
    assert.equal(check.ok, true, check.reason);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a plan for another target, or a missing plan, refuses`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const { deps } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR + 1, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /not a full-phase fixer work order for owner\/repo#1976/);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: "nope.json", tmpRoot: "tmp", check }, deps), /Cannot read --fixer-plan/);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a work order head not contained by the observed head refuses; a contained one passes and the checkpoint records delivery`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const orderHead = "c".repeat(40);
    const fixerPlan = await deliver(repoRoot, [], { orderHead });
    const diverged = runtime([compareEntry(orderHead, "diverged")], repoRoot, { live: false });
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, diverged.deps), /not contained by the observed head/);
    const ahead = runtime([compareEntry(orderHead, "ahead"), liveHeadEntry(), threadsCallEntry([])], repoRoot, { live: false });
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, ahead.deps);
    assert.equal(result.complete, true);
    if (check) { assert.equal(result.checkpointPath, null); assert.deepEqual(await checkpointFiles(repoRoot), []); return; }
    const checkpoint = JSON.parse(await readFile(path.join(repoRoot, result.checkpointPath), "utf8"));
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    assert.deepEqual(
      { workOrderRef: checkpoint.workOrderRef, workOrderDigest: checkpoint.workOrderDigest, executionIdentity: checkpoint.executionIdentity },
      { workOrderRef: REF, workOrderDigest: plan.workOrderDigest, executionIdentity: "f1-0000abcd" },
    );
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a plan whose work order was edited in place after emission refuses before any read`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    for (const workOrder of [{ ...plan.workOrder, mutationAuthority: { branch: "main" } }, { ...plan.workOrder, headSha: FIX_SHA }]) {
      await writeFile(fixerPlan, JSON.stringify({ ...plan, workOrder }));
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /does not match its workOrderDigest/);
      assert.equal(calls.length, 0);
    }
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): an outputRef edited in place (outside the digest) refuses; the handoff is never read from it`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    const forged = path.join(repoRoot, "forged.json");
    await writeFile(forged, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    await writeFile(fixerPlan, JSON.stringify({ ...plan, workOrder: { ...plan.workOrder, outputRefs: [forged] } }));
    const { deps, calls } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /is not the emitted handoff path/);
    assert.equal(calls.length, 0);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a plan copied to another directory with a matching outputRef refuses; the pulled plan location is bound`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    const copyDir = path.join(repoRoot, "x");
    const forged = path.join(copyDir, plan.executionIdentity, "fixer-disposition.json");
    await mkdir(path.dirname(forged), { recursive: true });
    await writeFile(forged, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    const copied = path.join(copyDir, "fixer-emit-plan.json");
    await writeFile(copied, JSON.stringify({ ...plan, workOrder: { ...plan.workOrder, outputRefs: [forged] } }));
    const { deps, calls } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: copied, tmpRoot: "tmp", check }, deps), /is not the plan the fixer pull read/);
    assert.equal(calls.length, 0);
  });
});

for (const check of [false, true]) test(`F6 (${check ? "check" : "default"}): a --head-sha other than the live PR head refuses before any checkpoint write`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    const { deps } = runtime([liveHeadEntry(FIX_SHA)], repoRoot, { live: false });
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps), /is not the live PR head b{40}/);
    assert.equal(existsSync(path.join(repoRoot, "tmp", "gate-findings")), false);
  });
});

// ---------------------------------------------------------------------------
// AC row 3 — ordering integration: commit -> containment -> reply -> resolve -> reread
// ---------------------------------------------------------------------------

test("records a checkpoint, replies+resolves a tackled thread with missing evidence, and reports complete", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. reply POST
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      // 4. resolve GraphQL mutation
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      // 5. re-read live threads
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.incomplete, []);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].step, "replied_and_resolved");
    assert.equal(calls.length, 6);

    const checkpointRaw = await readFile(path.join(repoRoot, result.checkpointPath), "utf8");
    const checkpoint = JSON.parse(checkpointRaw);
    assert.equal(checkpoint.headSha, HEAD_SHA);
    assert.equal(checkpoint.dispositions[0].threadId, "PRRT_T1");
  });
});

// ---------------------------------------------------------------------------
// AC row 2 — uncontained commit blocks; no mutation is ever attempted
// ---------------------------------------------------------------------------

for (const check of [false, true]) test(`uncontained commit stays incomplete and never triggers a reply/resolve mutation (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "diverged"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp", check }, deps);

    assert.equal(result.complete, false);
    assert.equal(result.incomplete.length, 1);
    assert.equal(result.incomplete[0].failedStep, "commit_not_contained");
    assert.equal(result.actions.length, 0);
    // Exactly the 3 read-only calls (live head + threads capture + compare) — no reply/resolve/re-read.
    assert.equal(calls.length, 3);
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
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    // First run: reply succeeds, then the mock's resolveReviewThread call
    // reports the thread as NOT resolved (simulating a resolve failure).
    const first = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: false } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
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
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
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
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture: T1 already carries the commit-evidenced
      // reply, but its author has no login (e.g. a deleted GitHub account),
      // so authorMatchesFilter("all") filters it out and planBatchReplyTargets
      // never matches a commentId for T1. This is NOT_RESOLVED only — no
      // reply is missing — so no commentId should ever be required.
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. resolve GraphQL mutation — no reply POST at all.
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      // 4. re-read live threads
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, true);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].ok, true);
    assert.equal(result.actions[0].step, "resolved");
    // No POST .../replies call anywhere in this run's gh call log.
    assert.ok(calls.every((call) => !call.args.some((arg) => String(arg).includes("/replies"))));
    assert.equal(calls.length, 5);
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
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
    ]);
    const { deps, calls } = runtime([
      // 1. initial live-thread capture
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      // 2. containment compare for FIX_SHA
      compareEntry(FIX_SHA, "ahead"),
      // 3. reply POST
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      // 4. resolve GraphQL mutation LIES: reports isResolved:true.
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      // 5. re-read live threads: still unresolved despite the mutation's claim.
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
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
    assert.equal(calls.length, 6);
  });
});

// ---------------------------------------------------------------------------
// AC row 6 — unrelated threads are never touched
// ---------------------------------------------------------------------------

test("deferred/foreign/newly-arrived threads are never replied to or resolved", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" },
      { threadId: "PRRT_T2", fixingCommitSha: FIX_SHA, disposition: "deferred" },
    ]);
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
        { id: "PRRT_T2", isResolved: false, comments: { nodes: [{ id: "c2", databaseId: 201, body: "unrelated nit", author: { login: "someone-else", __typename: "User" } }] } },
        { id: "PRRT_T3", isResolved: false, comments: { nodes: [{ id: "c3", databaseId: 301, body: "brand new finding", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "identical"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    // Only the read-only calls (live head + threads capture + one compare) — T2/T3 never touched.
    assert.equal(calls.length, 3);
  });
});

test("site coverage riding a fingerprinted thread entry satisfies the act item's siteQuery", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled", fingerprint: "fp1", returnedSites: ["s"], sites: [{ site: "s", status: "fixed" }] },
    ], { actList: [{ fingerprint: "fp1", severity: "high", summary: "s", judgeDisposition: "act", siteQuery: "git grep -n x" }] });
    const { deps } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
      { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "gate" })}\n` },
      compareEntry(FIX_SHA, "identical"),
    ], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
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

// ---------------------------------------------------------------------------
// fixed-reply guard: a delta record that marks the thread not_resolved blocks the "Fixed in commit" reply
// ---------------------------------------------------------------------------

test("a thread the applicable delta record marks not_resolved gets no Fixed reply and is reported incomplete with its delta status", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    const recordPath = path.join(repoRoot, "tmp", "gate-delta", `${"c".repeat(40)}.json`);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, JSON.stringify({
      reviewBaselineHead: "c".repeat(40), candidateHead: FIX_SHA, actSetId: "0".repeat(16), invocation: 1,
      outcome: "needs_fix", nextStep: "fix_and_rereview", items: [{ ref: "PRRT_T1", status: "not_resolved" }],
    }));
    const { deps, calls } = runtime([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
    ], repoRoot);

    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);

    assert.equal(result.complete, false);
    assert.deepEqual(result.incomplete.map((entry) => [entry.threadId, entry.failedStep]), [["PRRT_T1", "delta_blocked"]]);
    assert.equal(result.incomplete[0].deltaStatus, "not_resolved");
    assert.equal(result.incomplete[0].deltaRecord, recordPath);
    assert.deepEqual(result.actions, []);
    assert.equal(calls.some((call) => call.args.includes("POST")), false, "no reply was posted");
  });
});

// ---------------------------------------------------------------------------
// fixed-reply guard on the verifier: acceptance side, abbreviated SHAs, git failures
// ---------------------------------------------------------------------------

async function writeDeltaRecord(repoRoot, { baseline = "c".repeat(40), candidate = FIX_SHA, items }) {
  const recordPath = path.join(repoRoot, "tmp", "gate-delta", `${baseline}.json`);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify({
    reviewBaselineHead: baseline, candidateHead: candidate, actSetId: "0".repeat(16), invocation: 1,
    outcome: "needs_fix", nextStep: "fix_and_rereview", items,
  }));
  return recordPath;
}

// Wraps the gh mock with a scripted git: `git(args)` returns { code, stdout } for rev-parse / merge-base.
function runtimeWithGit(entries, repoRoot, git) {
  const { deps, calls } = runtime(entries, repoRoot);
  const inner = deps.runChild;
  deps.runChild = async (cmd, args = [], ...rest) => {
    if (cmd === "git" && (args[0] === "rev-parse" || args[0] === "merge-base")) {
      calls.push({ command: cmd, args: [...args], stdinText: "" });
      return { stderr: "", stdout: "", ...git(args) };
    }
    return inner(cmd, args, ...rest);
  };
  return { deps, calls };
}

const unresolvedT1 = () => threadsCallEntry([
  { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }] } },
]);
const hasPost = (calls) => calls.some((call) => call.args.includes("POST"));

test("check mode refuses a tackled thread absent live and THREAD ignores unrelated live threads", async () => {
  await withRepoRoot(async (repoRoot) => {
    let fixerPlan = await deliver(repoRoot, TACKLED);
    let mock = runtime([threadsCallEntry([]), compareEntry(FIX_SHA, "ahead")], repoRoot);
    const missing = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, mock.deps);
    assert.equal(missing.complete, false);
    assert.equal(missing.incomplete[0].failedStep, "reply_missing");
    fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_SOURCE", fixingCommitSha: FIX_SHA, disposition: "deferred" }], { threads: { threads: [{ threadId: "PRRT_SOURCE" }] } });
    mock = runtime([threadsCallEntry([actThread("PRRT_UNRELATED", [gateComment("c1", 101)])])], repoRoot);
    const narrow = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, mock.deps);
    assert.equal(narrow.complete, true);
    assert.equal(mock.calls.length, 2, "only live head and threads, no ACT/login/history reads");
  });
});

for (const [isResolved, reply, expected] of [[true, true, null], [false, false, "reply_missing"], [false, true, "not_resolved"]]) {
  test(`check mode preserves report/checkpoint bytes and times with ${expected ?? "complete"} live evidence`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, TACKLED);
      const output = JSON.parse(await readFile(fixerPlan, "utf8")).workOrder.outputRefs[0];
      const checkpoint = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
      for (const existing of [false, true]) {
        if (existing) { await mkdir(path.dirname(checkpoint), { recursive: true }); await writeFile(checkpoint, "existing checkpoint\n"); }
        const paths = [fixerPlan, output, pullReceiptPath(path.join(repoRoot, "tmp"), REF), ...(existing ? [checkpoint] : [])];
        const snapshot = async () => Promise.all(paths.map(async (file) => [await readFile(file, "utf8"), (await stat(file)).mtimeMs]));
        const before = await snapshot();
        const { deps, calls } = runtime([threadsCallEntry([actThread("PRRT_T1", [gateComment("c1", 101, reply ? `Fixed in commit ${FIX_SHA}.` : "fix")], isResolved)]), compareEntry(FIX_SHA, "ahead")], repoRoot);
        const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
        assert.equal(result.complete, !expected);
        assert.deepEqual(result.incomplete.map((entry) => entry.failedStep), expected ? [expected] : []);
        assert.deepEqual(result.actions, []);
        assert.equal(result.checkpointPath, null);
        assert.deepEqual(await snapshot(), before);
        assert.equal(existsSync(path.dirname(checkpoint)), existing, "check creates no checkpoint directory");
        assert.equal(calls.some((call) => call.args.includes("POST") || call.args.some((arg) => String(arg).includes("mutation"))), false);
      }
    });
  });
}

test("check CLI flag is explicit and Delta refusal survives check mode", async () => {
  assert.equal(parseVerifyFixerDispositionCliArgs(["--repo", REPO, "--pr", String(PR), "--head-sha", HEAD_SHA, "--fixer-plan", "p", "--check"]).check, true);
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, TACKLED);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "cannot_verify" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
    assert.equal(result.incomplete[0].failedStep, "delta_blocked");
    assert.deepEqual(result.actions, []);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(calls), false);
  });
});

for (const check of [false, true]) for (const missing of [false, true]) {
  test(`THREAD source hash and membership are enforced (${check}, missing=${missing})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [], { threads: { threads: [{ threadId: "PRRT_SOURCE" }] } });
      const read = JSON.parse(await readFile(fixerPlan, "utf8")).workOrder.requiredReads[0];
      if (!missing) await writeFile(read.path, '{"threads":[]}');
      const { deps, calls } = runtime([], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps), missing ? /no disposition entry.*PRRT_SOURCE/ : /sha256/);
      assert.equal(calls.length, 0, "THREAD never queries ACT, login or history");
    });
  });
}

for (const check of [false, true]) test(`THREAD canonical source digest is enforced (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { threads: { threads: [] } });
    const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
    plan.workOrder.authority.sourceDigest = "0".repeat(64);
    plan.workOrderDigest = workOrderDigest(plan.workOrder);
    await writeFile(fixerPlan, JSON.stringify(plan));
    const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: plan.workOrderDigest }));
    await writeFile(plan.workOrder.outputRefs[0], JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
    const { deps, calls } = runtime([], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps), /threads.*sourceDigest/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
  });
});

test("authentically threadless ACT with complete existing coverage remains valid in check mode", async () => {
  await withRepoRoot(async (repoRoot) => {
    const actList = [{ ...ACT_LIST[0], siteQuery: "git grep x" }];
    const fixerPlan = await deliver(repoRoot, [], { actList, handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions: [], siteCoverage: [{ fingerprint: ACT_FP, returnedSites: [], sites: [], noSitesReason: "no matches" }] }) });
    const { deps } = runtime([threadsCallEntry([]), userEntry], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check: true }, deps);
    assert.equal(result.complete, true);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
  });
});

for (const checkpoint of [false, true]) test(`successful active check preserves existing ${checkpoint ? "malformed checkpoint" : "not_verified fallback"}`, async () => {
  await withRepoRoot(async (repoRoot) => {
    await deliver(repoRoot, TACKLED);
    if (checkpoint) {
      const file = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{");
    }
    const { deps } = runtime([threadsCallEntry([actThread("PRRT_T1", [gateComment("c1", 1, `Fixed in commit ${FIX_SHA}.`)], true)]), compareEntry(FIX_SHA, "ahead")], repoRoot);
    const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
    assert.equal(result.complete, false);
    assert.match(result.incomplete[0].failedStep, checkpoint ? /unreadable_checkpoint/ : /not_verified/);
  });
});

for (const hasCheckpoint of [false, true]) for (const [name, setup, expected] of [
  ["missing output", { writeHandoff: false }, /result_missing/],
  ["empty THREAD output", { threads: { threads: [{ threadId: "PRRT_SOURCE" }] } }, /PRRT_SOURCE/],
  ["omitted authenticated ACT thread", { actList: [{ fingerprint: "0123456789abcdef", severity: "medium", summary: "s", judgeDisposition: "act" }] }, /PRRT_ACT/],
  ["malformed output", { handoffText: "{" }, /not valid JSON/],
  ["stale head", { handoffHead: FIX_SHA }, /not the observed head/],
  ["predates pull", { receiptMtime: new Date("2000-01-01T00:00:00Z") }, /result_predates_pull/],
]) {
  test(`active full obligation vetoes ${hasCheckpoint ? "empty" : "absent"} checkpoint: ${name}`, async () => {
    await withRepoRoot(async (repoRoot) => {
      await deliver(repoRoot, [], setup);
      const checkpoint = buildLogPath({ repo: REPO, pr: PR, gate: "fixer-disposition", headSha: HEAD_SHA, tmpRoot: path.join(repoRoot, "tmp") });
      if (hasCheckpoint) {
        await mkdir(path.dirname(checkpoint), { recursive: true });
        await writeFile(checkpoint, JSON.stringify({ headSha: HEAD_SHA, dispositions: [] }));
      }
      const { deps, calls } = runtime(setup.actList ? [threadsCallEntry([actThread("PRRT_ACT", [gateComment("c1", 101)])]), userEntry] : [], repoRoot);
      const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
      assert.equal(result.complete, false);
      assert.match(result.incomplete[0].failedStep, expected);
      assert.equal(hasPost(calls), false);
    });
  });
}

for (const [name, change, compare, expected] of [
  ["foreign target", (order) => { order.target.pr++; }, null, null],
  ["commit_only", (order) => { order.phase = "commit_only"; }, null, null],
  ["unrelated head", (order) => { order.headSha = FIX_SHA; }, "diverged", null],
  ["uncertain containment", (order) => { order.headSha = FIX_SHA; }, "unknown", /unexpected compare status/],
  ["contained order head", (order) => { order.headSha = FIX_SHA; }, "ahead", /result_missing/],
  ["invalid digest", (order) => { order.phase = "commit_only"; }, null, /workOrderDigest/],
]) {
  test(`active plan applicability: ${name}`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [], { writeHandoff: false });
      const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
      change(plan.workOrder);
      if (name !== "invalid digest") plan.workOrderDigest = workOrderDigest(plan.workOrder);
      await writeFile(fixerPlan, JSON.stringify(plan));
      const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), REF);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      await writeFile(receiptPath, JSON.stringify({ ...receipt, workOrderDigest: plan.workOrderDigest }));
      const { deps } = runtime(compare ? [compareEntry(FIX_SHA, compare)] : [], repoRoot, { live: false });
      const result = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA }, deps);
      if (expected) { assert.equal(result.complete, false); assert.match(result.incomplete[0].failedStep, expected); }
      else assert.equal(result, null);
    });
  });
}

test("an abbreviated fixingCommitSha resolving to a commit a not_resolved record covers gets no Fixed reply", async () => {
  await withRepoRoot(async (repoRoot) => {
    const short = FIX_SHA.slice(0, 10);
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: short, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(short, "ahead")], repoRoot, (args) => (
      args[0] === "rev-parse" ? { code: 0, stdout: `${FIX_SHA}\n` } : { code: 0 }
    ));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, false);
    assert.deepEqual(result.incomplete.map((entry) => [entry.threadId, entry.failedStep, entry.deltaStatus]), [["PRRT_T1", "delta_blocked", "not_resolved"]]);
    assert.doesNotMatch(result.reason, /reply_missing/);
    assert.match(result.reason, /delta_blocked[^]*fix it, re-run the delta review/);
    assert.equal(hasPost(calls), false);
  });
});

test("a cannot_verify record blocks the Fixed reply and reports the delta status", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "cannot_verify" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete.map((entry) => [entry.failedStep, entry.deltaStatus]), [["delta_blocked", "cannot_verify"]]);
    assert.equal(hasPost(calls), false);
  });
});

test("a fixingCommitSha git cannot resolve fails closed while a blocking record exists", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { candidate: "d".repeat(40), items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, (args) => (
      args[0] === "rev-parse" ? { code: 1 } : { code: 0 }
    ));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.incomplete[0]?.failedStep, "delta_blocked");
    assert.equal(hasPost(calls), false);
  });
});

test("git merge-base exit 128 (object missing) fails closed instead of reading as not covered", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { candidate: "d".repeat(40), items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([unresolvedT1(), compareEntry(FIX_SHA, "ahead")], repoRoot, (args) => (
      args[0] === "rev-parse" ? { code: 0, stdout: `${FIX_SHA}\n` } : { code: 128 }
    ));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.incomplete[0]?.failedStep, "delta_blocked");
    assert.equal(hasPost(calls), false);
  });
});

test("a record whose baseline..candidate range excludes the fixing commit still lets the Fixed reply post", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { candidate: "d".repeat(40), items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([
      unresolvedT1(),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot, (args) => (args[0] === "rev-parse" ? { code: 0, stdout: `${FIX_SHA}\n` } : { code: 1 }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(calls), true);
  });
});

test("a resolved delta item for the thread still lets the Fixed reply post", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "resolved" }, { ref: "PRRT_T2", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([
      unresolvedT1(),
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_T1", isResolved: true } } } })}\n` },
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: true, comments: { nodes: [{ id: "c1", databaseId: 101, body: "please fix", author: { login: "reviewer", __typename: "User" } }, { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }] } },
      ]),
    ], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(calls), true);
  });
});

test("a not_resolved delta record also blocks resolving a thread whose Fixed reply already exists", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "PRRT_T1", status: "not_resolved" }] });
    const { deps, calls } = runtimeWithGit([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [{ id: "c1", databaseId: 101, body: `Fixed in commit ${FIX_SHA}.`, author: null }] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
    ], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete.map((entry) => [entry.failedStep, entry.deltaStatus]), [["delta_blocked", "not_resolved"]]);
    assert.deepEqual(result.actions, []);
    assert.equal(calls.some((call) => call.args.includes("graphql") && call.args.some((arg) => String(arg).includes("resolveReviewThread"))), false, "thread was not resolved");
  });
});

test("the finding marker is found on any comment of the thread, not only the id-first one", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_T1", fixingCommitSha: FIX_SHA, disposition: "tackled" }]);
    await writeDeltaRecord(repoRoot, { items: [{ ref: "0123456789abcdef", status: "not_resolved" }] });
    const { deps } = runtimeWithGit([
      threadsCallEntry([
        { id: "PRRT_T1", isResolved: false, comments: { nodes: [
          { id: "c2", databaseId: 200, body: "<!-- dev-loops:finding 0123456789abcdef -->\nroot", author: { login: "reviewer", __typename: "User" } },
          { id: "c1", databaseId: 100, body: "earlier id, no marker", author: { login: "reviewer", __typename: "User" } },
        ] } },
      ]),
      compareEntry(FIX_SHA, "ahead"),
    ], repoRoot, () => ({ code: 0, stdout: `${FIX_SHA}\n` }));
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete.map((entry) => [entry.failedStep, entry.deltaStatus]), [["delta_blocked", "not_resolved"]]);
  });
});

const ACT_FP = "0123456789abcdef";
const ACT_MARKER = `<!-- dev-loops:finding ${ACT_FP} severity=medium angle=correctness round=1 -->`;
const ACT_LIST = [{ fingerprint: ACT_FP, severity: "medium", summary: "s", judgeDisposition: "act" }];
const userEntry = { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "gate" })}\n` };
const gateComment = (id, databaseId, body = `${ACT_MARKER}\n**Problem:** s`, login = "gate") => ({ id, databaseId, body, author: { login, __typename: "User" } });
const actThread = (id, comments, isResolved = false) => ({ id, isResolved, comments: { nodes: comments } });

async function completionFixture(repoRoot, kind = "resolved") {
  const baseline = FIX_SHA;
  const fixing = "d".repeat(40);
  const second = "fedcba9876543210";
  const actList = [ACT_FP, ACT_FP, second].map((fingerprint, index) => ({ ...ACT_LIST[0], fingerprint, siteQuery: "query", acceptedForms: [`--${index}`] }));
  const sequence = startDeltaSequence({ reviewBaselineHead: baseline, actList });
  const residual = kind !== "resolved";
  const isResidual = (index) => residual && (kind === "residual" || index === (kind === "repeated-mixed" ? 1 : 2));
  const items = sequence.actItems.map(({ ref }, index) => ({ ref, status: isResidual(index) ? "cannot_verify" : "resolved", evidence: ["recorded result"] }));
  const siteCoverage = [ACT_FP, second].map((fingerprint, index) => ({
    fingerprint, returnedSites: index ? ["--2"] : ["--0", "--1"],
    sites: (index ? ["--2"] : ["--0", "--1"]).map((site) => ({ site, kind: "input_form", status: isResidual(Number(site.slice(2))) ? "skipped" : "fixed", ...(isResidual(Number(site.slice(2))) ? { reason: "  still unverified at invocation three  " } : { test: "  focused test reference  " }) })),
  }));
  const coverageDigest = sha256Hex(siteCoverage).slice(7);
  const delta = { reviewBaselineHead: baseline, candidateHead: residual ? "e".repeat(40) : HEAD_SHA, actSetId: sequence.actSetId, actionableItems: items, newFindings: [], widenedReads: [], outcome: residual ? "bounded_out" : "locally_clear", siteCoverageDigest: coverageDigest };
  const decision = { ...delta, candidateHead: HEAD_SHA, invocation: residual ? 3 : 1, nextStep: residual ? "push_to_gate" : "push", items };
  const threadBindings = kind === "threadless" ? [] : [{ threadId: "PRRT_MERGED", fingerprints: [ACT_FP, second] }, { threadId: "PRRT_SHARED", fingerprints: [ACT_FP] }];
  const origin = { executionIdentity: "f0-1234abcd", workOrderRef: `fixer:${REPO}#${PR}:${baseline}:f0-1234abcd`, workOrderDigest: `sha256:${"1".repeat(64)}` };
  const source = { headSha: HEAD_SHA, fixingCommitSha: fixing, siteCoverage, threadBindings, origin };
  const dispositions = threadBindings.map(({ threadId, fingerprints }) => ({ threadId, fixingCommitSha: fixing, disposition: actList.some((item, index) => fingerprints.includes(item.fingerprint) && isResidual(index)) ? "deferred" : "tackled" }));
  const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision, handoffText: JSON.stringify({ headSha: HEAD_SHA, dispositions, siteCoverage }) });
  const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
  const sourcePath = path.join(path.dirname(fixerPlan), "completion.json");
  const originPath = path.join(path.dirname(fixerPlan), origin.executionIdentity, "fixer-disposition.json");
  await mkdir(path.dirname(originPath), { recursive: true });
  await writeFile(pullReceiptPath(path.join(repoRoot, "tmp"), origin.workOrderRef), JSON.stringify({ ...origin, role: "fixer", subject: { repo: REPO, pr: PR, branch: "issue-1", headSha: baseline, phase: "commit_only", planPath: fixerPlan } }));
  await writeFile(originPath, JSON.stringify({ headSha: fixing, dispositions: [], siteCoverage }));
  await writeFile(path.join(repoRoot, "tmp", "gate-delta", `${baseline}.json`), JSON.stringify(decision));
  const sourceRead = { kind: "completion-input", path: sourcePath, required: true, sha256: "" };
  plan.workOrder.requiredReads.push(sourceRead);
  const seal = async () => {
    const bytes = `${JSON.stringify(source, null, 2)}\n`;
    await writeFile(sourcePath, bytes);
    sourceRead.sha256 = createHash("sha256").update(bytes).digest("hex");
    Object.assign(plan.workOrder.authority, { completionInputDigest: sha256Hex(source).slice(7), completionInputBytesDigest: sourceRead.sha256 });
    plan.workOrderDigest = workOrderDigest(plan.workOrder);
    await writeFile(fixerPlan, JSON.stringify(plan));
    await writeFile(pullReceiptPath(path.join(repoRoot, "tmp"), plan.workOrderRef), JSON.stringify({ role: "fixer", workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity, subject: { repo: REPO, pr: PR, branch: "issue-1", headSha: HEAD_SHA, phase: "full", planPath: fixerPlan } }));
    await writeFile(plan.workOrder.outputRefs[0], JSON.stringify({ headSha: HEAD_SHA, dispositions, siteCoverage }));
  };
  await seal();
  const nodes = threadBindings.map(({ threadId, fingerprints }, index) => actThread(threadId, [gateComment(`c${index}`, index + 1, fingerprints.map((fp) => `<!-- dev-loops:finding ${fp} severity=medium angle=correctness round=1 -->`).join("\n") + `\nFixed in commit ${fixing}.`)], dispositions[index].disposition === "tackled"));
  const depsFor = (extra = []) => runtime([compareEntry(baseline, "ahead"), compareEntry(fixing, "ahead"), liveHeadEntry(), threadsCallEntry(nodes), userEntry, ...extra], repoRoot, { live: false });
  return { fixerPlan, plan, source, sourceRead, sourcePath, originPath, baseline, fixing, nodes, dispositions, seal, depsFor };
}

test("typed completion CLI rejects construct/check together", () => {
  const args = ["--repo", REPO, "--pr", String(PR), "--head-sha", HEAD_SHA, "--fixer-plan", "plan", "--construct"];
  assert.equal(parseVerifyFixerDispositionCliArgs(args).construct, true);
  assert.throws(() => parseVerifyFixerDispositionCliArgs([...args, "--check"]), /mutually exclusive/);
});

for (const check of [false, true]) for (const defect of ["partial", "coverage", "dispositionCoverage", "fixing", "membership", "bytes", "origin", "delta"]) test(`typed completion normal/check retains optional authentication (${check}, ${defect})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot);
    if (defect === "partial") {
      delete f.plan.workOrder.authority.completionInputBytesDigest;
      f.plan.workOrderDigest = workOrderDigest(f.plan.workOrder);
      await writeFile(f.fixerPlan, JSON.stringify(f.plan));
      const receiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), f.plan.workOrderRef);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      receipt.workOrderDigest = f.plan.workOrderDigest;
      await writeFile(receiptPath, JSON.stringify(receipt));
    }
    if (defect === "membership") { f.source.threadBindings[0].fingerprints.pop(); await f.seal(); }
    const output = f.plan.workOrder.outputRefs[0];
    const raw = JSON.parse(await readFile(output, "utf8"));
    if (defect === "coverage") raw.siteCoverage[0].sites[0].test = "invented test";
    if (defect === "dispositionCoverage") Object.assign(raw.dispositions[0], {
      ...structuredClone(raw.siteCoverage[0]),
      sites: raw.siteCoverage[0].sites.map((site) => ({ ...site, test: "invented test" })),
    });
    if (defect === "fixing") raw.dispositions[0].fixingCommitSha = FIX_SHA;
    await writeFile(output, JSON.stringify(raw));
    if (defect === "bytes") await writeFile(f.sourcePath, `${await readFile(f.sourcePath, "utf8")} `);
    if (defect === "origin") await rm(f.originPath);
    if (defect === "delta") await rm(path.join(repoRoot, "tmp", "gate-delta", `${f.baseline}.json`));
    const before = [await readFile(output, "utf8"), (await stat(output)).mtimeMs];
    const mock = f.depsFor();
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.fixerPlan, check }, mock.deps),
      defect === "dispositionCoverage" ? /disposition-level coverage cannot override authenticated completion input/ : undefined);
    assert.deepEqual([await readFile(output, "utf8"), (await stat(output)).mtimeMs], before);
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const check of [false, true]) test(`typed completion accepts scalar fingerprint hints without coverage overrides (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot);
    const output = f.plan.workOrder.outputRefs[0];
    const raw = JSON.parse(await readFile(output, "utf8"));
    raw.dispositions[1].fingerprint = ACT_FP;
    await writeFile(output, JSON.stringify(raw));
    const mock = f.depsFor([compareEntry(f.fixing, "ahead")]);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.fixerPlan, check }, mock.deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const check of [false, true]) test(`legacy ACT retains disposition-level coverage without optional completion authority (${check})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const actList = [{ ...ACT_LIST[0], siteQuery: "query", acceptedForms: ["--flag"] }];
    const dispositions = [{ threadId: "PRRT_LEGACY", fixingCommitSha: FIX_SHA, disposition: "deferred", fingerprint: ACT_FP,
      returnedSites: ["--flag"], sites: [{ site: "--flag", kind: "input_form", status: "fixed", test: "legacy form test" }] }];
    const fixerPlan = await deliver(repoRoot, dispositions, { actList });
    const mock = runtime([threadsCallEntry([actThread("PRRT_LEGACY", [gateComment("c1", 1)])]), userEntry], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, mock.deps);
    assert.equal(result.complete, true);
    assert.equal(hasPost(mock.calls), false);
  });
});

for (const kind of ["resolved", "mixed", "repeated-mixed", "residual", "threadless"]) test(`typed completion constructs exact authenticated coverage and shared-root dispositions (${kind})`, async () => {
  await withRepoRoot(async (repoRoot) => {
    const f = await completionFixture(repoRoot, kind);
    await rm(f.plan.workOrder.outputRefs[0]);
    const options = { repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.fixerPlan, construct: true };
    const mock = f.depsFor();
    const constructed = await verifyFixerDisposition(options, mock.deps);
    assert.equal(constructed.constructed, true);
    assert.equal(constructed.complete, undefined);
    assert.equal(constructed.outputRef, f.plan.workOrder.outputRefs[0]);
    const raw = JSON.parse(await readFile(constructed.outputRef, "utf8"));
    assert.deepEqual(raw, { headSha: HEAD_SHA, dispositions: f.dispositions, siteCoverage: f.source.siteCoverage });
    assert.deepEqual(await checkpointFiles(repoRoot), []);
    assert.equal(hasPost(mock.calls), false);
    for (const check of [false, true]) {
      const next = f.depsFor(f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead")] : []);
      const verified = await verifyFixerDisposition({ ...options, construct: false, check }, next.deps);
      assert.equal(verified.complete, true);
      assert.deepEqual(verified.actions, []);
      assert.equal(hasPost(next.calls), false);
    }
    const parsedThreads = parseReviewThreads(JSON.parse(threadsPayload(f.nodes)));
    const resolver = f.depsFor([...f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead")] : [], ...f.dispositions.some((entry) => entry.disposition === "tackled") ? [compareEntry(f.fixing, "ahead")] : []]);
    assert.equal((await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA, parsedThreads }, resolver.deps)).complete, true);
  });
});

for (const defect of ["partial", "duplicateRead", "optionalRead", "semantic", "bytes", "byteAuthority", "sourceHead", "fixingHead", "originIdentity", "originRef", "originDigest", "originReceipt", "originSubject", "originOutput", "originCoverage", "originPrePull", "deltaCoverage", "decisionCoverage", "baselineContainment", "fixContainment", "duplicateRoot", "duplicateMember", "emptyMembers", "unknownMember", "omittedRoot", "omittedMember", "foreignRoot", "unmarkedRoot", "replyMarker", "residualResolved", "prePull", "currentReceipt", "currentSubject", "currentPath", "outputPath", "outputSymlink", "directorySymlink", "role", "target", "planDigest", "noSource", "noDelta", "sourceAuthority"]) {
  test(`typed completion refuses ${defect} without output/checkpoint/GitHub writes`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const f = await completionFixture(repoRoot, defect === "residualResolved" ? "mixed" : "resolved");
      if (defect === "sourceHead") f.source.headSha = FIX_SHA;
      if (defect === "fixingHead") f.source.fixingCommitSha = "abc1234";
      if (defect === "originIdentity") f.source.origin.executionIdentity = f.plan.executionIdentity;
      if (defect === "originRef") f.source.origin.workOrderRef = f.plan.workOrderRef;
      if (defect === "originDigest") f.source.origin.workOrderDigest = "sha256:wrong";
      if (defect === "duplicateRoot") f.source.threadBindings.push(f.source.threadBindings[0]);
      if (defect === "duplicateMember") f.source.threadBindings[0].fingerprints.push(ACT_FP);
      if (defect === "emptyMembers") f.source.threadBindings[0].fingerprints = [];
      if (defect === "unknownMember") f.source.threadBindings[0].fingerprints.push("1111111111111111");
      if (defect === "omittedRoot") f.source.threadBindings.pop();
      if (defect === "omittedMember") f.source.threadBindings[0].fingerprints.pop();
      await f.seal();
      if (defect === "partial") delete f.plan.workOrder.authority.completionInputDigest;
      if (defect === "duplicateRead") f.plan.workOrder.requiredReads.push(f.sourceRead);
      if (defect === "optionalRead") f.sourceRead.required = false;
      if (defect === "semantic") f.plan.workOrder.authority.completionInputDigest = "0".repeat(64);
      if (defect === "byteAuthority") f.plan.workOrder.authority.completionInputBytesDigest = "0".repeat(64);
      if (defect === "noSource") { f.plan.workOrder.requiredReads.pop(); delete f.plan.workOrder.authority.completionInputDigest; delete f.plan.workOrder.authority.completionInputBytesDigest; }
      if (defect === "noDelta") f.plan.workOrder.requiredReads = f.plan.workOrder.requiredReads.filter((read) => read.kind !== "delta-result");
      if (defect === "sourceAuthority") delete f.plan.workOrder.authority.sourceDigest;
      if (defect === "role") f.plan.workOrder.role = "judge";
      if (defect === "target") f.plan.workOrder.target.pr++;
      if (defect === "outputPath") f.plan.workOrder.outputRefs[0] = path.join(repoRoot, "other.json");
      f.plan.workOrderDigest = workOrderDigest(f.plan.workOrder);
      const currentReceiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), f.plan.workOrderRef);
      const current = JSON.parse(await readFile(currentReceiptPath, "utf8"));
      current.workOrderDigest = f.plan.workOrderDigest;
      if (defect === "currentSubject") current.subject.phase = "commit_only";
      if (defect === "currentPath") current.subject.planPath = path.join(repoRoot, "other-plan.json");
      await writeFile(currentReceiptPath, JSON.stringify(current));
      if (defect === "currentReceipt") await rm(currentReceiptPath);
      if (defect === "planDigest") f.plan.workOrderDigest = "sha256:wrong";
      await writeFile(f.fixerPlan, JSON.stringify(f.plan));
      if (defect === "bytes") await writeFile(f.sourcePath, `${await readFile(f.sourcePath, "utf8")} `);
      const originReceiptPath = pullReceiptPath(path.join(repoRoot, "tmp"), `fixer:${REPO}#${PR}:${f.baseline}:f0-1234abcd`);
      if (defect === "originReceipt") await rm(originReceiptPath);
      if (defect === "originSubject") { const receipt = JSON.parse(await readFile(originReceiptPath, "utf8")); receipt.subject.headSha = HEAD_SHA; await writeFile(originReceiptPath, JSON.stringify(receipt)); await utimes(originReceiptPath, 1, 1); }
      if (defect === "originOutput") await writeFile(f.originPath, JSON.stringify({ headSha: FIX_SHA, dispositions: [], siteCoverage: f.source.siteCoverage }));
      if (defect === "originCoverage") await writeFile(f.originPath, JSON.stringify({ headSha: f.fixing, dispositions: [], siteCoverage: [] }));
      if (defect === "originPrePull") await utimes(f.originPath, 1, 1);
      if (["deltaCoverage", "decisionCoverage"].includes(defect)) {
        const file = defect === "deltaCoverage" ? f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result").path : path.join(repoRoot, "tmp", "gate-delta", `${f.baseline}.json`);
        const value = JSON.parse(await readFile(file, "utf8")); value.siteCoverageDigest = "0".repeat(64);
        await writeFile(file, JSON.stringify(value));
        if (defect === "deltaCoverage") {
          f.plan.workOrder.requiredReads.find((read) => read.kind === "delta-result").sha256 = createHash("sha256").update(JSON.stringify(value)).digest("hex");
          f.plan.workOrder.authority.deltaResultDigest = sha256Hex(value).slice(7);
          f.plan.workOrderDigest = workOrderDigest(f.plan.workOrder); current.workOrderDigest = f.plan.workOrderDigest;
          await writeFile(f.fixerPlan, JSON.stringify(f.plan)); await writeFile(currentReceiptPath, JSON.stringify(current));
        }
      }
      if (defect === "foreignRoot") f.nodes[0].comments.nodes[0].author.login = "foreign";
      if (defect === "unmarkedRoot") f.nodes[0].comments.nodes[0].body = "no marker";
      if (defect === "replyMarker") f.nodes[0].comments.nodes.unshift(gateComment("c0", 0, "unmarked root"));
      if (defect === "residualResolved") f.nodes[0].isResolved = true;
      const canonical = path.join(path.dirname(f.fixerPlan), f.plan.executionIdentity, "fixer-disposition.json");
      if (defect === "prePull") await utimes(canonical, 1, 1); else await rm(canonical);
      if (["outputSymlink", "directorySymlink"].includes(defect)) {
        const other = path.join(repoRoot, "unrelated");
        await mkdir(other);
        await writeFile(path.join(other, "fixer-disposition.json"), "must remain unchanged");
        if (defect === "directorySymlink") { await rm(path.dirname(canonical), { recursive: true }); await symlink(other, path.dirname(canonical), "dir"); }
        else await symlink(path.join(other, "fixer-disposition.json"), canonical);
      }
      const before = existsSync(canonical) ? await readFile(canonical, "utf8") : null;
      const entries = [compareEntry(f.baseline, defect === "baselineContainment" ? "diverged" : "ahead"), compareEntry(f.fixing, defect === "fixContainment" ? "diverged" : "ahead"), liveHeadEntry(), threadsCallEntry(f.nodes), userEntry];
      const mock = runtime(entries, repoRoot, { live: false });
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan: f.fixerPlan, construct: true }, mock.deps));
      assert.equal(existsSync(canonical) ? await readFile(canonical, "utf8") : null, before);
      assert.deepEqual(await checkpointFiles(repoRoot), []);
      assert.equal(hasPost(mock.calls), false);
    });
  });
}

for (const mismatched of [false, true]) {
  test(`locally-clear full completion ${mismatched ? "rejects a mismatched" : "accepts a whitespace-padded current"} result candidate`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const actList = [{ ...ACT_LIST[0], siteQuery: "query", acceptedForms: ["--flag"] }];
      const sequence = startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList });
      const siteCoverage = [{ fingerprint: ACT_FP, returnedSites: ["--flag"], sites: [{ site: "--flag", kind: "input_form", status: "fixed", test: "targeted form test" }] }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: ` ${HEAD_SHA} `, actSetId: sequence.actSetId, actionableItems: [{ ref: ACT_FP, status: "resolved", evidence: ["targeted check"] }], newFindings: [], widenedReads: [], outcome: "locally_clear" };
      const next = decideDeltaNextStep({ sequence, result: delta, invocation: 1, currentHead: HEAD_SHA, siteCoverage });
      assert.equal(next.outcome, "locally_clear");
      assert.equal(next.nextStep, "push");
      const decision = { ...next, reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: sequence.actSetId, invocation: 1, items: delta.actionableItems };
      if (mismatched) delta.candidateHead = ` ${FIX_SHA} `;
      const handoffText = JSON.stringify({ headSha: HEAD_SHA, dispositions: [], siteCoverage });
      const fixerPlan = await deliver(repoRoot, [], { actList, delta, decision, handoffText });
      const { deps, calls } = runtime([threadsCallEntry([]), userEntry], repoRoot);
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
      if (mismatched) {
        await assert.rejects(verify(), /neither locally clear nor invocation-three bounded_out/);
        assert.equal(calls.length, 0);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        assert.equal((await verify()).complete, true);
        assert.equal((await checkpointFiles(repoRoot)).length, 1);
      }
      assert.equal(hasPost(calls), false);
    });
  });
}

for (const check of [false, true]) for (const defect of [null, "missing", "nonclearing", "source", "delta", "bytes", "baseline", "membership", "statuses", "candidate", "invocation", "tackled", "resolved", "resolvedForms", "unaccounted", "unbound", "residualResolved", "residualResolvedOmitted", "residualUnmarked", "residualForeign", "residualMissing", "legacy"]) {
  test(`bounded-out full completion authenticates residual authority (${check}, ${defect})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const actList = [{ ...ACT_LIST[0], siteQuery: "query", acceptedForms: ["--flag"] }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: FIX_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList }).actSetId, actionableItems: [{ ref: ACT_FP, status: "not_resolved", evidence: ["still fails"] }], newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items: [{ ref: ACT_FP, status: "not_resolved" }] };
      if (defect === "nonclearing") decision.nextStep = "fix_and_rereview";
      if (defect === "baseline") delta.reviewBaselineHead = FIX_SHA;
      if (defect === "membership") delta.actionableItems[0].ref = "foreign";
      if (defect === "statuses") decision.items[0].status = "cannot_verify";
      if (defect === "candidate") decision.candidateHead = FIX_SHA;
      if (defect === "invocation") decision.invocation = 2;
      if (["resolved", "resolvedForms"].includes(defect)) { delta.actionableItems[0].status = "resolved"; decision.items[0].status = "resolved"; }
      const dispositions = [{ threadId: "PRRT_RESIDUAL", fingerprint: defect === "unbound" ? null : ACT_FP, fixingCommitSha: HEAD_SHA, disposition: ["tackled", "resolvedForms", "unbound"].includes(defect) ? "tackled" : "deferred", returnedSites: ["--flag"], sites: defect === "unaccounted" ? [] : [{ site: "--flag", kind: "input_form", status: "skipped", reason: "still fails after invocation three" }] }];
      const handoffText = ["unbound", "residualResolvedOmitted"].includes(defect) ? JSON.stringify({ headSha: HEAD_SHA, dispositions: defect === "residualResolvedOmitted" ? [] : dispositions, siteCoverage: [{ ...dispositions[0], fingerprint: ACT_FP }] }) : null;
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision: defect === "missing" ? null : decision, semanticAuthority: defect !== "legacy", handoffText });
      if (["source", "delta", "bytes"].includes(defect)) {
        const plan = JSON.parse(await readFile(fixerPlan, "utf8"));
        const read = plan.workOrder.requiredReads.find((entry) => entry.kind === (defect === "source" ? "act-list" : "delta-result"));
        const altered = defect === "source" ? [{ ...actList[0], summary: "tampered" }] : { ...delta, newFindings: [{ severity: "low", summary: "tampered", evidence: ["x"] }] };
        await writeFile(read.path, JSON.stringify(altered));
        if (defect !== "bytes") read.sha256 = createHash("sha256").update(JSON.stringify(altered)).digest("hex");
        assert.equal(workOrderDigest(plan.workOrder), plan.workOrderDigest, "local byte hashes cannot change semantic authority");
        await writeFile(fixerPlan, JSON.stringify(plan));
      }
      const root = gateComment("c1", 1);
      if (defect === "residualUnmarked") root.body = "Unmarked review finding";
      if (defect === "residualForeign") root.author.login = "reviewer";
      const resolvedResidual = ["residualResolved", "residualResolvedOmitted", "residualUnmarked", "residualForeign"].includes(defect);
      const nodes = defect === "residualMissing" ? [] : [actThread("PRRT_RESIDUAL", [root], resolvedResidual)];
      const { deps, calls } = runtime([threadsCallEntry(nodes), userEntry], repoRoot);
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (defect) {
        const expected = { missing: /delta clearing decision/, nonclearing: /delta clearing decision/, source: /authority.sourceDigest/, delta: /authority.deltaResultDigest/, bytes: /delta result differs from its sha256/, baseline: /pinned baseline/, membership: /not in the act set/, statuses: /delta clearing decision/, candidate: /actual pushed candidate/, invocation: /invocation-three/, tackled: /delta status and live thread disposition disagree/, resolved: /fixed status and a test/, resolvedForms: /fixed status and a test/, unaccounted: /returned site/, unbound: /delta status and live thread disposition disagree/, residualResolved: /delta status and live thread disposition disagree/, residualResolvedOmitted: /delta status and live thread disposition disagree/, legacy: /fixed status and a test/ };
        const before = await readFile(fixerPlan, "utf8");
        await assert.rejects(verify(), ["residualUnmarked", "residualForeign", "residualMissing"].includes(defect) ? /delta status and live thread disposition disagree/ : expected[defect]);
        assert.equal(calls.length, defect === "tackled" || defect === "unbound" || resolvedResidual || defect === "residualMissing" ? 3 : 0, "authority fails before GitHub mutation or checkpoint");
        assert.deepEqual(await checkpointFiles(repoRoot), []);
        assert.equal(await readFile(fixerPlan, "utf8"), before);
      } else {
        const before = await readFile(fixerPlan, "utf8");
        const result = await verify();
        assert.equal(result.complete, true, "only tackled disposition completion; residual is still open");
        assert.deepEqual(result.actions, []);
        assert.equal(nodes[0].isResolved, false);
        assert.equal(calls.length, 3);
        assert.equal(await readFile(fixerPlan, "utf8"), before);
        if (check) assert.deepEqual(await checkpointFiles(repoRoot), []);
      }
    });
  });
}

for (const check of [false, true]) for (const kind of ["threadless-mixed", "threadless-fixed", "live-mixed", "live-deferred", "residual", "resolved"]) {
  test(`repeated fingerprint completion preserves ref statuses (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const refuses = kind.endsWith("mixed");
      const live = !kind.startsWith("threadless");
      const fixed = kind === "threadless-fixed" || kind === "live-mixed" || kind === "resolved";
      const actList = ["--first", "--second"].map((form) => ({ ...ACT_LIST[0], siteQuery: "query", acceptedForms: [form] }));
      const statuses = !live ? ["not_resolved", "resolved"] : ["live-mixed", "live-deferred"].includes(kind) ? ["resolved", "cannot_verify"] : kind === "resolved" ? ["resolved", "resolved"] : ["not_resolved", "cannot_verify"];
      const items = statuses.map((status, index) => ({ ref: index ? `${ACT_FP}#2` : ACT_FP, status }));
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: FIX_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["targeted check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const dispositions = live ? [{ threadId: "PRRT_REPEAT", fixingCommitSha: HEAD_SHA, disposition: fixed ? "tackled" : "deferred" }] : [];
      const handoffText = JSON.stringify({ headSha: HEAD_SHA, dispositions, siteCoverage: [{ fingerprint: ACT_FP, returnedSites: ["--first", "--second"], sites: ["--first", "--second"].map((site, index) => ({ site, kind: "input_form", status: fixed || (kind === "live-deferred" && index === 0) ? "fixed" : "skipped", ...(fixed || (kind === "live-deferred" && index === 0) ? { test: "targeted form test" } : { reason: "still fails at invocation three" }) })) }] });
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision, handoffText });
      const nodes = live ? [actThread("PRRT_REPEAT", [gateComment("c1", 1, `${ACT_MARKER}\n${fixed ? `Fixed in commit ${HEAD_SHA}.` : "still fails"}`)], fixed)] : [];
      const { deps, calls } = runtime([threadsCallEntry(nodes), userEntry, ...(live && fixed ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
      const before = await readFile(fixerPlan, "utf8");
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (refuses) {
        await assert.rejects(verify(), live ? /delta status and live thread disposition disagree/ : /fixed status and a test/);
        assert.equal(calls.length, live ? 3 : 0, "refuses before checkpoint or GitHub mutation");
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        const result = await verify();
        assert.equal(result.complete, true);
        assert.deepEqual(result.actions, []);
        assert.equal(calls.length, live && fixed ? 4 : 3);
        if (check) assert.deepEqual(await checkpointFiles(repoRoot), []);
      }
      assert.equal(await readFile(fixerPlan, "utf8"), before);
    });
  });
}

for (const check of [false, true]) for (const [kind, statuses, disposition, member] of [
  ["resolved-first", ["resolved", "resolved"], "tackled", 0],
  ["resolved-second", ["resolved", "resolved"], "tackled", 1],
  ["residual-first", ["not_resolved", "cannot_verify"], "deferred", 0],
  ["residual-second", ["not_resolved", "cannot_verify"], "deferred", 1],
  ["foreign", ["resolved", "resolved", "resolved"], "tackled", 2],
  ["unknown-hint", ["resolved", "not_resolved"], "deferred", 2],
  ["mixed-tackled", ["resolved", "not_resolved"], "tackled", 0],
  ["mixed-deferred", ["resolved", "not_resolved"], "deferred", 1],
  ["mixed-resolved-hint", ["resolved", "not_resolved"], "deferred", 0],
  ["mixed-no-hint", ["resolved", "cannot_verify"], "deferred", null],
  ["resolved-deferred", ["resolved", "resolved"], "deferred", 0],
  ["resolved-residual", ["not_resolved", "cannot_verify"], "deferred", 0],
  ["incomplete-coverage", ["resolved", "resolved"], "tackled", 0],
]) {
  test(`distinct merged fingerprints validate every member (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fingerprints = [ACT_FP, "fedcba9876543210", "1111111111111111"];
      const actList = statuses.map((status, index) => ({ ...ACT_LIST[0], fingerprint: fingerprints[index], siteQuery: "query", acceptedForms: [`--member-${index}`] }));
      const items = statuses.map((status, index) => ({ ref: fingerprints[index], status }));
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["targeted check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const dispositions = [{ threadId: "PRRT_MERGED", fingerprint: member === null ? undefined : fingerprints[member], fixingCommitSha: HEAD_SHA, disposition }];
      const siteCoverage = actList.map((item, index) => ({ fingerprint: item.fingerprint, returnedSites: item.acceptedForms, sites: item.acceptedForms.map((site) => ({ site, kind: "input_form", status: statuses[index] === "resolved" ? "fixed" : "skipped", ...(statuses[index] === "resolved" ? { test: "targeted member test" } : { reason: "still fails at invocation three" }) })) }));
      if (kind === "incomplete-coverage") siteCoverage[1].sites = [];
      const handoffText = JSON.stringify({ headSha: HEAD_SHA, dispositions, siteCoverage });
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision, handoffText });
      const fixed = disposition === "tackled";
      const root = `${ACT_MARKER}\n${ACT_MARKER.replace(ACT_FP, fingerprints[1])}\n**Problem:** merged members`;
      const nodes = [actThread("PRRT_MERGED", [gateComment("c1", 1, root), ...(fixed ? [gateComment("c2", 2, `Fixed in commit ${HEAD_SHA}.`)] : [])], fixed || kind === "resolved-residual")];
      const { deps, calls } = runtime([threadsCallEntry(nodes), userEntry, ...(fixed ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
      const before = await readFile(fixerPlan, "utf8");
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (["foreign", "unknown-hint", "mixed-tackled", "resolved-deferred", "resolved-residual", "incomplete-coverage"].includes(kind)) {
        await assert.rejects(verify(), kind === "incomplete-coverage" ? /returned site/ : /delta status and live thread disposition disagree/);
        assert.equal(calls.length, kind === "incomplete-coverage" ? 0 : 3);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        const result = await verify();
        assert.equal(result.complete, true);
        assert.deepEqual(result.actions, []);
        assert.equal(calls.length, fixed ? 4 : 3);
        assert.equal((await checkpointFiles(repoRoot)).length, check ? 0 : 1);
      }
      assert.equal(hasPost(calls), false);
      assert.equal(await readFile(fixerPlan, "utf8"), before);
    });
  });
}

async function checkpointFiles(repoRoot) {
  const entries = await readdir(path.join(repoRoot, "tmp"), { recursive: true }).catch(() => []);
  return entries.filter((entry) => path.basename(entry).startsWith("fixer-disposition-"));
}

for (const check of [false, true]) for (const kind of ["resolved", "residual", "omitted-open", "omitted-resolved", "unknown", "missing-status", "unmarked", "foreign", "reply-only"]) {
  test(`shared fingerprint roots preserve authenticated membership (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const status = ["resolved", "omitted-resolved"].includes(kind) ? "resolved" : kind === "unknown" ? "unknown" : "cannot_verify";
      const items = kind === "missing-status" ? [] : [{ ref: ACT_FP, status }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList: ACT_LIST }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const resolved = status === "resolved";
      const dispositions = ["PRRT_A", "PRRT_B"].map((threadId) => ({ threadId, fingerprint: ACT_FP, fixingCommitSha: HEAD_SHA, disposition: resolved ? "tackled" : "deferred" }));
      if (kind.startsWith("omitted")) dispositions.pop();
      const fixerPlan = await deliver(repoRoot, dispositions, { actList: ACT_LIST, delta, decision });
      const nodes = ["PRRT_A", "PRRT_B"].map((id, index) => actThread(id, [gateComment(`c${index}`, 100 + index, `${ACT_MARKER}\n${resolved ? `Fixed in commit ${HEAD_SHA}.` : "residual"}`)], resolved));
      if (kind === "unmarked" || kind === "reply-only") nodes[1].comments.nodes[0].body = "no root marker";
      if (kind === "reply-only") nodes[1].comments.nodes.push(gateComment("c9", 109));
      if (kind === "foreign") nodes[1].comments.nodes[0].author.login = "someone-else";
      const entries = [threadsCallEntry(nodes), userEntry, ...(resolved && !kind.startsWith("omitted") ? [compareEntry(HEAD_SHA, "identical")] : [])];
      const { deps, calls } = runtime(entries, repoRoot);
      const promise = verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (["resolved", "residual"].includes(kind)) {
        const result = await promise;
        assert.equal(result.complete, true);
        assert.deepEqual(result.actions, []);
        assert.equal((await checkpointFiles(repoRoot)).length, check ? 0 : 1);
        if (!check) {
          const checkpoint = JSON.parse(await readFile(path.resolve(repoRoot, result.checkpointPath), "utf8"));
          assert.equal(checkpoint.dispositions.length, 2);
          const { deps } = runtime([...entries, ...(resolved ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
          const shared = await resolveFixerDispositionInput({ repo: REPO, pr: PR, currentHeadSha: HEAD_SHA, parsedThreads: parseReviewThreads(JSON.parse(threadsPayload(nodes))) }, deps);
          assert.equal(shared.complete, true);
        }
      } else {
        await assert.rejects(promise, kind.startsWith("omitted") ? /no disposition entry.*PRRT_B/ : ["unknown", "missing-status"].includes(kind) ? /Invalid delta result/ : /delta status and live thread disposition disagree/);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      }
      assert.equal(hasPost(calls), false);
      assert.equal(calls.some(({ args }) => args.some((arg) => String(arg).includes("mutation"))), false);
    });
  });
}

test("a full-phase handoff that omits a disposition entry for an open gate thread carrying a judge-act fingerprint fails, names the thread and writes no checkpoint", async () => {
  const liveThreads = threadsCallEntry([actThread("PRRT_ACT", [gateComment("c1", 101)])]);
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const { deps } = runtime([liveThreads, userEntry], repoRoot);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps),
      /PRRT_ACT/,
    );
    assert.deepEqual(await checkpointFiles(repoRoot), []);
  });
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_ACT", fixingCommitSha: FIX_SHA, disposition: "tackled" }], { actList: ACT_LIST });
    const { deps } = runtime([
      liveThreads,
      userEntry,
      compareEntry(FIX_SHA, "ahead"),
      { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_ACT", isResolved: true } } } })}\n` },
      threadsCallEntry([
        actThread("PRRT_ACT", [gateComment("c1", 101), { id: "c2", databaseId: 102, body: `Fixed in commit ${FIX_SHA}.`, author: { login: "gate-bot", __typename: "Bot" } }], true),
      ]),
    ], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.equal(result.complete, true);
  });
});

test("an act item with no fingerprint field is matched by its derived fingerprint, so an undispositioned open gate thread still fails", async () => {
  const derived = fingerprintFinding({ summary: "s" });
  const marker = ACT_MARKER.replace(ACT_FP, derived);
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: [{ severity: "medium", summary: "s", judgeDisposition: "act" }] });
    const { deps } = runtime([threadsCallEntry([actThread("PRRT_DERIVED", [gateComment("c1", 103, `${marker}\n**Problem:** s`)])]), userEntry], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps), /PRRT_DERIVED/);
  });
});

for (const check of [false, true]) for (const kind of ["resolved", "resolved-deferred", "residual-hint", "repeated-mixed"]) {
  test(`derived fingerprint roots use authenticated Delta statuses (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const derived = fingerprintFinding({ summary: "s" });
      const actList = kind === "repeated-mixed"
        ? ["first", "second"].map((ref) => ({ ref, severity: "medium", summary: "s", judgeDisposition: "act" }))
        : [{ severity: "medium", summary: "s", judgeDisposition: "act" }];
      const sequence = startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList });
      const items = sequence.actItems.map(({ ref }, index) => ({ ref, status: kind === "residual-hint" || (kind === "repeated-mixed" && index === 1) ? "cannot_verify" : "resolved" }));
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: sequence.actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["targeted check"] })), newFindings: [], widenedReads: [], outcome: "bounded_out" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: sequence.actSetId, invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items };
      const tackled = kind === "resolved";
      const dispositions = [{ threadId: "PRRT_DERIVED", ...(kind === "residual-hint" ? { fingerprint: derived } : {}), fixingCommitSha: HEAD_SHA, disposition: tackled ? "tackled" : "deferred" }];
      const fixerPlan = await deliver(repoRoot, dispositions, { actList, delta, decision });
      const body = `${ACT_MARKER.replace(ACT_FP, derived)}\n${tackled ? `Fixed in commit ${HEAD_SHA}.` : "residual"}`;
      const { deps, calls } = runtime([threadsCallEntry([actThread("PRRT_DERIVED", [gateComment("c1", 103, body)], tackled)]), userEntry, ...(tackled ? [compareEntry(HEAD_SHA, "identical")] : [])], repoRoot);
      const verify = () => verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps);
      if (kind === "resolved-deferred") {
        await assert.rejects(verify(), /delta status and live thread disposition disagree/);
        assert.deepEqual(await checkpointFiles(repoRoot), []);
      } else {
        const result = await verify();
        assert.equal(result.complete, true);
        assert.deepEqual(result.actions, []);
        assert.equal((await checkpointFiles(repoRoot)).length, check ? 0 : 1);
      }
      assert.equal(hasPost(calls), false);
    });
  });
}

for (const check of [false, true]) for (const kind of ["foreign", "unmarked", "unbound"]) {
  test(`semantic ACT delivery refuses unauthenticated roots without scalar hints (${check}, ${kind})`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const items = [{ ref: ACT_FP, status: "resolved" }];
      const delta = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: startDeltaSequence({ reviewBaselineHead: HEAD_SHA, actList: ACT_LIST }).actSetId, actionableItems: items.map((item) => ({ ...item, evidence: ["check"] })), newFindings: [], widenedReads: [], outcome: "locally_clear" };
      const decision = { reviewBaselineHead: HEAD_SHA, candidateHead: HEAD_SHA, actSetId: delta.actSetId, invocation: 1, outcome: "locally_clear", nextStep: "push", items };
      const fixerPlan = await deliver(repoRoot, [{ threadId: "PRRT_EXTRA", fixingCommitSha: HEAD_SHA, disposition: "tackled" }], { actList: ACT_LIST, delta, decision });
      const root = gateComment("c1", 101, kind === "unmarked" ? "No marker" : kind === "unbound" ? ACT_MARKER.replace(ACT_FP, "fedcba9876543210") : ACT_MARKER, kind === "foreign" ? "reviewer" : "gate");
      const { deps, calls } = runtime([
        threadsCallEntry([actThread("PRRT_EXTRA", [root])]), userEntry, compareEntry(HEAD_SHA, "identical"),
        { assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/101/replies`], stdout: `${JSON.stringify({ id: 555, html_url: "https://example.com/555" })}\n` },
        { assertArgs: ["api", "graphql"], assertArgContains: ["resolveReviewThread"], stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_EXTRA", isResolved: true } } } })}\n` },
        threadsCallEntry([actThread("PRRT_EXTRA", [root, gateComment("c2", 102, `Fixed in commit ${HEAD_SHA}.`)], true)]),
      ], repoRoot);
      await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, check }, deps), /delta status and live thread disposition disagree/);
      assert.deepEqual(await checkpointFiles(repoRoot), []);
      assert.equal(hasPost(calls), false);
      assert.equal(calls.some(({ args }) => args.some((arg) => String(arg).includes("mutation"))), false);
    });
  });
}

test("an act item matching a non-primary marker of a merged gate thread root still fails naming the thread", async () => {
  const merged = `<!-- dev-loops:finding fedcba9876543210 severity=medium angle=correctness round=1 -->\n${ACT_MARKER}\n**Problem:** s`;
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const { deps } = runtime([threadsCallEntry([actThread("PRRT_MERGED", [gateComment("c1", 104, merged)])]), userEntry], repoRoot);
    await assert.rejects(verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps), /PRRT_MERGED/);
  });
});

// Two open gate threads carrying one act fingerprint: each needs its own entry, whatever the API order.
for (const [name, listOrder, dispositioned] of [
  ["only the API-last thread dispositioned", ["PRRT_A", "PRRT_B"], "PRRT_B"],
  ["only the API-first thread dispositioned", ["PRRT_A", "PRRT_B"], "PRRT_A"],
]) {
  test(`two open gate threads on one act fingerprint fail naming the undispositioned one (${name})`, async () => {
    const missing = dispositioned === "PRRT_A" ? "PRRT_B" : "PRRT_A";
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [{ threadId: dispositioned, fixingCommitSha: FIX_SHA, disposition: "tackled" }], { actList: ACT_LIST });
      const { deps } = runtime([
        threadsCallEntry(listOrder.map((id, i) => actThread(id, [gateComment(`c${i}`, 200 + i)]))),
        userEntry,
      ], repoRoot);
      await assert.rejects(
        verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps),
        new RegExp(missing),
      );
    });
  });
}

test("the act-thread guard finds the root by databaseId when a reply's node id sorts first", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
    const { deps } = runtime([
      threadsCallEntry([actThread("PRRT_ACT", [gateComment("c9", 401), gateComment("c1", 402, "reply without marker")])]),
      userEntry,
    ], repoRoot);
    await assert.rejects(
      verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps),
      /PRRT_ACT/,
    );
  });
});

test("two open gate threads on one act fingerprint, both dispositioned, pass the act-thread guard", async () => {
  await withRepoRoot(async (repoRoot) => {
    const fixerPlan = await deliver(repoRoot, [
      { threadId: "PRRT_A", fixingCommitSha: FIX_SHA, disposition: "deferred" },
      { threadId: "PRRT_B", fixingCommitSha: FIX_SHA, disposition: "deferred" },
    ], { actList: ACT_LIST });
    const { deps } = runtime([
      threadsCallEntry([actThread("PRRT_A", [gateComment("c1", 201)]), actThread("PRRT_B", [gateComment("c2", 202)])]),
      userEntry,
    ], repoRoot);
    const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
    assert.deepEqual(result.incomplete, []);
  });
});

// Only a thread whose ROOT comment is authored by the gate login is an act thread.
for (const [name, nodes, isResolved] of [
  ["a root comment authored by a non-gate login quoting the marker", [gateComment("c1", 301, undefined, "someone-else")]],
  ["a marker only on a reply comment, not the root", [gateComment("c1", 302, "root without marker"), gateComment("c2", 303)]],
  ["a resolved gate thread carrying the act fingerprint", [gateComment("c1", 304)], true],
  ["an open gate thread whose fingerprint is not on the act list", [gateComment("c1", 305, ACT_MARKER.replace(ACT_FP, "fedcba9876543210"))]],
]) {
  test(`the act-thread guard ignores ${name}`, async () => {
    await withRepoRoot(async (repoRoot) => {
      const fixerPlan = await deliver(repoRoot, [], { actList: ACT_LIST });
      const { deps } = runtime([threadsCallEntry([actThread("PRRT_FOREIGN", nodes, isResolved)]), userEntry], repoRoot);
      const result = await verifyFixerDisposition({ repo: REPO, pr: PR, headSha: HEAD_SHA, fixerPlan, tmpRoot: "tmp" }, deps);
      assert.equal(result.ok, true);
    });
  });
}
