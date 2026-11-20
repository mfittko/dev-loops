// Judge-bound `reject=` / `defer=` copilot-body-disposition records.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "bun:test";
import { hasOperatorDispositionMarker, operatorMarkerWrapPattern, parseCopilotBodyDispositionMarker } from "../../packages/core/src/github/copilot-body-disposition-marker.mjs";
import { resolveCopilotBodyDisposition, resolveCurrentHeadBodyFeedback } from "../../scripts/github/_copilot-body-disposition.mjs";
import { buildLogPath } from "../../scripts/github/_gate-artifact-paths.mjs";

const REPO = "o/r";
const PR = 7;
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REVIEW = "PRR_kwDOjudge";
const record = ({ action = "reject", gate = "pre_approval_gate", review = REVIEW, head = HEAD, association = "OWNER" } = {}) => ({
  id: 1,
  body: `<!-- dev-loops:copilot-body-disposition review=${review} head=${head} ${action}=${gate} -->`,
  user: { login: "alice", type: "User" },
  author_association: association,
});
const runtimeFor = (comments, root) => ({
  ledgerCheckouts: [root],
  runChild: async () => ({ code: 0, stderr: "", stdout: comments.map((c) => `${JSON.stringify(c)}\n`).join("") }),
});
const finding = (overrides = {}) => ({ angle: "copilot-body", severity: "low", summary: "s", reviewId: REVIEW, judgeDisposition: "reject", ...overrides });

let root;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "judge-record-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

let seq = 0;
// Each case gets its own checkout so ledgers never leak between cases.
async function checkoutWith(findings, { gate = "pre_approval_gate", head = HEAD, raw = null, seal = null } = {}) {
  const dir = path.join(root, `case-${seq++}`);
  if (findings !== null || raw !== null) {
    const file = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate, headSha: head, tmpRoot: "tmp" }));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw ?? JSON.stringify({ findings }));
    if (seal !== null) await writeFile(`${file}.seal`, seal);
  } else await mkdir(dir, { recursive: true });
  return dir;
}
const resolve = (comments, checkout, reviewCommitSha = HEAD) => resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: REVIEW, reviewCommitSha }, runtimeFor(comments, checkout));

describe("parser", () => {
  test("the new forms parse with a judge binding and are not operator records", () => {
    const parsed = parseCopilotBodyDispositionMarker(record({ action: "defer", gate: "draft_gate" }).body);
    assert.deepEqual(parsed, { reviewId: REVIEW, headSha: HEAD, fixSha: null, operator: false, judgeBinding: { action: "defer", gate: "draft_gate" } });
    assert.equal(parseCopilotBodyDispositionMarker(record({ gate: "other_gate" }).body), null);
  });
  test("the operator wrap pattern and operator detection match the operator form only", () => {
    for (const action of ["reject", "defer"]) {
      assert.equal(operatorMarkerWrapPattern().test(record({ action }).body), false);
      assert.equal(hasOperatorDispositionMarker(record({ action }).body), false);
    }
    assert.equal(hasOperatorDispositionMarker(`<!-- dev-loops:copilot-body-disposition review=R head=${HEAD} operator -->`), true);
  });
});

