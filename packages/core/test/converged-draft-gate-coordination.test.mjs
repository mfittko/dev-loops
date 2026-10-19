import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  parseGateReviewCommentBody,
  parseGateReviewCommentMarkerBody,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../src/github/copilot-helpers.mjs";
import { DISPOSITION, STATE } from "../src/loop/copilot-loop-state.mjs";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "../src/loop/pr-gate-coordination.mjs";

const A = "a".repeat(40);
const FIX = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

const commentBody = ({ gate = "draft_gate", head = A, verdict = "clean", converged = `fixer \`${FIX}\` delta \`${DIGEST}\`` } = {}) => [
  `### Gate review: \`${gate}\``,
  "",
  `**Reviewed head SHA:** \`${head}\``,
  `**Verdict:** ${verdict}`,
  ...(converged === null ? [] : [`**Converged:** ${converged}`]),
  "**Findings summary:** 3 low findings fixed",
  "**Next action:** mark ready for review",
].join("\n");

const comment = (body, id = 1) => ({ id, body, updated_at: "2026-10-20T00:00:00Z" });
const markerAt = (head, bodies) => summarizeGateReviewCommentMarkers(bodies.map((b, i) => comment(b, i + 1)), { headSha: head });

describe("Converged marker field", () => {
  test("a valid line parses to the fixer commit and delta digest, backward compatible when absent", () => {
    assert.deepEqual(parseGateReviewCommentBody(commentBody()).converged, { fixerCommit: FIX, deltaDigest: DIGEST });
    assert.equal(parseGateReviewCommentBody(commentBody({ converged: null })).converged, undefined);
    assert.equal(Object.hasOwn(parseGateReviewCommentMarkerBody(commentBody({ converged: null })), "converged"), false);
  });

  test("a malformed digest, sha or shape parses as malformed, never as absent", () => {
    for (const converged of [
      `fixer \`${FIX}\` delta \`sha256:${"c".repeat(63)}\``,
      `fixer \`${FIX}\` delta \`${"c".repeat(64)}\``,
      `fixer \`bbbbbbb\` delta \`${DIGEST}\``,
      `fixer \`${FIX}\``,
      "yes",
    ]) {
      assert.deepEqual(parseGateReviewCommentBody(commentBody({ converged })).converged, { malformed: true }, converged);
    }
  });

  test("the first Converged line wins", () => {
    const body = commentBody().replace("**Findings summary:**", `**Converged:** fixer \`${"d".repeat(40)}\` delta \`${DIGEST}\`\n**Findings summary:**`);
    assert.equal(parseGateReviewCommentBody(body).converged.fixerCommit, FIX);
  });
});

describe("converged draft_gate marker for the fixed head", () => {
  test("a clean converged draft_gate comment at A is the draft_gate marker at the fixer commit", () => {
    const marker = markerAt(FIX, [commentBody()]).draft_gate;
    assert.equal(marker.headSha, FIX);
    assert.equal(marker.convergedFromHeadSha, A);
    assert.equal(marker.verdict, "clean");
    assert.equal(marker.contractComplete, true);
    assert.equal(markerAt(A, [commentBody()]).draft_gate.convergedFromHeadSha, undefined);
  });

  test("a missing, malformed, other-head, non-clean or non-draft marker does not cover the fixer commit", () => {
    const other = "e".repeat(40);
    for (const body of [
      commentBody({ converged: null }),
      commentBody({ converged: `fixer \`${FIX}\` delta \`sha256:short\`` }),
      commentBody({ converged: `fixer \`${other}\` delta \`${DIGEST}\`` }),
      commentBody({ verdict: "findings_present" }),
      commentBody({ gate: "pre_approval_gate" }),
    ]) {
      const markers = markerAt(FIX, [body]);
      assert.equal(markers.draft_gate, null, body);
    }
    assert.equal(markerAt(FIX, [commentBody({ gate: "pre_approval_gate" })]).pre_approval_gate, null);
  });

  test("the comment summary keeps the head the comment reviewed and exposes the marker", () => {
    const summary = summarizeGateReviewComments([comment(commentBody())]).draft_gate;
    assert.equal(summary.headSha, A);
    assert.deepEqual(summary.converged, { fixerCommit: FIX, deltaDigest: DIGEST });
  });
});

describe("gate coordination for a converged draft_gate", () => {
  const stateAt = (bodies, overrides = {}) => {
    const comments = bodies.map((b, i) => comment(b, i + 1));
    const draftGate = summarizeGateReviewComments(comments).draft_gate;
    const draftGateMarker = summarizeGateReviewCommentMarkers(comments, { headSha: FIX }).draft_gate;
    return evaluatePrGateCoordination({
      pr: 10,
      currentHeadSha: FIX,
      prDraft: true,
      lifecycleState: STATE.PR_DRAFT,
      loopDisposition: DISPOSITION.ACTION_REQUIRED,
      ciStatus: "success",
      draftGate: draftGate ?? { visible: false },
      draftGateMarker: draftGateMarker ?? { visible: false },
      ...overrides,
    });
  };

  test("the converged draft_gate state returns mark_ready_for_review, then pre_approval_gate", () => {
    const draft = stateAt([commentBody()]);
    assert.equal(draft.nextAction, PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW);
    assert.equal(draft.draftGate.currentHeadClean, true);

    const comments = [comment(commentBody())];
    const ready = evaluatePrGateCoordination({
      pr: 10,
      currentHeadSha: FIX,
      prDraft: false,
      lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
      loopDisposition: DISPOSITION.CLEAN_CONVERGED,
      sameHeadCleanConverged: true,
      ciStatus: "success",
      draftGate: summarizeGateReviewComments(comments).draft_gate,
      draftGateMarker: summarizeGateReviewCommentMarkers(comments, { headSha: FIX }).draft_gate,
      preApprovalGate: { visible: false },
      preApprovalGateMarker: { visible: false },
    });
    assert.equal(ready.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  });

  test("a missing or malformed converged marker keeps the full draft_gate round", () => {
    for (const body of [commentBody({ converged: null }), commentBody({ converged: "fixer nonsense" })]) {
      const state = stateAt([body]);
      assert.equal(state.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
      assert.equal(state.draftGate.currentHeadClean, false);
    }
  });

  test("a converged marker for another fixer commit keeps the full draft_gate round", () => {
    const state = stateAt([commentBody()], { currentHeadSha: "e".repeat(40), draftGateMarker: { visible: false } });
    assert.equal(state.nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE);
  });
});
