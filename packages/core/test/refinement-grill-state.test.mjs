import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildSpecChangeFactsGhArgs,
  detectGrillProvenance,
  detectSimplicityReview,
  detectSpecChangedSinceGrill,
  parseSpecChangeFacts,
  SPEC_CHANGED_SINCE_GRILL_REASON,
  GRILL_STATE,
  GRILL_TRANSITIONS,
  interpretRefinementGrillState,
  normalizeGrillSnapshot,
} from "@dev-loops/core/loop/refinement-grill-state";
import { buildGrillFactsSnapshot } from "@dev-loops/core/loop/issue-refinement-artifact";

const RESULTS_TITLE = "🔬 Grill / refinement results";

test("normalizeGrillSnapshot throws on a non-object", () => {
  assert.throws(() => normalizeGrillSnapshot(null), /non-null object/);
  assert.throws(() => normalizeGrillSnapshot("nope"), /non-null object/);
});

test("normalizeGrillSnapshot applies deterministic defaults and clamps counts", () => {
  const s = normalizeGrillSnapshot({ surface: "bogus", openGapCount: -5, unresolvedGapCount: -1 });
  assert.equal(s.surface, "issue");
  assert.equal(s.openGapCount, 0);
  assert.equal(s.unresolvedGapCount, 0);
  assert.equal(s.targetRef, null);

  const kept = normalizeGrillSnapshot({ surface: "pr", targetRef: " #7 ", openGapCount: 2.9 });
  assert.equal(kept.surface, "pr");
  assert.equal(kept.targetRef, "#7");
  assert.equal(kept.openGapCount, 2);
});

test("interpret returns each of the eight states for its fixture", () => {
  const cases = [
    [{ loaded: false }, GRILL_STATE.LOAD_TARGET],
    [{ loaded: true, detectRan: false }, GRILL_STATE.DETECT_GAPS],
    [{ loaded: true, detectRan: true, openGapCount: 2 }, GRILL_STATE.AWAIT_ANSWERS],
    [{ loaded: true, detectRan: true, answersReady: true }, GRILL_STATE.SYNTHESIZE],
    [{ loaded: true, synthesized: true, reGrillRan: false }, GRILL_STATE.RE_GRILL],
    [{ loaded: true, detectRan: true, openGapCount: 0, provenanceRecorded: true, simplestDesign: true, simplicityReview: true }, GRILL_STATE.GRILL_CLEAN],
    [{ loaded: true, detectRan: true, unresolvedGapCount: 1 }, GRILL_STATE.NEEDS_HUMAN_HANDOFF],
    [{ loadFailed: true }, GRILL_STATE.BLOCKED_NEEDS_USER_DECISION],
  ];
  for (const [snapshot, expected] of cases) {
    assert.equal(interpretRefinementGrillState(snapshot).state, expected, JSON.stringify(snapshot));
  }
});

test("the transition graph is closed", () => {
  const states = new Set(Object.values(GRILL_STATE));
  for (const state of states) {
    assert.ok(state in GRILL_TRANSITIONS, `${state} missing from GRILL_TRANSITIONS`);
  }
  for (const [from, tos] of Object.entries(GRILL_TRANSITIONS)) {
    assert.ok(states.has(from), `unknown from-state ${from}`);
    for (const to of tos) {
      assert.ok(states.has(to), `unknown to-state ${to} from ${from}`);
    }
  }
  for (const terminal of [GRILL_STATE.GRILL_CLEAN, GRILL_STATE.NEEDS_HUMAN_HANDOFF, GRILL_STATE.BLOCKED_NEEDS_USER_DECISION]) {
    assert.deepEqual(GRILL_TRANSITIONS[terminal], [], `${terminal} must be terminal`);
  }
});

test("honest handoff: an unresolved gap outranks answers, synthesis, and open gaps", () => {
  const state = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    unresolvedGapCount: 1,
    answersReady: true,
    synthesized: true,
    openGapCount: 5,
    reGrillRan: true,
    reGrillFixedPoint: true,
  }).state;
  assert.equal(state, GRILL_STATE.NEEDS_HUMAN_HANDOFF);
});

test("already-refined body with recorded provenance reaches grill_clean in zero iterations", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: true, simplestDesign: true, simplicityReview: true,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "provenance_recorded");
  assert.equal(result.bypass, false);
});