describe("resolver", () => {
  test("a reject record clears a body finding the judge rejected", async () => {
    const result = await resolve([record()], await checkoutWith([finding()]));
    assert.equal(result.cleared, true);
    assert.deepEqual(result.disposition.judgeBinding, { action: "reject", gate: "pre_approval_gate" });
  });
  test("a defer record clears defer and reject dispositions; a reject record refuses defer", async () => {
    for (const judgeDisposition of ["defer", "reject"]) assert.equal((await resolve([record({ action: "defer" })], await checkoutWith([finding({ judgeDisposition })]))).cleared, true);
    assert.equal((await resolve([record({ action: "reject" })], await checkoutWith([finding({ judgeDisposition: "defer" })]))).cleared, false);
  });
  test("an untrusted author never clears", async () => {
    assert.equal((await resolve([record({ association: "NONE" })], await checkoutWith([finding()]))).cleared, false);
  });
  const refusals = [
    ["another review id", () => [record({ review: "PRR_other" })], () => checkoutWith([finding()])],
    ["another head", () => [record({ head: OTHER_HEAD })], () => checkoutWith([finding()])],
    ["a missing ledger", () => [record()], () => checkoutWith(null)],
    ["a ledger for another head", () => [record()], () => checkoutWith([finding()], { head: OTHER_HEAD })],
    ["an unreadable ledger", () => [record()], () => checkoutWith(null, { raw: "{not json" })],
    ["a ledger for another gate", () => [record()], () => checkoutWith([finding()], { gate: "draft_gate" })],
    ["no copilot-body finding", () => [record()], () => checkoutWith([finding({ angle: "tests" })])],
    ["an act disposition", () => [record()], () => checkoutWith([finding({ judgeDisposition: "act" })])],
    ["a missing disposition", () => [record()], () => checkoutWith([finding({ judgeDisposition: undefined })])],
    ["one act among rejects", () => [record()], () => checkoutWith([finding(), finding({ judgeDisposition: "act" })])],
    ["another review's finding", () => [record()], () => checkoutWith([finding({ reviewId: "PRR_other" })])],
    ["a finding with no reviewId", () => [record()], () => checkoutWith([finding({ reviewId: undefined })])],
    ["a missing severity", () => [record()], () => checkoutWith([finding({ severity: undefined })])],
    ["a legacy must-fix severity", () => [record()], () => checkoutWith([finding({ severity: "must-fix" })])],
    ["a padded high severity", () => [record()], () => checkoutWith([finding({ severity: " high " })])],
    ["a high finding", () => [record()], () => checkoutWith([finding({ severity: "high" })])],
    ["a critical finding", () => [record({ action: "defer" })], () => checkoutWith([finding({ severity: "critical", judgeDisposition: "defer" })])],
  ];
  test("a review on another head is never cleared by the new forms", async () => {
    assert.equal((await resolve([record()], await checkoutWith([finding()]), OTHER_HEAD)).cleared, false);
  });
  test("one passing and one act ledger copy refuse; two passing copies clear", async () => {
    const pass = await checkoutWith([finding()]);
    const act = await checkoutWith([finding({ judgeDisposition: "act" })]);
    const rt = runtimeFor([record()], pass);
    const run = (checkouts) => resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: REVIEW, reviewCommitSha: HEAD }, { ...rt, ledgerCheckouts: checkouts });
    assert.equal((await run([pass, act])).cleared, false);
    assert.equal((await run([pass, await checkoutWith(null)])).cleared, true);
  });
  for (const [name, comments, checkout] of refusals) {
    test(`${name} does not clear`, async () => {
      assert.equal((await resolve(comments(), await checkout())).cleared, false);
    });
  }
});

describe("ledger integrity and cross-gate verdicts", () => {
  test("a ledger whose seal does not match its bytes does not clear", async () => {
    assert.equal((await resolve([record()], await checkoutWith([finding()], { seal: `${"0".repeat(64)}\n` }))).cleared, false);
  });
  test("a later pre_approval_gate act verdict stops a reject=draft_gate record from clearing", async () => {
    const dir = await checkoutWith([finding()], { gate: "draft_gate" });
    const other = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" }));
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, JSON.stringify({ findings: [finding({ judgeDisposition: "act" })] }));
    assert.equal((await resolve([record({ gate: "draft_gate" })], dir)).cleared, false);
  });
  test("the other gate's ledger without a finding for the review leaves the named gate's verdict in force", async () => {
    const dir = await checkoutWith([finding()], { gate: "draft_gate" });
    const other = path.join(dir, buildLogPath({ repo: REPO, pr: PR, gate: "pre_approval_gate", headSha: HEAD, tmpRoot: "tmp" }));
    await mkdir(path.dirname(other), { recursive: true });
    await writeFile(other, JSON.stringify({ findings: [finding({ angle: "tests", judgeDisposition: "act" })] }));
    assert.equal((await resolve([record({ gate: "draft_gate" })], dir)).cleared, true);
  });
});

describe("resolveCurrentHeadBodyFeedback with a judge-bound record", () => {
  const review = { id: REVIEW, state: "COMMENTED", author: { login: "copilot-pull-request-reviewer[bot]" }, commit: { oid: HEAD }, submittedAt: "2026-05-31T20:10:00Z", body: "### 🟡 Changes recommended\n\nFix the thing." };
  const summary = { hasBodyFindingOnCurrentHead: true, bodyFindingReviewId: REVIEW, effectiveCopilotReviews: [review] };
  // The review's inline threads are all reply-resolved as rejected.
  const reviewThreads = [{ isResolved: true, comments: { nodes: [{ pullRequestReview: { id: REVIEW }, body: "Rejected: out of scope." }] } }];
  const feedback = (comment, checkout) => resolveCurrentHeadBodyFeedback({ repo: REPO, pr: PR, headSha: HEAD, reviewSummary: summary, reviewThreads }, runtimeFor([comment], checkout));
  test("a cleared judge-bound record clears the body finding and keeps the judge finding stamped with the reviewId", async () => {
    const result = await feedback(record(), await checkoutWith([finding()]));
    assert.equal(result.copilotBodyFeedbackUnresolved, false);
    assert.equal(result.dispositionRequired, null);
    assert.equal(result.judgeFinding.findings[0].reviewId, REVIEW);
  });
  test("a cleared operator record leaves no judge finding", async () => {
    const operator = { ...record(), body: `<!-- dev-loops:copilot-body-disposition review=${REVIEW} head=${HEAD} operator -->` };
    const result = await feedback(operator, await checkoutWith(null));
    assert.equal(result.copilotBodyFeedbackUnresolved, false);
    assert.equal(result.judgeFinding, null);
  });
});
