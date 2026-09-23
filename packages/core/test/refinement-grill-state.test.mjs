import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  detectGrillProvenance,
  GRILL_STATE,
  GRILL_TRANSITIONS,
  interpretRefinementGrillState,
  normalizeGrillSnapshot,
} from "@dev-loops/core/loop/refinement-grill-state";

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
    [{ loaded: true, detectRan: true, openGapCount: 0, provenanceRecorded: true }, GRILL_STATE.GRILL_CLEAN],
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
    provenanceRecorded: true,
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
    provenanceRecorded: true,
    provenanceBypass: true,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "provenance_bypass_recorded");
  assert.equal(result.bypass, true);
});

test("a normal recorded comment (no bypass line) reaches grill_clean with bypass false", () => {
  const result = interpretRefinementGrillState({
    loaded: true,
    detectRan: true,
    openGapCount: 0,
    provenanceRecorded: true,
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
    provenanceRecorded: provenance.provenanceRecorded,
    provenanceBypass: provenance.bypass,
  });
  assert.equal(result.state, GRILL_STATE.GRILL_CLEAN);
  assert.equal(result.reason, "provenance_recorded");
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
  const bare = `${RESULTS_TITLE}`;
  assert.deepEqual(detectGrillProvenance([bare]), { provenanceRecorded: true, bypass: false, bypassBy: null });
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
    provenanceRecorded: true,
  });
  assert.deepEqual(clean.allowedTransitions, GRILL_TRANSITIONS[GRILL_STATE.GRILL_CLEAN]);
  const detect = interpretRefinementGrillState({ loaded: true, detectRan: false });
  assert.deepEqual(detect.allowedTransitions, GRILL_TRANSITIONS[GRILL_STATE.DETECT_GAPS]);
});