test("shape-clean with no recorded provenance does not resolve to grill_clean: the semantic pass is still owed", () => {
  const result = interpretRefinementGrillState({ loaded: true, detectRan: true, openGapCount: 0 });
  assert.equal(result.state, GRILL_STATE.DETECT_GAPS);
  assert.equal(result.reason, "provenance_missing");
  assert.equal(result.bypass, false);
  assert.match(result.nextAction, /🔬 Grill \/ refinement results/);
  assert.match(result.nextAction, /no gaps were found/i);
});

test("a recorded bypass line reaches grill_clean and is flagged as bypass", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: true, simplestDesign: true, simplicityReview: true,
    provenanceBypass: true,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "provenance_bypass_recorded");
  assert.equal(result.bypass, true);
});

test("provenanceBypass is forced false when provenanceRecorded is false: stays at detect_gaps / provenance_missing", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: false,
    provenanceBypass: true,
  });
  assert.equal(result.state, GRILL_STATE.DETECT_GAPS);
  assert.equal(result.reason, "provenance_missing");
  assert.equal(result.bypass, false);
});

test("normalizeGrillSnapshot forces provenanceBypass false when provenanceRecorded is false", () => {
  const s = normalizeGrillSnapshot({ provenanceRecorded: false, provenanceBypass: true });
  assert.equal(s.provenanceBypass, false);
  const kept = normalizeGrillSnapshot({ provenanceRecorded: true, provenanceBypass: true });
  assert.equal(kept.provenanceBypass, true);
});

test("a normal recorded comment (no bypass line) reaches grill_clean with bypass false", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: true, simplestDesign: true, simplicityReview: true,
    provenanceBypass: false,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "provenance_recorded");
  assert.equal(result.bypass, false);
});

test("a plan surface stays shape-only clean even with no recorded provenance", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    surface: "plan",
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "plan_shape_only");
  assert.equal(result.bypass, false);
});

test("an existing results comment on a re-run reaches the zero-iteration clean exit", () => {
  const provenance = detectGrillProvenance([
    { body: `## ${RESULTS_TITLE}\n\nsource: auto (codebase, docs)\n\nNo gaps were found on this pass.` },
  ]);
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: provenance.provenanceRecorded, simplestDesign: true, simplicityReview: true,
    provenanceBypass: provenance.bypass,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "provenance_recorded");
});

test("open gaps outrank recorded provenance and bypass: never a false grill_clean when a gap is still open", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 2,
    provenanceRecorded: true, simplestDesign: true, simplicityReview: true,
    provenanceBypass: true,
  });
  assert.equal(result.state, GRILL_STATE.AWAIT_ANSWERS);
  assert.equal(result.reason, null);
  assert.equal(result.bypass, false);
});

test("a plan surface with a bypass flag set still resolves to plan_shape_only with bypass false", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    surface: "plan",
    provenanceRecorded: true, simplestDesign: true, simplicityReview: true,
    provenanceBypass: true,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "plan_shape_only");
  assert.equal(result.bypass, false);
});

test("non-zero-gap states carry a null reason and bypass false", () => {
  const detect = interpretRefinementGrillState({ loaded: true, detectRan: false });
  assert.equal(detect.reason, null);
  assert.equal(detect.bypass, false);
  const await_ = interpretRefinementGrillState({ loaded: true, detectRan: true, openGapCount: 2 });
  assert.equal(await_.reason, null);
  assert.equal(await_.bypass, false);
});

test("detectGrillProvenance: string and object comment entries, ignoring anything else", () => {
  assert.deepEqual(detectGrillProvenance([{ body: `## ${RESULTS_TITLE}` }]), {
    provenanceRecorded: true,
    bypass: false,
    bypassBy: null,
  });
  assert.deepEqual(detectGrillProvenance([{ body: "unrelated comment" }, 42, null, "also unrelated"]), {
    provenanceRecorded: false,
    bypass: false,
    bypassBy: null,
  });
});

test("detectGrillProvenance: only the exact \"## \" heading counts -- a bare title, a different heading level, or a missing space is rejected", () => {
  const bare = `${RESULTS_TITLE}`;
  assert.deepEqual(detectGrillProvenance([bare]), { provenanceRecorded: false, bypass: false, bypassBy: null });
  assert.equal(detectGrillProvenance([{ body: `### ${RESULTS_TITLE}` }]).provenanceRecorded, false);
  assert.equal(detectGrillProvenance([{ body: `##${RESULTS_TITLE}` }]).provenanceRecorded, false);
  assert.equal(detectGrillProvenance([{ body: `## ${RESULTS_TITLE}` }]).provenanceRecorded, true);
});

