import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCompleteness,
  checkLiveness,
  checkSafetyRules,
  compareDocCodeTransitions,
  getRegisteredMachines,
  registerMachine,
  runMachineConformance,
} from "../../scripts/docs/validate-state-machine-conformance.mjs";

// ---------------------------------------------------------------------------
// L3 invariants: generic engine unit tests (positive via the real reference
// machine below + a dedicated negative case per invariant, per AC2).
// ---------------------------------------------------------------------------

test("checkCompleteness passes when every non-terminal state has an outgoing transition", () => {
  const report = checkCompleteness({
    states: ["a", "b", "term"],
    terminalStates: ["term"],
    transitions: [["a", "b"], ["b", "term"]],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.deadEnds, []);
});

test("checkCompleteness fails (negative case) on a non-terminal dead-end state", () => {
  const report = checkCompleteness({
    states: ["a", "b", "term"],
    terminalStates: ["term"],
    // "b" has no outgoing transition and is not terminal.
    transitions: [["a", "b"]],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.deadEnds, ["b"]);
});

test("checkLiveness passes when every state can reach a terminal state", () => {
  const report = checkLiveness({
    states: ["a", "b", "term"],
    terminalStates: ["term"],
    transitions: [["a", "b"], ["b", "term"]],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.stuck, []);
});

test("checkLiveness fails (negative case) on a cycle that never reaches a terminal state", () => {
  const report = checkLiveness({
    states: ["a", "b", "term"],
    terminalStates: ["term"],
    // a -> b -> a is a cycle with no path to "term".
    transitions: [["a", "b"], ["b", "a"]],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.stuck.sort(), ["a", "b"]);
});

test("checkSafetyRules passes when every observation satisfies every rule", () => {
  const report = checkSafetyRules(
    [{ blocked: false, action: "run" }],
    [{ name: "never-run-while-blocked", check: (o) => !o.blocked || o.action !== "run" }],
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("checkSafetyRules fails (negative case) on a rule-violating observation", () => {
  const report = checkSafetyRules(
    [{ blocked: true, action: "run" }],
    [{ name: "never-run-while-blocked", check: (o) => !o.blocked || o.action !== "run" }],
  );
  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].rule, "never-run-while-blocked");
});

// ---------------------------------------------------------------------------
// AC4: registration-only extensibility — a second machine needs zero engine
// changes, only a `registerMachine()` call with its own doc/code tables.
// ---------------------------------------------------------------------------

test("registerMachine + runMachineConformance supports a second machine with no engine changes", () => {
  const before = getRegisteredMachines().length;
  const demoChecks = new Map([
    ["start->end", { status: "verified", verify: () => ({ ok: true, detail: "demo", result: { demo: true } }) }],
  ]);
  const demoMachine = registerMachine({
    name: "demo-extensibility-machine",
    states: ["start", "end"],
    terminalStates: ["end"],
    transitions: [["start", "end"]],
    docTransitions: [["start", "end"]],
    transitionChecks: demoChecks,
  });

  assert.equal(getRegisteredMachines().length, before + 1);
  const report = runMachineConformance(demoMachine);
  assert.equal(report.ok, true);
  assert.equal(report.completeness.ok, true);
  assert.equal(report.liveness.ok, true);
  assert.equal(report.conformance.ok, true);
});

// ---------------------------------------------------------------------------
// AC1: doc <-> code comparison + mutation test (a doctored doc table is caught).
// ---------------------------------------------------------------------------

test("compareDocCodeTransitions passes when every doc transition has a registered code check", () => {
  const checks = new Map([
    ["a->b", { status: "verified", verify: () => ({ ok: true, result: { ok: true } }) }],
  ]);
  const report = compareDocCodeTransitions([["a", "b"]], checks);
  assert.equal(report.ok, true);
  assert.deepEqual(report.results, [{ from: "a", to: "b", status: "verified", detail: undefined }]);
});

test("compareDocCodeTransitions fails (mutation test) when the doc table is doctored", () => {
  const checks = new Map([
    ["a->b", { status: "verified", verify: () => ({ ok: true, result: { ok: true } }) }],
  ]);
  // Doctor the doc table: rename the declared target so it no longer matches any registered check —
  // this simulates the doc's transition table drifting (edited) without updating the registration.
  const doctoredDocTransitions = [["a", "doctored-target"]];
  const report = compareDocCodeTransitions(doctoredDocTransitions, checks);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "missing");
});

test("compareDocCodeTransitions fails when the code check itself reports divergence", () => {
  const checks = new Map([
    ["a->b", { status: "verified", verify: () => ({ ok: false, detail: "code disagrees", result: { ok: false } }) }],
  ]);
  const report = compareDocCodeTransitions([["a", "b"]], checks);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "divergent");
});

// ---------------------------------------------------------------------------
// Reference machine: pr-gate-coordination, wired against the real
// skills/docs/pr-lifecycle-contract.md-derived table (imported via
// scripts/pages/build-state-atlas.mjs) and the real exported
// evaluatePrGateCoordination function.
// ---------------------------------------------------------------------------

test("pr-gate-coordination reference machine: completeness, liveness, and conformance all pass", () => {
  const machine = getRegisteredMachines().find((m) => m.name === "pr-gate-coordination");
  assert.ok(machine, "pr-gate-coordination machine must be registered");
  const report = runMachineConformance(machine);

  assert.equal(report.completeness.ok, true, `dead ends: ${report.completeness.deadEnds.join(", ")}`);
  assert.equal(report.liveness.ok, true, `stuck: ${report.liveness.stuck.join(", ")}`);
  assert.equal(
    report.conformance.ok,
    true,
    `unresolved: ${report.conformance.results.filter((r) => r.status === "missing" || r.status === "divergent").map((r) => `${r.from}->${r.to}`).join(", ")}`,
  );
  assert.equal(report.safety.ok, true, `safety violations: ${report.safety.violations.map((v) => v.rule).join(", ")}`);
  assert.equal(report.ok, true);
});

// AC3: the pre_approval_gate entry-ordering divergence is a tracked known-gap, not a silent pass.
test("pr-gate-coordination known gap: pre_approval_gate entry ordering is tracked, not silently passed", () => {
  const machine = getRegisteredMachines().find((m) => m.name === "pr-gate-coordination");
  const report = runMachineConformance(machine);
  const knownGap = report.conformance.results.find(
    (r) => r.from === "waiting_for_copilot_review" && r.to === "final_local_preapproval_gate",
  );
  assert.ok(knownGap, "the pre_approval_gate entry-ordering transition must be present in the report");
  assert.equal(knownGap.status, "known_gap");
  assert.match(knownGap.note, /verdict-post/);
});

test("pr-gate-coordination known gap regression: gate entry is permitted from a merely trusted "
  + "sameHeadCleanConverged flag with no independent reviewed-head check (documents today's gap; "
  + "does not fix it)", async () => {
  const { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } = await import("@dev-loops/core/loop/pr-gate-coordination");
  const { STATE } = await import("@dev-loops/core/loop/copilot-loop-state");

  const result = evaluatePrGateCoordination({
    currentHeadSha: "deadbeef0000",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    // The caller claims the current head converged cleanly; evaluatePrGateCoordination has no
    // parameter to independently confirm "deadbeef0000" is the head Copilot actually reviewed.
    sameHeadCleanConverged: true,
    preApprovalGate: { visible: false, headSha: null, verdict: null, contractComplete: false },
  });

  // Gate entry is permitted despite no independent reviewed-head verification (the known gap).
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
});
