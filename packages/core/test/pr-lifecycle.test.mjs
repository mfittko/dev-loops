import assert from "node:assert/strict";
import test from "node:test";

import { PR_LIFECYCLE_STATE, PR_LIFECYCLE_STATES, PR_LIFECYCLE_TERMINAL_STATES, PR_LIFECYCLE_TRANSITIONS } from "../src/loop/pr-lifecycle.mjs";

test("PR_LIFECYCLE_TERMINAL_STATES is derived, not hand-listed: matches states with zero real outgoing edges", () => {
  const realOutgoingFroms = new Set(PR_LIFECYCLE_TRANSITIONS.filter(([, to]) => to !== "[*]").map(([from]) => from));
  const expected = PR_LIFECYCLE_STATES.filter((s) => !realOutgoingFroms.has(s));
  assert.deepEqual([...PR_LIFECYCLE_TERMINAL_STATES].sort(), expected.sort());
  assert.deepEqual([...PR_LIFECYCLE_TERMINAL_STATES].sort(), ["stopped_needs_user_decision", "terminal_slice_complete"]);
});

test("PR_LIFECYCLE_STATE enum has one SCREAMING_SNAKE_CASE key per state, round-tripping to the same value", () => {
  assert.equal(Object.keys(PR_LIFECYCLE_STATE).length, PR_LIFECYCLE_STATES.length);
  for (const state of PR_LIFECYCLE_STATES) {
    assert.equal(PR_LIFECYCLE_STATE[state.toUpperCase()], state);
  }
  assert.equal(PR_LIFECYCLE_STATE.READY_STATE_NEEDS_COPILOT_REQUEST, "ready_state_needs_copilot_request");
});

test("every transition's endpoints are declared states (or the terminal marker)", () => {
  const stateSet = new Set(PR_LIFECYCLE_STATES);
  for (const [from, to] of PR_LIFECYCLE_TRANSITIONS) {
    assert.ok(stateSet.has(from), `unknown from-state: ${from}`);
    assert.ok(to === "[*]" || stateSet.has(to), `unknown to-state: ${to}`);
  }
});