test("detectGrillProvenance: non-array input yields no provenance", () => {
  assert.deepEqual(detectGrillProvenance(null), { provenanceRecorded: false, bypass: false, bypassBy: null });
  assert.deepEqual(detectGrillProvenance(undefined), { provenanceRecorded: false, bypass: false, bypassBy: null });
  assert.deepEqual(detectGrillProvenance("not an array"), { provenanceRecorded: false, bypass: false, bypassBy: null });
});

test("detectGrillProvenance: a bypass line inside a results comment is flagged with the handle", () => {
  const result = detectGrillProvenance([
    { body: `## ${RESULTS_TITLE}\n\nbypass: operator-authorized by mfittko\n\nRan anyway.` },
  ]);
  assert.deepEqual(result, { provenanceRecorded: true, bypass: true, bypassBy: "mfittko" });
});

test("detectGrillProvenance: bypass is absent for a normal results comment with no bypass line", () => {
  const result = detectGrillProvenance([{ body: `## ${RESULTS_TITLE}\n\nNo gaps were found.` }]);
  assert.deepEqual(result, { provenanceRecorded: true, bypass: false, bypassBy: null });
});

test("detectGrillProvenance: the title quoted inside a code fence is not a results comment", () => {
  const result = detectGrillProvenance([
    { body: `Here is an example of the heading:\n\n\`\`\`\n## ${RESULTS_TITLE}\n\`\`\`\n\nNot an actual results comment.` },
  ]);
  assert.equal(result.provenanceRecorded, false);
});

test("detectGrillProvenance: the title appearing later in an unrelated reply is not a results comment", () => {
  const result = detectGrillProvenance([
    { body: `Thanks! Replying re: ${RESULTS_TITLE}\n\nJust a comment mentioning it, not posting one.` },
  ]);
  assert.equal(result.provenanceRecorded, false);
});

test("detectGrillProvenance: a leading blank line before the ## heading is still accepted", () => {
  const result = detectGrillProvenance([{ body: `\n\n## ${RESULTS_TITLE}\n\nNo gaps were found.` }]);
  assert.equal(result.provenanceRecorded, true);
});

test("detectGrillProvenance: bypass line accepts an optional @ before the handle", () => {
  const result = detectGrillProvenance([
    { body: `## ${RESULTS_TITLE}\n\nbypass: operator-authorized by @mfittko\n\nRan anyway.` },
  ]);
  assert.deepEqual(result, { provenanceRecorded: true, bypass: true, bypassBy: "mfittko" });
});

test("detectGrillProvenance: bypass key is case-insensitive", () => {
  const result = detectGrillProvenance([
    { body: `## ${RESULTS_TITLE}\n\nBypass: operator-authorized by mfittko\n\nRan anyway.` },
  ]);
  assert.deepEqual(result, { provenanceRecorded: true, bypass: true, bypassBy: "mfittko" });
});

test("detectGrillProvenance: a bypass-shaped line outside any results comment does not count", () => {
  const result = detectGrillProvenance([{ body: "bypass: operator-authorized by mfittko" }]);
  assert.deepEqual(result, { provenanceRecorded: false, bypass: false, bypassBy: null });
});

test("detectGrillProvenance: the tmp transcript path is never a comment, so it never counts", () => {
  // The ephemeral tmp/issues/issue-<n>/grill/<timestamp>.md transcript has no comment
  // surface at all — this asserts the helper only ever sees actual GitHub comments.
  const result = detectGrillProvenance([]);
  assert.equal(result.provenanceRecorded, false);
});

test("fixed point vs iterate after synthesis + re-grill", () => {
  assert.equal(
    interpretRefinementGrillState({ loaded: true, synthesized: true, reGrillRan: true, reGrillFixedPoint: true }).state,
    GRILL_STATE.GRILL_CLEAN,
  );
  assert.equal(
    interpretRefinementGrillState({ loaded: true, synthesized: true, reGrillRan: true, reGrillFixedPoint: false }).state,
    GRILL_STATE.DETECT_GAPS,
  );
});

test("load failure fails closed even alongside a synthesized signal", () => {
  assert.equal(
    interpretRefinementGrillState({ loadFailed: true, loaded: true, synthesized: true }).state,
    GRILL_STATE.BLOCKED_NEEDS_USER_DECISION,
  );
});

