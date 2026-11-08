// ADR 0258: gate writers wrap a bare operator-owned phrase in reviewer or judge
// free text in a code span, so the strict guard no longer refuses the round.
// Every case also asserts the raw phrase IS asserting under the real reader (so
// the test cannot pass vacuously) and that the wrapped phrase is not.
import assert from "node:assert/strict";
import { test } from "bun:test";

import { guardCommentBodyNoIssuePrIds } from "../../packages/core/src/github/comment-id-guard.mjs";
import { wrapOperatorOwnedPhrases, findOperatorOwnedLineRefusal } from "../../packages/core/src/github/operator-owned-lines.mjs";
import { parseCopilotBodyDispositionMarker } from "../../packages/core/src/github/copilot-body-disposition-marker.mjs";
import { verifyFreshHumanApproval } from "../../packages/core/src/loop/merge-approval.mjs";
import { extractWaiverLines } from "../../scripts/loop/adr-waiver-markers.mjs";
import { resolveApprovalState } from "../../scripts/release/verify-release-approval.mjs";
import { renderFindingLine, renderInlineCommentBody, renderNonLocatableBlock, buildDeferredFindingsComment } from "../../scripts/github/_gate-finding-surface.mjs";
import { escapeProse, sanitizeInline, parseFindings, renderBoundedFindingsCommentBody } from "../../scripts/github/post-gate-findings.mjs";
import { buildMeritRationale } from "../../scripts/github/close-gate-findings.mjs";
import { parseUpsertCheckpointVerdictCliArgs } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { runCli as runCommentIssue } from "../../scripts/github/comment-issue.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

const SHA = "a".repeat(40);
const MARKER = `<!-- dev-loops:copilot-body-disposition review=9 head=${SHA} operator -->`;
const PHRASES = [
  `approve merge ${SHA}`,
  "approve release v1.2.3",
  "adr-tripwire:allow hand written reason",
  MARKER,
];

// True when any real reader accepts `body` (as an operator comment) as an assertion.
function asserts(body) {
  const merge = verifyFreshHumanApproval({ approvedBy: "op", currentHeadSha: SHA, comments: [{ user: { login: "op" }, author: "op", body }] }).satisfied;
  const release = resolveApprovalState({
    version: "1.2.3",
    operator: "op",
    comments: [{ author: "op", body, createdAt: "2026-01-02T00:00:00Z" }],
    releaseRef: "2026-01-01T00:00:00Z",
  }).approved;
  const waiver = extractWaiverLines(body).length > 0;
  const marker = parseCopilotBodyDispositionMarker(body)?.operator === true;
  return { merge, release, waiver, marker };
}
const anyAsserts = (body) => Object.values(asserts(body)).some(Boolean);
const passesGuard = (body) => assert.doesNotThrow(() => guardCommentBodyNoIssuePrIds(body, { ref: "test body" }));

test("readers accept every raw phrase, so the wrap assertions below are not vacuous", () => {
  assert.equal(asserts(PHRASES[0]).merge, true);
  assert.equal(asserts(PHRASES[1]).release, true);
  assert.equal(asserts(PHRASES[2]).waiver, true);
  assert.equal(asserts(PHRASES[3]).marker, true);
  for (const phrase of PHRASES) assert.notEqual(findOperatorOwnedLineRefusal(phrase), null, phrase);
});

test("wrapOperatorOwnedPhrases: every wrapped phrase, also at line start, is non-asserting and passes the guard", () => {
  for (const phrase of PHRASES) {
    const wrapped = wrapOperatorOwnedPhrases(phrase);
    assert.ok(wrapped.startsWith("`") || wrapped.includes("`"), phrase);
    for (const body of [wrapped, `intro\n${wrapped}\ntail`, `> ${wrapped}`, `- ${wrapped}`]) {
      assert.equal(anyAsserts(body), false, body);
      passesGuard(body);
    }
  }
  assert.equal(wrapOperatorOwnedPhrases("approve\nmerge x"), "`approve merge` x");
});

