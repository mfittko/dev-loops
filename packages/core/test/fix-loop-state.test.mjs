import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  FIX_LOOP_STATE as S,
  FIX_LOOP_TRANSITIONS,
  interpretFixLoopState,
  normalizeFixLoopSnapshot,
} from "@dev-loops/core/loop/fix-loop-state";

const CASES = [
  [S.ACT_PENDING, { actPending: true }],
  [S.COMMIT_ONLY_EMITTED, { markerWritten: true }],
  [S.NO_COMMIT, { markerWritten: true, noCommit: true }],
  [S.CANDIDATE_COMMITTED, { candidateCommitted: true }],
  [S.DELTA_REVIEW, { candidateCommitted: true, deltaReviewStarted: true, deltaVerdict: "bounded_out" }],
  [S.FULL_EMITTED, { candidateCommitted: true, deltaVerdict: "clear", pushGranted: true }],
  [S.PUSHED, { pushed: true }],
  [S.CI_RED, { pushed: true, ciStatus: "red" }],
  [S.CI_GREEN, { pushed: true, ciStatus: "green" }],
  [S.DELIVERY_INCOMPLETE, { pushed: true, ciStatus: "green", reportStatus: "superseded" }],
  [S.DISPOSITION_COMPLETE, { pushed: true, ciStatus: "green", reportStatus: "complete" }],
  [S.HEAD_MOVED, { markerWritten: true, headMoved: true }],
  [S.FULL_GATE_ROUND, { fullGateStarted: true }],
  [S.STOPPED, { stopped: true, headMoved: true }],
];

for (const [state, snapshot] of CASES) {
  test(`interprets ${state}`, () => {
    const out = interpretFixLoopState(snapshot);
    assert.equal(out.state, state);
    assert.deepEqual(out.allowedTransitions, FIX_LOOP_TRANSITIONS[state]);
    assert.ok(out.nextAction.length > 0);
  });
}

test("a closed sequence resolves head_moved and no_commit to full_gate_round", () => {
  assert.equal(interpretFixLoopState({ headMoved: true, sequenceClosed: true }).state, S.FULL_GATE_ROUND);
  assert.equal(interpretFixLoopState({ noCommit: true, sequenceClosed: true }).state, S.FULL_GATE_ROUND);
});

test("a descendant carry after head_moved is disposition_complete", () => {
  const out = interpretFixLoopState({ headMoved: true, dispositionCarried: true });
  assert.equal(out.state, S.DISPOSITION_COMPLETE);
  assert.equal(out.reason, "descendant_carry");
});

test("delta residue re-enters commit_only", () => {
  const out = interpretFixLoopState({ candidateCommitted: true, deltaReviewStarted: true, deltaVerdict: "residue" });
  assert.equal(out.state, S.COMMIT_ONLY_EMITTED);
  assert.equal(out.reason, "delta_residue");
});

test("no open sequence and no act items falls back to full_gate_round", () => {
  assert.equal(interpretFixLoopState({}).state, S.FULL_GATE_ROUND);
});

test("normalizer rejects non-objects and canonicalizes enums", () => {
  assert.throws(() => normalizeFixLoopSnapshot(null));
  const n = normalizeFixLoopSnapshot({ ciStatus: "bogus", deltaVerdict: "x", reportStatus: "y" });
  assert.deepEqual([n.ciStatus, n.deltaVerdict, n.reportStatus], ["pending", null, "none"]);
});

test("contradictory snapshots resolve by the documented precedence", () => {
  const state = (snapshot) => interpretFixLoopState(snapshot).state;
  assert.equal(state({ fullGateStarted: true, headMoved: true }), S.FULL_GATE_ROUND);
  assert.equal(state({ headMoved: true, dispositionCarried: true }), S.DISPOSITION_COMPLETE);
  assert.equal(state({ noCommit: true, pushed: true, ciStatus: "green", reportStatus: "complete" }), S.NO_COMMIT);
  assert.equal(state({ pushGranted: true, candidateCommitted: true, deltaVerdict: "residue" }), S.FULL_EMITTED);
  assert.equal(state({ headMoved: true, pushed: true, ciStatus: "green", reportStatus: "complete" }), S.HEAD_MOVED);
  assert.equal(state({ headMoved: true, pushGranted: true, candidateCommitted: true }), S.HEAD_MOVED);
  assert.equal(state({ dispositionCarried: true, pushed: true }), S.PUSHED);
  assert.equal(state({ dispositionCarried: true }), S.FULL_GATE_ROUND);
});