test("allowedTransitions equals GRILL_TRANSITIONS for the current state", () => {
  const clean = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: true, simplestDesign: true, simplicityReview: true,
  });
  assert.deepEqual(clean.allowedTransitions, GRILL_TRANSITIONS[GRILL_STATE.GRILL_CLEAN]);
  const detect = interpretRefinementGrillState({ loaded: true, detectRan: false });
  assert.deepEqual(detect.allowedTransitions, GRILL_TRANSITIONS[GRILL_STATE.DETECT_GAPS]);
});

// GRILL-SUBLOOP-SPEC-CHANGED-SINCE-GRILL (issue 3127)
const GRILL_AT = "2026-11-06T10:00:00Z";
const BEFORE = "2026-11-06T09:00:00Z";
const AFTER = "2026-11-06T11:00:00Z";
const resultsComment = (createdAt, extra = "") => ({ body: `## ${RESULTS_TITLE}\n\nNo gaps were found.\n\nsimplicity-review: 0 findings, 0 corrected, 0 rejected${extra}`, createdAt });

const MATRIX = "## AC / DoD matrix\n\n| Criterion outcome | Required completion evidence |\n|---|---|\n| the feature works end to end | a focused test proves the feature works |\n\n## Non-goals\n\n- none\n";
const REFINED = `${MATRIX}\n## Simplest design\n\nOne predicate.\n`;

function grillStateFor({ comments, bodyLastEditedAt = null, surface = "issue" }) {
  return interpretRefinementGrillState(buildGrillFactsSnapshot({ body: REFINED, comments, bodyLastEditedAt, surface }));
}

test("AC1: a counted comment after the latest results comment returns detect_gaps / spec_changed_since_grill", () => {
  const out = grillStateFor({ comments: [resultsComment(GRILL_AT), { body: "Decision: also cover the PR surface.", createdAt: AFTER }] });
  assert.equal(out.state, GRILL_STATE.DETECT_GAPS);
  assert.equal(out.reason, SPEC_CHANGED_SINCE_GRILL_REASON);
  assert.match(out.nextAction, /Re-grill/);
});

