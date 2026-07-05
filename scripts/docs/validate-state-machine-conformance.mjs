#!/usr/bin/env node
/**
 * validate-state-machine-conformance.mjs — L2/L3 state-machine conformance +
 * invariant harness (issue #1148).
 *
 * L2 (doc <-> code conformance): for a registered machine, every transition the
 * doc's structured transition table declares must have a matching, executable
 * check against the code (`status: "verified"`) or be explicitly accounted for
 * as `"known_gap"` (tracked divergence, own issue) or `"external"` /
 * `"owned_elsewhere"` (the transition is real, but decided by another module —
 * never a silent pass). A doc transition with no registered check at all is
 * `"missing"` and fails the run: this is how doc drift (a renamed/added/removed
 * transition nobody updated the registration for) gets caught.
 *
 * L3 (graph invariants): a small reachability walk over a machine's declared
 * `{states, transitions, terminalStates}` checks:
 *   - completeness: every non-terminal state has >=1 outgoing transition;
 *   - liveness: every state can reach some terminal state;
 * plus a per-machine `safetyRules` list of predicates run over the real
 * observations (the executed code results) gathered while checking L2, e.g.
 * "no final-approval-readiness observation without both gates clean" or
 * "no fail-closed (blocked) observation that still permits a gate-progressing
 * action" — the concrete analogs, for this machine, of the generic "no ->merged
 * without both gates clean" / "fail-closed states never dispatch a Backlog
 * pull" invariants named in issue #1148.
 *
 * ---------------------------------------------------------------------------
 * Registration path (DoD3): adding a second machine requires ONLY calling
 * `registerMachine(machine)` with:
 *   {
 *     name,                 // stable machine id, e.g. "pr-gate-coordination"
 *     states,                // string[] — every state name in the graph
 *     terminalStates,        // string[] — absorbing states (subset of states)
 *     transitions,           // [from, to][] — the FULL graph, for L3 (may
 *                            //   include a synthetic '[*]' terminal marker
 *                            //   target; it is ignored by both L2 and L3)
 *     docTransitions,        // [from, to][] — the subset of `transitions`
 *                            //   the OWNER DOC declares (usually === transitions
 *                            //   minus the '[*]' marker rows); this is the L2
 *                            //   "doc table" and should be sourced from an
 *                            //   already-reviewed doc-derived table (reuse one
 *                            //   if it exists — see the pr-gate-coordination
 *                            //   registration below for the pattern) rather
 *                            //   than hand-copied prose, so it cannot silently
 *                            //   drift from the doc it represents;
 *     transitionChecks,      // Map<"from->to", Check> — the L2 "code table":
 *                            //   { status: "verified", verify: () => { ok, detail, result } }
 *                            //   { status: "known_gap", issue, note }
 *                            //   { status: "external"|"owned_elsewhere", note }
 *     safetyRules,           // [{ name, check: (observation) => boolean }]
 *   }
 * No engine function below needs to change for a new machine — see the
 * "adding a second machine" extensibility test in
 * test/docs/validate-state-machine-conformance.test.mjs.
 */