test("escapeProse and sanitizeInline wrap a bare phrase, also when it opens the text", () => {
  for (const phrase of PHRASES) {
    for (const render of [escapeProse, sanitizeInline]) {
      const out = render(phrase);
      assert.notEqual(out.replace(/`/g, ""), "", phrase);
      assert.equal(anyAsserts(out), false, `${render.name}: ${out}`);
      passesGuard(out);
      passesGuard(`${out}\n${out}`);
    }
  }
});

test("a backticked approve-release phrase in a recommendation renders through escapeProse and stays inert", () => {
  const finding = { severity: "medium", angle: "holistic", file: "a.js", line: 3, summary: "s", recommendation: "run `approve release v1.2.3` first" };
  const block = renderNonLocatableBlock(finding, { round: 1 });
  assert.ok(block.includes("`approve release v1.2.3`"), "the reviewer's code span survives (sanitizeInline deleted it)");
  assert.equal(anyAsserts(block), false);
  passesGuard(block);
});

test("inline finding comment: summary, recommendation, failingCase, judgeReason and angle all post wrapped", () => {
  const p = (i) => PHRASES[i];
  for (const code of [false, true]) {
    const body = renderInlineCommentBody({
      severity: "medium",
      angle: `x ${p(1)}`,
      files: ["a.js"],
      line: 3,
      summary: `Problem ${p(1)} here\n${p(2)}`,
      recommendation: `Fix\n${p(0)}`,
      failingCase: code ? `const x = 1;\n${p(0)}\n${p(2)}` : `case\n${p(0)}\n${p(2)}`,
      judgeDisposition: "act",
      judgeReason: `${p(0)} and ${p(3)}`,
    }, { round: 1 });
    assert.equal(anyAsserts(body), false, body);
    passesGuard(body);
    assert.equal(findOperatorOwnedLineRefusal(body), null, body);
  }
});

test("finding line, findings comment, deferred summary and close rationale post wrapped", () => {
  const finding = { severity: "low", angle: "perf", summary: `see\n${PHRASES[0]}`, judgeDisposition: "defer", judgeReason: PHRASES[1] };
  const line = renderFindingLine(finding);
  assert.equal(findOperatorOwnedLineRefusal(line), null);
  const findings = parseFindings(JSON.stringify([{ severity: "medium", angle: "perf", summary: PHRASES.join("\n"), judgeDisposition: "act", judgeReason: PHRASES[2] }]));
  const { body } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  const deferred = buildDeferredFindingsComment({ repo: "o/r", pr: 42, entries: [{ fingerprint: "1111111111111111", severity: "low", angle: "perf", summary: PHRASES.join("\n") }] });
  const rationale = buildMeritRationale({ body: `**low** · perf\n**Problem:** ${PHRASES[0]}`, judgeReason: PHRASES[1], judgeRationale: PHRASES[2] });
  for (const out of [body, deferred, rationale]) {
    assert.equal(anyAsserts(out), false, out);
    passesGuard(out);
    assert.equal(findOperatorOwnedLineRefusal(out), null, out);
  }
});

test("upsert-checkpoint-verdict wraps --findings-summary and --next-action", () => {
  const parsed = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "o/r", "--pr", "17", "--gate", "draft_gate", "--head-sha", SHA, "--verdict", "findings_present",
    "--findings-summary", `see\n${PHRASES[0]} ${PHRASES[1]} ${PHRASES[2]}`,
    "--next-action", PHRASES[0], "--inline-reason", PHRASES[1],
  ]);
  for (const text of [parsed.findingsSummary, parsed.nextAction, parsed.inlineReason]) {
    assert.equal(findOperatorOwnedLineRefusal(text), null, text);
    assert.equal(anyAsserts(text), false, text);
  }
});

test("the wrap is gate-surface only: comment-issue still refuses the same text", async () => {
  for (const phrase of PHRASES) {
    const { run, calls } = makeGhStub([]);
    const stderr = captureStream();
    const code = await runCommentIssue(["--repo", "o/n", "--issue", "7", "--body", phrase], { run, stderr, stdout: captureStream(), env: { PATH: process.env.PATH } });
    assert.equal(code, 1, phrase);
    assert.equal(calls.length, 0);
    assert.match(JSON.parse(stderr.get()).error, /^OPERATOR-OWNED-LINE: /);
  }
});
