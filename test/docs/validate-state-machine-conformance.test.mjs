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
// changes: runMachineConformance() takes a machine object directly, so a demo
// machine can be checked without registering it into the shared module-level
// registry (registerMachine() has no unregister; leaking a demo entry there
// would make this test's outcome depend on run order relative to any other
// test importing this module in the same process).
// ---------------------------------------------------------------------------

test("runMachineConformance supports a second machine with no engine changes and no registration", () => {
  const before = getRegisteredMachines().length;
  const demoChecks = new Map([
    ["start->end", { status: "verified", verify: () => ({ ok: true, detail: "demo", result: { demo: true } }) }],
  ]);
  const demoMachine = {
    name: "demo-extensibility-machine",
    states: ["start", "end"],
    terminalStates: ["end"],
    transitions: [["start", "end"]],
    docTransitions: [["start", "end"]],
    transitionChecks: demoChecks,
  };

  const report = runMachineConformance(demoMachine);
  assert.equal(report.ok, true);
  assert.equal(report.completeness.ok, true);
  assert.equal(report.liveness.ok, true);
  assert.equal(report.conformance.ok, true);
  assert.equal(getRegisteredMachines().length, before, "the demo machine must not leak into the shared registry");
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

test("compareDocCodeTransitions fails closed (not throws) when a check's verify() throws, and still checks the rest", () => {
  const checks = new Map([
    ["a->b", { status: "verified", verify: () => { throw new Error("boom"); } }],
    ["b->c", { status: "verified", verify: () => ({ ok: true, result: {} }) }],
  ]);
  const report = compareDocCodeTransitions([["a", "b"], ["b", "c"]], checks);
  assert.equal(report.ok, false);
  const thrown = report.results.find((r) => r.from === "a" && r.to === "b");
  assert.equal(thrown.status, "divergent");
  assert.match(thrown.detail, /boom/);
  // The throwing check must not abort the run: the other transition still resolves.
  const other = report.results.find((r) => r.from === "b" && r.to === "c");
  assert.equal(other.status, "verified");
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
// skills/docs/pr-lifecycle-contract.md-derived table (imported from
// @dev-loops/core/loop/pr-lifecycle, the exported module also used by
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

// Every registered machine's full L2/L3 report must pass in CI — not just the
// reference machine. Without this, a second machine's compareDocCodeTransitions
// and safety rules only ever run via the CLI, which no npm script executes.
test("every registered machine passes its full conformance report", () => {
  const machines = getRegisteredMachines();
  const names = machines.map((m) => m.name);
  for (const required of ["pr-gate-coordination", "conductor-routing", "copilot-loop-state", "reviewer-loop-state"]) {
    assert.ok(names.includes(required), `machine "${required}" must be registered (got: ${names.join(", ")})`);
  }
  for (const machine of machines) {
    const report = runMachineConformance(machine);
    assert.equal(report.ok, true, `${machine.name}: ${JSON.stringify({
      deadEnds: report.completeness.deadEnds,
      stuck: report.liveness.stuck,
      unresolved: report.conformance.results.filter((r) => r.status === "missing" || r.status === "divergent" || r.status === "unreferenced").map((r) => `${r.from}->${r.to}`),
      safety: report.safety.violations.map((v) => v.rule),
    })}`);
  }
});

// Issue #1190: the pre_approval_gate entry-ordering transition is now a verified (conforming)
// transition, not a tracked known-gap.
test("pr-gate-coordination #1190: pre_approval_gate entry ordering is a verified conforming transition", () => {
  const machine = getRegisteredMachines().find((m) => m.name === "pr-gate-coordination");
  const report = runMachineConformance(machine);
  const transition = report.conformance.results.find(
    (r) => r.from === "waiting_for_copilot_review" && r.to === "final_local_preapproval_gate",
  );
  assert.ok(transition, "the pre_approval_gate entry-ordering transition must be present in the report");
  assert.equal(transition.status, "verified");
});

test("pr-gate-coordination #1190 fix: gate entry is refused when a Copilot review request is "
  + "outstanding on the current head, even though the caller reports sameHeadCleanConverged", async () => {
  const { evaluatePrGateCoordination, PR_CHECKPOINT, PR_CHECKPOINT_ACTION } = await import("@dev-loops/core/loop/pr-gate-coordination");
  const { STATE } = await import("@dev-loops/core/loop/copilot-loop-state");

  const result = evaluatePrGateCoordination({
    currentHeadSha: "deadbeef0000",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    // The caller claims the current head converged cleanly, but an independent signal — an
    // outstanding Copilot review request on the current head — says otherwise. #1190 added this
    // independent cross-check so the caller-supplied flag alone can no longer open the gate.
    sameHeadCleanConverged: true,
    copilotReviewRequestStatus: "requested",
    preApprovalGate: { visible: false, headSha: null, verdict: null, contractComplete: false },
  });

  // Gate entry is refused: the fix closes the gap the flag alone could not catch.
  assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW);
  assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

// ---------------------------------------------------------------------------
// Doc-side parser: the L2 doc table is parsed from the owner doc's own
// "## Required transitions" bullets, so editing the doc is visible.
// ---------------------------------------------------------------------------

const FIXTURE_DOC = `# Fixture

## Required transitions

At minimum:

- \`a\` -> \`b\`
  - some guard
- any open slice -> \`c\`

### Required negative boundaries

- \`x\` -> \`y\` (must not count: different section)
`;

test("parseRequiredTransitions reads top-level bullets and applies abstract-row mappings", async () => {
  const { parseRequiredTransitions } = await import("../../scripts/docs/validate-state-machine-conformance.mjs");
  const parsed = parseRequiredTransitions(FIXTURE_DOC, {
    abstractRows: new Map([["any open slice->`c`", [["b", "c"]]]]),
  });
  assert.deepEqual(parsed, [["a", "b"], ["b", "c"]]);
});

test("parseRequiredTransitions throws on an unmapped abstract row (loud, never dropped)", async () => {
  const { parseRequiredTransitions } = await import("../../scripts/docs/validate-state-machine-conformance.mjs");
  assert.throws(() => parseRequiredTransitions(FIXTURE_DOC), /unmapped abstract transition row/);
});

test("doc-content mutation test: perturbing the doc's transition bullets is caught end to end", async () => {
  const { parseRequiredTransitions } = await import("../../scripts/docs/validate-state-machine-conformance.mjs");
  const checks = new Map([
    ["a->b", { status: "verified", verify: () => ({ ok: true, result: {} }) }],
    ["b->c", { status: "verified", verify: () => ({ ok: true, result: {} }) }],
  ]);
  const abstractRows = new Map([["any open slice->`c`", [["b", "c"]]]]);

  // Unmutated doc: everything binds.
  const clean = compareDocCodeTransitions(parseRequiredTransitions(FIXTURE_DOC, { abstractRows }), checks);
  assert.equal(clean.ok, true);

  // Mutate the DOC CONTENT (rename a bullet's target state): the parsed table
  // no longer matches any registered check AND the old check goes unreferenced.
  const doctoredDoc = FIXTURE_DOC.replace("- `a` -> `b`", "- `a` -> `doctored`");
  const report = compareDocCodeTransitions(parseRequiredTransitions(doctoredDoc, { abstractRows }), checks);
  assert.equal(report.ok, false);
  assert.ok(report.results.some((r) => r.status === "missing" && r.to === "doctored"));
  assert.ok(report.results.some((r) => r.status === "unreferenced" && r.from === "a" && r.to === "b"));
});

test("compareDocCodeTransitions fails on a check key no doc transition references (stale check)", () => {
  const checks = new Map([
    ["a->b", { status: "verified", verify: () => ({ ok: true, result: {} }) }],
    ["stale->edge", { status: "verified", verify: () => ({ ok: true, result: {} }) }],
  ]);
  const report = compareDocCodeTransitions([["a", "b"]], checks);
  assert.equal(report.ok, false);
  assert.ok(report.results.some((r) => r.status === "unreferenced" && r.from === "stale" && r.to === "edge"));
});

test("registerMachine throws when exactly one of docTransitions/transitionChecks is provided", () => {
  assert.throws(() => registerMachine({
    name: "half-registered-machine",
    states: ["a"],
    terminalStates: ["a"],
    transitions: [],
    docTransitions: [["a", "a"]],
    // transitionChecks missing -> would silently skip L2 as ok:true
  }), /docTransitions and transitionChecks together/);
});

// ---------------------------------------------------------------------------
// Safety-rule hardening: the merge-analog assertions the machine's safetyRules
// comment refers to.
// ---------------------------------------------------------------------------

test("pr-gate-coordination: DECLARE_MERGE_READY is never an allowed action in any gathered observation", async () => {
  const { PR_CHECKPOINT_ACTION } = await import("@dev-loops/core/loop/pr-gate-coordination");
  const machine = getRegisteredMachines().find((m) => m.name === "pr-gate-coordination");
  const report = runMachineConformance(machine);
  assert.ok(report.conformance.observations.length > 0, "expected gathered observations");
  for (const observation of report.conformance.observations) {
    assert.ok(
      !observation.allowedNextActions.includes(PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY),
      `DECLARE_MERGE_READY allowed at ${observation.gateBoundary}`,
    );
  }
});

test("pr-gate-coordination adversarial probe: clean pre_approval_gate WITHOUT draft_gate evidence is not final-approval ready", async () => {
  const { evaluatePrGateCoordination, PR_CHECKPOINT, PR_CHECKPOINT_ACTION } = await import("@dev-loops/core/loop/pr-gate-coordination");
  const { STATE } = await import("@dev-loops/core/loop/copilot-loop-state");

  const result = evaluatePrGateCoordination({
    currentHeadSha: "abc1234567890",
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    sameHeadCleanConverged: true,
    // pre_approval_gate is clean at head, but NO draft_gate evidence exists.
    draftGate: { visible: false, headSha: null, verdict: null, contractComplete: false },
    preApprovalGate: { visible: true, headSha: "abc1234", verdict: "clean", contractComplete: false },
    preApprovalGateMarker: { visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true },
  });

  assert.notEqual(result.gateBoundary, PR_CHECKPOINT.FINAL_APPROVAL_READY);
  assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_GATE_NEEDED);
  assert.ok(!result.allowedNextActions.includes(PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL));

  // Feed the probe through the machine's own safety rules: the
  // no-final-approval-without-both-gates-clean rule must hold on it too.
  const machine = getRegisteredMachines().find((m) => m.name === "pr-gate-coordination");
  const safety = checkSafetyRules([result], machine.safetyRules);
  assert.equal(safety.ok, true);
});

// ---------------------------------------------------------------------------
// copilot-loop-state and reviewer-loop-state (issue #1157): registered machines,
// with one adversarial probe each per COPILOT-STATE-UNRESOLVED-PRIORITY /
// the reviewer-loop fail-closed guarantee — a real code call, not a fixture
// constructed to already satisfy the rule.
// ---------------------------------------------------------------------------

test("copilot-loop-state reference machine: completeness, liveness, conformance, and safety all pass", () => {
  const machine = getRegisteredMachines().find((m) => m.name === "copilot-loop-state");
  assert.ok(machine, "copilot-loop-state machine must be registered");
  const report = runMachineConformance(machine);
  assert.equal(report.ok, true, JSON.stringify({
    deadEnds: report.completeness.deadEnds,
    stuck: report.liveness.stuck,
    unresolved: report.conformance.results.filter((r) => r.status === "missing" || r.status === "divergent" || r.status === "unreferenced"),
    safety: report.safety.violations,
  }));
});

test("copilot-loop-state adversarial probe: unresolved feedback outranks an active review request wait (COPILOT-STATE-UNRESOLVED-PRIORITY)", async () => {
  const { interpretLoopState, STATE } = await import("@dev-loops/core/loop/copilot-loop-state");

  // Copilot is still actively requested/in-progress AND unresolved threads already exist —
  // per the doc rule, unresolved feedback must still win and route to fix/reply-resolve,
  // never to the wait state.
  const interpretation = interpretLoopState({
    prExists: true,
    prDraft: false,
    copilotReviewRequestStatus: "requested",
    unresolvedThreadCount: 3,
  });

  assert.equal(interpretation.state, STATE.UNRESOLVED_FEEDBACK_PRESENT);
  assert.notEqual(interpretation.state, STATE.WAITING_FOR_COPILOT_REVIEW);

  const machine = getRegisteredMachines().find((m) => m.name === "copilot-loop-state");
  const safety = checkSafetyRules(
    [{ state: interpretation.state, unresolvedThreadCount: 3, copilotReviewRequestStatus: "requested" }],
    machine.safetyRules,
  );
  assert.equal(safety.ok, true);
});

test("reviewer-loop-state reference machine: completeness, liveness, conformance, and safety all pass", () => {
  const machine = getRegisteredMachines().find((m) => m.name === "reviewer-loop-state");
  assert.ok(machine, "reviewer-loop-state machine must be registered");
  const report = runMachineConformance(machine);
  assert.equal(report.ok, true, JSON.stringify({
    deadEnds: report.completeness.deadEnds,
    stuck: report.liveness.stuck,
    unresolved: report.conformance.results.filter((r) => r.status === "missing" || r.status === "divergent" || r.status === "unreferenced"),
    safety: report.safety.violations,
  }));
});

test("reviewer-loop-state adversarial probe: a local failure fails closed even alongside a draft-posted signal", async () => {
  const { interpretReviewerLoopState, REVIEWER_STATE } = await import("@dev-loops/core/loop/reviewer-loop-state");

  // localMergeStatus "failed" alongside a draftReviewPosted signal that would otherwise tempt
  // a DRAFT_REVIEW_POSTED / WAITING_FOR_USER_SUBMIT branch — the failure check must still win.
  const interpretation = interpretReviewerLoopState({
    prExists: true,
    prDraft: false,
    draftReviewPosted: true,
    draftReviewNotificationStatus: "notified",
    prHeadSha: "abc1234",
    draftReviewCommitSha: "abc1234",
    localMergeStatus: "failed",
  });

  assert.equal(interpretation.state, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION);

  const machine = getRegisteredMachines().find((m) => m.name === "reviewer-loop-state");
  const safety = checkSafetyRules([{ state: interpretation.state, failed: true }], machine.safetyRules);
  assert.equal(safety.ok, true);
});