test("AC1: a counted comment before the latest results comment does not trigger the reason", () => {
  const out = grillStateFor({ comments: [{ body: "Decision: also cover the PR surface.", createdAt: BEFORE }, resultsComment(GRILL_AT)] });
  assert.equal(out.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(out.reason, "provenance_recorded");
});

test("AC1: only the latest results comment counts as the grill time", () => {
  const comments = [resultsComment(BEFORE), { body: "new note", createdAt: GRILL_AT }, resultsComment(AFTER)];
  assert.equal(detectSpecChangedSinceGrill({ comments }), false);
});

test("a counted comment and lastEditedAt equal to the results comment createdAt do not trigger the reason", () => {
  const comments = [resultsComment(GRILL_AT), { body: "note", createdAt: GRILL_AT }];
  assert.equal(detectSpecChangedSinceGrill({ comments, bodyLastEditedAt: GRILL_AT }), false);
});

test("AC2: a body lastEditedAt after the latest results comment triggers the reason; null or earlier does not", () => {
  const comments = [resultsComment(GRILL_AT)];
  assert.equal(grillStateFor({ comments, bodyLastEditedAt: AFTER }).reason, SPEC_CHANGED_SINCE_GRILL_REASON);
  assert.equal(grillStateFor({ comments, bodyLastEditedAt: null }).state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(grillStateFor({ comments, bodyLastEditedAt: BEFORE }).state, GRILL_STATE.GRILL_CLEAN);
});

test("AC3: the pr surface applies the same check", () => {
  const out = grillStateFor({ surface: "pr", comments: [resultsComment(GRILL_AT), { body: "please also handle X", createdAt: AFTER }] });
  assert.equal(out.state, GRILL_STATE.DETECT_GAPS);
  assert.equal(out.reason, SPEC_CHANGED_SINCE_GRILL_REASON);
});

for (const [kind, body] of [
  ["a <!-- dev-loops: marker comment", "<!-- dev-loops:gate-verdict head=abc -->\nverdict: clean"],
  ["a merge record", "merge-pr record: merged head `abc` (squash merge); approvalVia `comment`; approver `op`."],
  ["an operator marker line", "approve merge"],
  ["an operator marker line (approve release)", "approve release v1.3"],
  ["a results comment", `## ${RESULTS_TITLE}\n\nsecond pass`],
]) {
  test(`AC4: ${kind} after the latest results comment does not trigger the reason`, () => {
    const comments = [resultsComment(GRILL_AT), { body, createdAt: AFTER }];
    assert.equal(detectSpecChangedSinceGrill({ comments }), false);
  });
}

for (const [kind, body] of [
  ["a spec decision mentioning approve release in prose", "Decision: drop AC3. We will not approve release v1.3 without it."],
  ["a spec decision followed by an approve merge line", "Decision: also cover the PR surface.\napprove merge"],
  ["a spec decision ending in approve release prose", "Decision: also cover the PR surface. Once green we can approve release v1.0.14."],
]) {
  test(`AC4: ${kind} still triggers the reason`, () => {
    const out = grillStateFor({ comments: [resultsComment(GRILL_AT), { body, createdAt: AFTER }] });
    assert.equal(out.reason, SPEC_CHANGED_SINCE_GRILL_REASON);
  });
}

test("a milestone-move note counts; a bypass line does not exempt the target", () => {
  const comments = [resultsComment(GRILL_AT, "\nbypass: operator-authorized by op"), { body: "Moved to milestone v1.2.", createdAt: AFTER }];
  const out = grillStateFor({ comments });
  assert.equal(out.reason, SPEC_CHANGED_SINCE_GRILL_REASON);
  assert.equal(out.bypass, false);
});

test("no dated results comment, or undated comments, never trigger the reason", () => {
  assert.equal(detectSpecChangedSinceGrill({ comments: [{ body: "note", createdAt: AFTER }], bodyLastEditedAt: AFTER }), false);
  assert.equal(detectSpecChangedSinceGrill({ comments: [{ body: "note" }, "note"] }), false);
});

test("a results comment with no parseable createdAt fails closed", () => {
  const heading = `## ${RESULTS_TITLE}\n\nNo gaps.`;
  const counted = { body: "Decision: drop AC3", createdAt: AFTER };
  for (const undated of [heading, { body: heading }, { body: heading, createdAt: "not-a-date" }]) {
    assert.equal(detectSpecChangedSinceGrill({ comments: [undated, counted] }), true);
    assert.equal(grillStateFor({ comments: [undated, counted] }).reason, "spec_changed_since_grill");
  }
  assert.equal(detectSpecChangedSinceGrill({ comments: [{ body: heading, createdAt: GRILL_AT }, counted] }), true);
  assert.equal(detectSpecChangedSinceGrill({ comments: [{ body: heading, createdAt: GRILL_AT }] }), false);
});

test("normalizeGrillSnapshot keeps specChangedSinceGrill without provenance (a truncated window)", () => {
  assert.equal(normalizeGrillSnapshot({ specChangedSinceGrill: true }).specChangedSinceGrill, true);
});

test("a truncated comment window with no results comment fails closed; an untruncated one does not", () => {
  const comments = [{ body: "note", createdAt: AFTER }];
  assert.equal(detectSpecChangedSinceGrill({ comments, commentsTruncated: true }), true);
  assert.equal(detectSpecChangedSinceGrill({ comments, commentsTruncated: false }), false);
  assert.equal(detectSpecChangedSinceGrill({ comments: [resultsComment(GRILL_AT)], commentsTruncated: true }), false);
});

test("parseSpecChangeFacts reads the GraphQL node and tolerates a body-only payload", () => {
  assert.deepEqual(
    parseSpecChangeFacts({ body: "b", lastEditedAt: AFTER, comments: { nodes: [{ body: "c", createdAt: GRILL_AT }] } }),
    { body: "b", lastEditedAt: AFTER, commentsTruncated: false, comments: [{ body: "c", createdAt: GRILL_AT }] },
  );
  assert.deepEqual(parseSpecChangeFacts({ body: "b" }), { body: "b", lastEditedAt: null, commentsTruncated: false, comments: [] });
  assert.equal(parseSpecChangeFacts({ comments: { pageInfo: { hasPreviousPage: true }, nodes: [] } }).commentsTruncated, true);
  assert.throws(() => parseSpecChangeFacts({ body: "b", comments: [] }), /comments must be/);
  assert.ok(buildSpecChangeFactsGhArgs({ repo: "o/r", number: 7 }).includes("number=7"));
  assert.ok(buildSpecChangeFactsGhArgs({ repo: "mfittko/dev-loops", number: 7 }).includes("name=dev-loops"));
  for (const repo of ["foo", "a/b/c", "mfittko/dev-loops/extra"]) {
    assert.throws(() => buildSpecChangeFactsGhArgs({ repo, number: 7 }), /repo must match <owner\/name>/);
  }
});

// DESIGN-SIMPLEST-FIRST (issue 3462): grill_clean needs a `## Simplest design` section and a latest-comment review line.
const REVIEW_LINE = "simplicity-review: 2 findings, 2 corrected, 0 rejected";
const grilled = (extra = "", createdAt = GRILL_AT) => ({ body: `## ${RESULTS_TITLE}\n\nVerdict: grill-clean.\n\n${extra}`, createdAt });
const stateOf = (input) => interpretRefinementGrillState(buildGrillFactsSnapshot(input));

test("3462: a clean issue has provenance, a Simplest design section and a review line", () => {
  const out = stateOf({ body: REFINED, comments: [grilled(REVIEW_LINE)] });
  assert.equal(out.state, GRILL_STATE.GRILL_CLEAN);
});

test("3462: each missing fact blocks the zero-iteration exit with its recovery text, and the repaired issue reaches grill_clean", () => {
  const never = stateOf({ body: REFINED, comments: [] });
  assert.deepEqual([never.state, never.reason], [GRILL_STATE.DETECT_GAPS, "provenance_missing"]);
  const noSection = stateOf({ body: MATRIX, comments: [grilled(REVIEW_LINE)] });
  assert.deepEqual([noSection.state, noSection.reason], [GRILL_STATE.DETECT_GAPS, "simplest_design_missing"]);
  const noLine = stateOf({ body: REFINED, comments: [grilled()] });
  assert.deepEqual([noLine.state, noLine.reason], [GRILL_STATE.DETECT_GAPS, "simplicity_review_missing"]);
  for (const out of [noSection, noLine]) assert.match(out.nextAction, /^Re-grill: add the "## Simplest design" section .* "simplicity-review: <n> findings, <n> corrected, <n> rejected" line$/);
  assert.match(never.nextAction, /^Run the semantic gap pass/);
  assert.equal(stateOf({ body: REFINED, comments: [grilled(REVIEW_LINE)] }).state, GRILL_STATE.GRILL_CLEAN);
});

test("3462: the review line is read from the latest results comment by createdAt, not by array position", () => {
  const older = grilled(REVIEW_LINE, BEFORE);
  const newer = grilled("", AFTER);
  assert.equal(detectSimplicityReview([older, newer]), false);
  assert.equal(detectSimplicityReview([newer, older]), false);
  assert.equal(detectSimplicityReview([grilled("", BEFORE), grilled(REVIEW_LINE, AFTER)]), true);
  assert.equal(detectSimplicityReview([grilled(REVIEW_LINE, AFTER), grilled("", BEFORE)]), true);
  assert.equal(detectSimplicityReview([{ body: REVIEW_LINE }]), false);
  assert.equal(detectSimplicityReview([{ body: grilled(REVIEW_LINE).body }]), false);
  const bypass = stateOf({ body: MATRIX, comments: [grilled("bypass: operator-authorized by mfittko")] });
  assert.equal(bypass.state, GRILL_STATE.DETECT_GAPS);
});

test("3462: the review line is accepted only when findings equal corrected plus rejected", () => {
  const lineOf = (f, c, r) => [grilled(`simplicity-review: ${f} findings, ${c} corrected, ${r} rejected`)];
  assert.equal(detectSimplicityReview(lineOf(3, 2, 1)), true);
  assert.equal(detectSimplicityReview(lineOf(0, 0, 0)), true);
  assert.equal(detectSimplicityReview(lineOf(3, 0, 0)), false);
  assert.equal(detectSimplicityReview(lineOf(1, 1, 1)), false);
});

test("3462: a fenced Simplest design heading and a matrix-less body do not reach grill_clean", () => {
  const fenced = stateOf({ body: `${MATRIX}\n\`\`\`md\n## Simplest design\n\nQuoted template.\n\`\`\`\n`, comments: [grilled(REVIEW_LINE)] });
  assert.deepEqual([fenced.state, fenced.reason], [GRILL_STATE.DETECT_GAPS, "simplest_design_missing"]);
  const noMatrix = stateOf({ body: "## Simplest design\n\nOne predicate.\n", comments: [grilled(REVIEW_LINE)] });
  assert.equal(noMatrix.state, GRILL_STATE.AWAIT_ANSWERS);
});

test("3462: the pr surface keeps its zero-iteration exit without the two simplicity facts", () => {
  const out = stateOf({ body: MATRIX, comments: [grilled()], surface: "pr" });
  assert.equal(out.state, GRILL_STATE.GRILL_CLEAN);
});