import { isDirectCliRun } from "../_core-helpers.mjs";
import { evaluatePrGateCoordination, PR_CHECKPOINT, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { DISPOSITION, STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { PR_LIFECYCLE_STATES, PR_LIFECYCLE_TRANSITIONS } from "../pages/build-state-atlas.mjs";

const USAGE = `Usage: validate-state-machine-conformance.mjs [--help]

Run the L2 (doc <-> code) conformance check and L3 (completeness/safety/liveness)
graph invariants for every registered state machine.
Exit 0 when every registered machine's checks pass or are explicitly accounted
for (known_gap/external/owned_elsewhere). Exit 1 on any missing coverage,
divergence, or invariant failure.

Options:
  --help, -h   Show this help`.trim();

const TERMINAL_MARKER = "[*]";

// ---------------------------------------------------------------------------
// Generic engine (no machine-specific knowledge below this line).
// ---------------------------------------------------------------------------

function realEdges(transitions) {
  return transitions.filter(([, to]) => to !== TERMINAL_MARKER);
}

/** L3 completeness: every non-terminal state has >=1 outgoing transition. */
export function checkCompleteness({ states, transitions, terminalStates }) {
  const outgoing = new Set(realEdges(transitions).map(([from]) => from));
  const deadEnds = states.filter((s) => !terminalStates.includes(s) && !outgoing.has(s));
  return { ok: deadEnds.length === 0, deadEnds };
}

/** L3 liveness: every state can reach some terminal state (reachability walk). */
export function checkLiveness({ states, transitions, terminalStates }) {
  const adjacency = new Map(states.map((s) => [s, []]));
  for (const [from, to] of realEdges(transitions)) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
  }

  const resolved = new Map();
  function canReachTerminal(state, path) {
    if (resolved.has(state)) return resolved.get(state);
    if (terminalStates.includes(state)) {
      resolved.set(state, true);
      return true;
    }
    if (path.has(state)) return false; // cycle without a resolved terminal (yet)
    path.add(state);
    let ok = false;
    for (const next of adjacency.get(state) ?? []) {
      if (canReachTerminal(next, path)) {
        ok = true;
        break;
      }
    }
    path.delete(state);
    if (ok) resolved.set(state, true);
    return ok;
  }

  const stuck = states.filter((s) => !canReachTerminal(s, new Set()));
  return { ok: stuck.length === 0, stuck };
}

/** L3 safety: run each named predicate over every gathered observation. */
export function checkSafetyRules(observations, safetyRules) {
  const violations = [];
  for (const rule of safetyRules) {
    for (const observation of observations) {
      if (!rule.check(observation)) {
        violations.push({ rule: rule.name, observation });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * L2: compare a doc-declared transition table against the registered code
 * checks. `transitionChecks` is a Map keyed by `"from->to"`.
 */
export function compareDocCodeTransitions(docTransitions, transitionChecks) {
  const results = [];
  const observations = [];
  for (const [from, to] of realEdges(docTransitions)) {
    const key = `${from}->${to}`;
    const check = transitionChecks.get(key);
    if (!check) {
      results.push({ from, to, status: "missing" });
      continue;
    }
    if (check.status === "verified") {
      const outcome = check.verify();
      if (outcome && outcome.result !== undefined) observations.push(outcome.result);
      results.push({ from, to, status: outcome.ok ? "verified" : "divergent", detail: outcome.detail });
    } else {
      results.push({ from, to, status: check.status, issue: check.issue ?? null, note: check.note ?? null });
    }
  }
  const ok = results.every((r) => r.status !== "missing" && r.status !== "divergent");
  return { ok, results, observations };
}

const REGISTRY = new Map();

/** Register a machine for conformance + invariant checking (see header). */
export function registerMachine(machine) {
  if (!machine || typeof machine.name !== "string" || machine.name.trim().length === 0) {
    throw new Error("registerMachine requires a non-empty `name`");
  }
  REGISTRY.set(machine.name, machine);
  return machine;
}

export function getRegisteredMachines() {
  return [...REGISTRY.values()];
}

/** Run every applicable check for one registered machine and return a report. */
export function runMachineConformance(machine) {
  const completeness = checkCompleteness(machine);
  const liveness = checkLiveness(machine);
  const conformance = machine.docTransitions && machine.transitionChecks
    ? compareDocCodeTransitions(machine.docTransitions, machine.transitionChecks)
    : { ok: true, results: [], observations: [] };
  const safety = machine.safetyRules && machine.safetyRules.length > 0
    ? checkSafetyRules(conformance.observations, machine.safetyRules)
    : { ok: true, violations: [] };

  return {
    name: machine.name,
    ok: completeness.ok && liveness.ok && conformance.ok && safety.ok,
    completeness,
    liveness,
    conformance,
    safety,
  };
}

// ---------------------------------------------------------------------------
// Reference machine (issue #1148): pr-gate-coordination.
//
// Doc side: skills/docs/pr-lifecycle-contract.md's "Required transitions" /
// lifecycle-state vocabulary — reused verbatim from
// scripts/pages/build-state-atlas.mjs's PR_LIFECYCLE_STATES/TRANSITIONS
// (already a reviewed, hand-derived structured table for that doc; see that
// file's own header for why no single code table exists for this doc's
// vocabulary today).
//
// Code side: packages/core/src/loop/pr-gate-coordination.mjs exports
// PR_CHECKPOINT / PR_CHECKPOINT_ACTION but no state-to-state table in the
// doc's vocabulary (a gate boundary is coarser than a lifecycle state, and
// several lifecycle transitions belong to the copilot inner-loop state graph,
// out of scope per #1148/#1156/#1157). Each doc transition below is checked by
// actually calling the exported `evaluatePrGateCoordination` with a fixture
// standing in for the "from" state and asserting the returned action/boundary
// is consistent with the "to" state — a real characterization of the code,
// not a hand-copied assumption.
// ---------------------------------------------------------------------------

function gate({ visible = false, headSha = null, verdict = null, contractComplete = false } = {}) {
  return { visible, headSha, verdict, contractComplete };
}

const HEAD = "abc1234567890";
const CLEAN_GATE = gate({ visible: true, headSha: "abc1234", verdict: "clean" });
const CLEAN_MARKER = gate({ visible: true, headSha: "abc1234", verdict: "clean", contractComplete: true });
const FINDINGS_GATE = gate({ visible: true, headSha: "abc1234", verdict: "findings_present" });

function run(input) {
  return evaluatePrGateCoordination({ currentHeadSha: HEAD, ...input });
}

const PR_GATE_TRANSITION_CHECKS = new Map();

function verified(key, verify) {
  PR_GATE_TRANSITION_CHECKS.set(key, { status: "verified", verify });
}

// draft_local_review_gate -> draft_local_remediation: blocking draft_gate findings.
verified("draft_local_review_gate->draft_local_remediation", () => {
  const result = run({ prDraft: true, lifecycleState: STATE.PR_DRAFT, ciStatus: "success", draftGate: FINDINGS_GATE });
  const ok = result.gateBoundary === PR_CHECKPOINT.DRAFT_REVIEW
    && result.nextAction === PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE
    && result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW);
  return { ok, detail: result, result };
});

// draft_local_review_gate -> ready_state_needs_copilot_request: clean current-head draft_gate evidence.
verified("draft_local_review_gate->ready_state_needs_copilot_request", () => {
  const result = run({
    prDraft: true,
    lifecycleState: STATE.PR_DRAFT,
    ciStatus: "success",
    draftGate: CLEAN_GATE,
    draftGateMarker: CLEAN_MARKER,
  });
  const ok = result.gateBoundary === PR_CHECKPOINT.DRAFT_REVIEW
    && result.nextAction === PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW;
  return { ok, detail: result, result };
});

// draft_local_review_gate -> stopped_needs_user_decision: human decision required (failing CI while draft).
verified("draft_local_review_gate->stopped_needs_user_decision", () => {
  const result = run({ prDraft: true, lifecycleState: STATE.PR_DRAFT, ciStatus: "failure", draftGate: gate({ visible: false }) });
  const ok = result.gateBoundary === PR_CHECKPOINT.BLOCKED && result.nextAction === PR_CHECKPOINT_ACTION.REPORT_BLOCKED;
  return { ok, detail: result, result };
});

// draft_local_remediation -> draft_local_review_gate: fixes pushed on the draft head (re-entry is the
// same draft-review call; the code does not model a distinct "remediation" boundary).
verified("draft_local_remediation->draft_local_review_gate", () => {
  const result = run({ prDraft: true, lifecycleState: STATE.PR_DRAFT, ciStatus: "success", draftGate: gate({ visible: false }) });
  const ok = result.gateBoundary === PR_CHECKPOINT.DRAFT_REVIEW && result.nextAction === PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE;
  return { ok, detail: result, result };
});

// ready_state_needs_copilot_request -> waiting_for_copilot_review: explicit request/confirm succeeded.
verified("ready_state_needs_copilot_request->waiting_for_copilot_review", () => {
  const result = run({ prDraft: false, lifecycleState: STATE.PR_READY_NO_FEEDBACK, loopDisposition: DISPOSITION.ACTION_REQUIRED });
  const ok = result.gateBoundary === PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW
    && result.nextAction === PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW;
  return { ok, detail: result, result };
});

// ready_state_needs_copilot_request -> stopped_needs_user_decision: request unavailable or blocked.
verified("ready_state_needs_copilot_request->stopped_needs_user_decision", () => {
  const result = run({ prDraft: false, lifecycleState: STATE.REVIEW_REQUEST_UNAVAILABLE });
  const ok = result.gateBoundary === PR_CHECKPOINT.BLOCKED && result.nextAction === PR_CHECKPOINT_ACTION.REPORT_BLOCKED;
  return { ok, detail: result, result };
});

// waiting_for_copilot_review -> merge_conflict_resolution: current-head merge state is conflicted.
// (Doc: "any open non-terminal lifecycle slice -> merge_conflict_resolution"; checked from this
// representative non-terminal slice since the guard fires ahead of every lifecycle-state branch.)
verified("waiting_for_copilot_review->merge_conflict_resolution", () => {
  const result = run({ prDraft: false, lifecycleState: STATE.WAITING_FOR_COPILOT_REVIEW, mergeStateStatus: "DIRTY" });
  const ok = result.gateBoundary === PR_CHECKPOINT.CONFLICT_RESOLUTION
    && result.nextAction === PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS;
  return { ok, detail: result, result };
});

// waiting_for_copilot_review -> final_local_preapproval_gate: the request/re-review cycle has settled
// cleanly with no unresolved feedback and no further Copilot pass needed.
//
// KNOWN GAP (issue #1148 / epic #1104 comment thread): the guard above is what the CONTRACT requires,
// but `evaluatePrGateCoordination` has no independent way to verify the reviewed head SHA actually
// matches `currentHeadSha` — it trusts the caller-supplied `sameHeadCleanConverged` flag as-is. The
// only fail-closed guard against an unsettled/unreviewed head lives downstream, at *verdict post*
// time (`upsert-checkpoint-verdict.mjs`'s unsettled-review refusal), not at *gate entry* here. This
// is intentionally NOT fixed by #1148 (own issue, tracked below) — encoded as an expected-fail so a
// future accidental "fix" (or regression) is visible instead of silently passing either way.
const KNOWN_GAP_TRACKING_ISSUE = "https://github.com/mfittko/dev-loops/issues/1190";
PR_GATE_TRANSITION_CHECKS.set("waiting_for_copilot_review->final_local_preapproval_gate", {
  status: "known_gap",
  issue: KNOWN_GAP_TRACKING_ISSUE,
  note: "Gate entry into pre_approval_gate trusts caller-supplied sameHeadCleanConverged with no "
    + "independent reviewed-head-SHA check; the fail-closed guard is at verdict-post "
    + "(upsert-checkpoint-verdict.mjs), not at gate entry (pr-gate-coordination.mjs). See epic #1104 "
    + "comment thread; tracked in #1190.",
});

// final_local_preapproval_gate -> final_gate_remediation: pre-approval gate findings require changes.
verified("final_local_preapproval_gate->final_gate_remediation", () => {
  const result = run({
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    sameHeadCleanConverged: true,
    preApprovalGate: FINDINGS_GATE,
  });
  const ok = result.gateBoundary === PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW
    && result.nextAction === PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE;
  return { ok, detail: result, result };
});

// final_local_preapproval_gate -> waiting_for_human_pr_approval: clean current-head pre_approval_gate
// evidence exists (the code additionally requires clean draft_gate evidence at this boundary — a
// stricter-than-the-bullet precondition consistent with this doc's own boundary notes and #579's
// "no gate exemptions"; the fixture below satisfies both so it characterizes real reachable behavior).
verified("final_local_preapproval_gate->waiting_for_human_pr_approval", () => {
  const result = run({
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    sameHeadCleanConverged: true,
    draftGate: gate({ visible: true, headSha: "abc1234", verdict: "clean" }),
    preApprovalGate: gate({ visible: true, headSha: HEAD.slice(0, 7), verdict: "clean" }),
    preApprovalGateMarker: gate({ visible: true, headSha: HEAD.slice(0, 7), verdict: "clean", contractComplete: true }),
  });
  const ok = result.gateBoundary === PR_CHECKPOINT.FINAL_APPROVAL_READY
    && result.nextAction === PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL;
  return { ok, detail: result, result };
});

// final_gate_remediation -> final_local_preapproval_gate: re-running the gate after fixes is the same
// RUN_PRE_APPROVAL_GATE call as the fresh-entry case above (the code has no distinct "remediation"
// boundary, same as the draft-gate pair).
verified("final_gate_remediation->final_local_preapproval_gate", () => {
  const result = run({
    prDraft: false,
    lifecycleState: STATE.READY_TO_REREQUEST_REVIEW,
    ciStatus: "success",
    sameHeadCleanConverged: true,
    preApprovalGate: FINDINGS_GATE,
  });
  const ok = result.gateBoundary === PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW
    && result.nextAction === PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE;
  return { ok, detail: result, result };
});

// waiting_for_human_pr_approval -> waiting_for_merge: approval arrives. External GitHub event; this
// function has no "approved" input and does not decide this transition.
PR_GATE_TRANSITION_CHECKS.set("waiting_for_human_pr_approval->waiting_for_merge", {
  status: "external",
  note: "Human approval is an external GitHub event; evaluatePrGateCoordination has no approved-state "
    + "input and does not decide this transition (see pr-lifecycle-contract.md: \"Human approval / "
    + "merge are explicit external waits\").",
});

// waiting_for_human_pr_approval -> draft_local_review_gate: PR reset to draft.
verified("waiting_for_human_pr_approval->draft_local_review_gate", () => {
  const result = run({ prDraft: true, lifecycleState: STATE.PR_DRAFT, ciStatus: "success", draftGate: gate({ visible: false }) });
  const ok = result.gateBoundary === PR_CHECKPOINT.DRAFT_REVIEW;
  return { ok, detail: result, result };
});

// waiting_for_merge -> terminal_slice_complete: merged/closed and the PR lifecycle is complete.
verified("waiting_for_merge->terminal_slice_complete", () => {
  const result = run({ prMerged: true, lifecycleState: STATE.DONE });
  const ok = result.gateBoundary === PR_CHECKPOINT.DONE && result.nextAction === PR_CHECKPOINT_ACTION.REPORT_DONE;
  return { ok, detail: result, result };
});

// copilot_feedback_remediation / copilot_reply_resolve_pending / merge_conflict_resolution's
// re-entry: these three transitions are decided by the copilot inner-loop state graph
// (packages/core/src/loop/copilot-loop-state.mjs TRANSITIONS), which is out of scope for this
// reference machine per #1148/#1156/#1157 — pr-gate-coordination only reacts to whichever STATE
// it is handed, it does not compute the STATE-to-STATE progression itself.
for (const key of [
  "waiting_for_copilot_review->copilot_feedback_remediation",
  "copilot_feedback_remediation->copilot_reply_resolve_pending",
  "copilot_reply_resolve_pending->ready_state_needs_copilot_request",
  "merge_conflict_resolution->waiting_for_copilot_review",
]) {
  PR_GATE_TRANSITION_CHECKS.set(key, {
    status: "owned_elsewhere",
    note: "State-to-state progression for the copilot inner review/fix loop is owned by "
      + "copilot-loop-state.mjs's own STATE/TRANSITIONS table (#1156/#1157), not by "
      + "pr-gate-coordination.mjs; this function only reacts to whichever STATE it is handed.",
  });
}

const PR_GATE_COORDINATION_MACHINE = {
  name: "pr-gate-coordination",
  states: PR_LIFECYCLE_STATES,
  terminalStates: ["terminal_slice_complete", "stopped_needs_user_decision"],
  transitions: PR_LIFECYCLE_TRANSITIONS,
  docTransitions: PR_LIFECYCLE_TRANSITIONS,
  transitionChecks: PR_GATE_TRANSITION_CHECKS,
  safetyRules: [
    {
      // Analog of "no ->merged without both gates clean at head": final-approval readiness
      // (this machine's closest reachable state to "ready to merge") requires both draft_gate and
      // pre_approval_gate to be clean-at-head; PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY itself is
      // never returned as an allowed action by this function at all (merge is external/human-only),
      // so that half of the analog holds trivially and is asserted directly in the unit test.
      name: "no-final-approval-without-both-gates-clean",
      check: (result) => result.nextAction !== PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL
        || (result.draftGate.cleanEvidenceExists && result.preApprovalGate.currentHeadClean),
    },
    {
      // Analog of "fail-closed states never dispatch a Backlog pull": a blocked (fail-closed)
      // result must never permit a gate-progressing action.
      name: "blocked-never-permits-gate-progress",
      check: (result) => result.gateBoundary !== PR_CHECKPOINT.BLOCKED
        || !result.allowedNextActions.some((action) => [
          PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
          PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
          PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
          PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
          PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
        ].includes(action)),
    },
  ],
};

registerMachine(PR_GATE_COORDINATION_MACHINE);

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let ok = true;
  for (const machine of getRegisteredMachines()) {
    const report = runMachineConformance(machine);
    ok = ok && report.ok;
    process.stdout.write(`Machine ${report.name}: ${report.ok ? "PASS" : "FAIL"}\n`);
    if (!report.completeness.ok) process.stdout.write(`  completeness: dead-end state(s): ${report.completeness.deadEnds.join(", ")}\n`);
    if (!report.liveness.ok) process.stdout.write(`  liveness: state(s) stuck without a terminal path: ${report.liveness.stuck.join(", ")}\n`);
    if (!report.conformance.ok) {
      for (const r of report.conformance.results) {
        if (r.status === "missing" || r.status === "divergent") {
          process.stdout.write(`  conformance ${r.status}: ${r.from} -> ${r.to}\n`);
        }
      }
    }
    for (const r of report.conformance.results) {
      if (r.status === "known_gap") process.stdout.write(`  known gap (tracked): ${r.from} -> ${r.to} (${r.issue})\n`);
    }
    if (!report.safety.ok) {
      for (const v of report.safety.violations) process.stdout.write(`  safety violation: ${v.rule}\n`);
    }
  }
  return ok ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
