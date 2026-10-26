// Node-id marker rule (#2937 AC16) and the judge finding for a body-only Copilot review.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildJudgeFinding, copilotBodyJudgePath, resolveCopilotBodyDisposition, resolveCurrentHeadBodyFeedback } from "../../scripts/github/_copilot-body-disposition.mjs";

const HEAD = "a".repeat(40);
const NODE_ID = "PRR_kwDOAbc123";
const marker = (review) => `<!-- dev-loops:copilot-body-disposition review=${review} head=${HEAD} operator -->`;
const runtimeWith = (reviewId) => ({
  runChild: async () => ({ code: 0, stderr: "", stdout: `${JSON.stringify({ id: 1, body: marker(reviewId), user: { login: "alice" }, author_association: "OWNER" })}\n` }),
});
const review = { id: NODE_ID, state: "COMMENTED", author: { login: "copilot-pull-request-reviewer[bot]" }, commit: { oid: HEAD }, submittedAt: "2026-05-31T20:10:00Z", body: "### 🟡 Changes recommended\n\nFix the thing." };
const reviewSummary = { hasBodyFindingOnCurrentHead: true, bodyFindingReviewId: NODE_ID, effectiveCopilotReviews: [review] };
const resolve = (reviewId) => resolveCurrentHeadBodyFeedback({ repo: "o/r", pr: 1, headSha: HEAD, reviewSummary, reviewThreads: [] }, runtimeWith(reviewId));

test("a marker naming a numeric review id for a node-id review is refused as review_id_mismatch naming both ids", async () => {
  const result = await resolveCopilotBodyDisposition({ repo: "o/r", pr: 1, headSha: HEAD, reviewId: NODE_ID, reviewCommitSha: HEAD }, runtimeWith("5648696420"));
  assert.equal(result.cleared, false);
  assert.equal(result.reasonCode, "review_id_mismatch");
  assert.match(result.reason, /5648696420/);
  assert.ok(result.reason.includes(NODE_ID));
});

test("the required-disposition record carries the exact node-id marker line and the judge finding", async () => {
  const feedback = await resolve("5648696420");
  assert.equal(feedback.dispositionRequired.reasonCode, "review_id_mismatch");
  assert.equal(feedback.dispositionRequired.markerLine, marker(NODE_ID));
  assert.equal(feedback.judgeFinding.angle, "copilot-body");
  assert.equal(feedback.judgeFinding.findings[0].severity, "medium");
  assert.equal(feedback.judgeFinding.findings[0].summary, "Fix the thing.");
  assert.match(feedback.judgeFinding.findings[0].recommendation, /Fix the thing\./);
});

test("an operator marker with the node id still clears and leaves no judge finding", async () => {
  const feedback = await resolve(NODE_ID);
  assert.equal(feedback.copilotBodyFeedbackUnresolved, false);
  assert.equal(feedback.judgeFinding, null);
  assert.notEqual(feedback.bodyDisposition, null);
});

test("a numeric marker clears a numeric review id", async () => {
  const result = await resolveCopilotBodyDisposition({ repo: "o/r", pr: 1, headSha: HEAD, reviewId: "5648696420", reviewCommitSha: HEAD }, runtimeWith("5648696420"));
  assert.equal(result.cleared, true);
});

test("a current-head tie (null bodyFindingReviewId) forwards every signaling body, mixed severities included", async () => {
  const mk = (id, heading, text) => ({ ...review, id, body: `### ${heading}\n\n${text}` });
  const summary = { hasBodyFindingOnCurrentHead: true, bodyFindingReviewId: null, effectiveCopilotReviews: [mk("PRR_a", "🟡 Changes recommended", "First."), mk("PRR_b", "🔵 Needs a closer look", "Second.")] };
  const feedback = await resolveCurrentHeadBodyFeedback({ repo: "o/r", pr: 1, headSha: HEAD, reviewSummary: summary, reviewThreads: [] }, runtimeWith("PRR_zzz"));
  assert.deepEqual(feedback.judgeFinding.findings.map((f) => [f.severity, f.summary]), [["medium", "First."], ["low", "Second."]]);
});

test("buildJudgeFinding maps severity, skips headings and keeps the full body", () => {
  const low = buildJudgeFinding({ state: "COMMENTED", body: "### 🔵 Needs a closer look\n\nLook again." });
  assert.equal(low.findings[0].severity, "low");
  assert.equal(low.findings[0].summary, "Look again.");
  const long = buildJudgeFinding({ state: "COMMENTED", body: `### 🟡 Changes recommended\n\n${"x".repeat(5000)}TAIL` });
  assert.equal(long.findings[0].severity, "medium");
  assert.ok(long.findings[0].recommendation.endsWith("TAIL"));
});

test("copilotBodyJudgePath rejects a bad pr or head", () => {
  assert.throws(() => copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr: 0, headSha: HEAD }));
  assert.throws(() => copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr: 1, headSha: "../x" }));
  assert.ok(copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr: 1, headSha: HEAD }).endsWith(`copilot-body-${HEAD}.json`));
  assert.ok(copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr: 2940, headSha: "b".repeat(64) }).includes("pr-2940"));
  for (const pr of ["0x10", "1e1", " 7 "]) {
    assert.throws(() => copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr, headSha: HEAD }), /positive integer/);
  }
  assert.throws(() => copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr: 1, headSha: "a".repeat(41) }), /40 or 64/);
  assert.throws(() => copilotBodyJudgePath({ tmpRoot: "t", repo: "o/r", pr: 1, headSha: "a".repeat(63) }), /40 or 64/);
});

test("an ambiguous blocking tie on an earlier head carries every tied body to the judge", async () => {
  const OLD = "c".repeat(40);
  const tied = (id, text) => ({ ...review, id, commit: { oid: OLD }, body: `### 🟡 Changes recommended\n\n${text}` });
  const feedback = await resolveCurrentHeadBodyFeedback(
    { repo: "o/r", pr: 1, headSha: HEAD, reviewSummary: { effectiveCopilotReviews: [tied("PRR_a", "First body."), tied("PRR_b", "Second body.")] }, reviewThreads: [] },
    runtimeWith(NODE_ID),
  );
  assert.equal(feedback.dispositionRequired.reviewId, null);
  const summaries = feedback.judgeFinding.findings.map((f) => f.summary).sort();
  assert.deepEqual(summaries, ["First body.", "Second body."]);
});
