import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  interpretTrackerLoopState,
  TRACKER_STATES,
  TRACKER_TRANSITIONS,
} from "../src/loop/tracker-first-loop-state.mjs";

// ── State vocabulary ─────────────────────────────────────────────────────

test("TRACKER_STATES contains all 8 required states", () => {
  const required = ["drafting", "needs_triage", "in_progress", "in_review",
    "merge_ready", "blocked", "completed", "unknown"];
  for (const state of required) {
    assert.ok(TRACKER_STATES.includes(state), `missing state: ${state}`);
  }
  assert.equal(TRACKER_STATES.length, 8);
});

// ── Transition table ─────────────────────────────────────────────────────

test("all states have defined transitions", () => {
  for (const state of TRACKER_STATES) {
    assert.ok(Array.isArray(TRACKER_TRANSITIONS[state]),
      `no transitions defined for ${state}`);
    assert.ok(TRACKER_TRANSITIONS[state].length > 0,
      `empty transitions for ${state}`);
  }
});

test("completed only transitions to unknown", () => {
  assert.deepStrictEqual(TRACKER_TRANSITIONS.completed, ["unknown"]);
});

test("merge_ready cannot transition to drafting or needs_triage (forward-only)", () => {
  assert.ok(!TRACKER_TRANSITIONS.merge_ready.includes("drafting"));
  assert.ok(!TRACKER_TRANSITIONS.merge_ready.includes("needs_triage"));
});

test("unknown can transition to any state", () => {
  for (const state of TRACKER_STATES) {
    assert.ok(TRACKER_TRANSITIONS.unknown.includes(state),
      `unknown should allow transition to ${state}`);
  }
});

// ── State interpretation ─────────────────────────────────────────────────

test("interpretTrackerLoopState: drafting", () => {
  const r = interpretTrackerLoopState({ trackerState: "drafting" });
  assert.equal(r.state, "drafting");
  assert.equal(r.nextAction, "triage_or_block");
  assert.equal(r.ok, true);
});

test("interpretTrackerLoopState: needs_triage (open)", () => {
  const r = interpretTrackerLoopState({ trackerState: "open" });
  assert.equal(r.state, "needs_triage");
  assert.equal(r.nextAction, "start_work");
});

test("interpretTrackerLoopState: in_progress", () => {
  const r = interpretTrackerLoopState({ trackerState: "in_progress" });
  assert.equal(r.state, "in_progress");
  assert.equal(r.nextAction, "review");
});

test("interpretTrackerLoopState: in_review", () => {
  const r = interpretTrackerLoopState({ trackerState: "review" });
  assert.equal(r.state, "in_review");
  assert.equal(r.nextAction, "merge_or_fix");
});

test("interpretTrackerLoopState: merge_ready", () => {
  const r = interpretTrackerLoopState({ trackerState: "ready" });
  assert.equal(r.state, "merge_ready");
  assert.equal(r.nextAction, "merge");
});

test("interpretTrackerLoopState: blocked", () => {
  const r = interpretTrackerLoopState({ trackerState: "blocked" });
  assert.equal(r.state, "blocked");
  assert.equal(r.nextAction, "resolve_blocker");
});

test("interpretTrackerLoopState: completed (closed)", () => {
  const r = interpretTrackerLoopState({ trackerState: "closed" });
  assert.equal(r.state, "completed");
  assert.equal(r.nextAction, "done");
});

test("interpretTrackerLoopState: empty input fails closed to needs_triage", () => {
  const r = interpretTrackerLoopState({ trackerState: "" });
  assert.equal(r.state, "needs_triage");
  assert.equal(r.nextAction, "start_work");
});

test("interpretTrackerLoopState: fail-closed — garbage input → needs_triage", () => {
  const r = interpretTrackerLoopState({ trackerState: "garbage_input_xyz" });
  assert.equal(r.state, "needs_triage");
  assert.equal(r.snapshot.rawTrackerState, "garbage_input_xyz");
});

test("interpretTrackerLoopState: explicit 'unknown' → canonical unknown", () => {
  const r = interpretTrackerLoopState({ trackerState: "unknown" });
  assert.equal(r.state, "unknown");
  assert.equal(r.nextAction, "reconcile");
});

test("interpretTrackerLoopState: undefined input fails closed to needs_triage", () => {
  const r = interpretTrackerLoopState({ trackerState: undefined });
  assert.equal(r.state, "needs_triage");
  assert.equal(r.nextAction, "start_work");
});

// ── Snapshot contract ────────────────────────────────────────────────────

test("interpretTrackerLoopState includes snapshot with required fields", () => {
  const r = interpretTrackerLoopState({
    trackerState: "in_progress",
    prContext: { number: 42, state: "open" },
  });
  assert.equal(r.snapshot.trackerState, "in_progress");
  assert.equal(r.snapshot.prLinked, true);
  assert.deepStrictEqual(r.snapshot.prContext, { number: 42, state: "open" });
});

test("interpretTrackerLoopState snapshot.prLinked false without PR context", () => {
  const r = interpretTrackerLoopState({ trackerState: "drafting" });
  assert.equal(r.snapshot.prLinked, false);
  assert.equal(r.snapshot.prContext, null);
});

// ── Allowed transitions ──────────────────────────────────────────────────

test("interpretTrackerLoopState returns allowed transitions for each state", () => {
  for (const state of TRACKER_STATES) {
    const r = interpretTrackerLoopState({ trackerState: state });
    assert.ok(Array.isArray(r.allowedTransitions));
    assert.deepStrictEqual(r.allowedTransitions, TRACKER_TRANSITIONS[state]);
  }
});
