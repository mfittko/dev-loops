import assert from "node:assert/strict";
import test from "node:test";
import {
  GRILL_STATE,
  GRILL_TRANSITIONS,
  interpretRefinementGrillState,
  normalizeGrillSnapshot,
} from "@dev-loops/core/loop/refinement-grill-state";

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
    [{ loaded: true, detectRan: true, openGapCount: 0 }, GRILL_STATE.GRILL_CLEAN],
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

test("already-refined body reaches grill_clean in zero iterations", () => {
  assert.equal(
    interpretRefinementGrillState({ loaded: true, detectRan: true, openGapCount: 0 }).state,
    GRILL_STATE.GRILL_CLEAN,
  );
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
  const clean = interpretRefinementGrillState({ loaded: true, detectRan: true, openGapCount: 0 });
  assert.deepEqual(clean.allowedTransitions, GRILL_TRANSITIONS[GRILL_STATE.GRILL_CLEAN]);
  const detect = interpretRefinementGrillState({ loaded: true, detectRan: false });
  assert.deepEqual(detect.allowedTransitions, GRILL_TRANSITIONS[GRILL_STATE.DETECT_GAPS]);
});
