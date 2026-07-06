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
 *     docTransitions,        // [from, to][] — the transitions the OWNER DOC
 *                            //   declares (usually === transitions minus the
 *                            //   '[*]' marker rows); this is the L2 "doc
 *                            //   table" and MUST be parsed from the owner
 *                            //   doc's own structured transition section via
 *                            //   `parseRequiredTransitions` (see the
 *                            //   pr-gate-coordination registration below for
 *                            //   the pattern), so editing the doc is visible
 *                            //   to the harness — never a hand-copied array;
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

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../_core-helpers.mjs";
import { evaluatePrGateCoordination, PR_CHECKPOINT, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { DISPOSITION, interpretLoopState, STATE, TRANSITIONS } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluateConductorRouting, getAllowedOuterTransitions, OUTER_STATE, OUTER_TERMINAL_STATES } from "@dev-loops/core/loop/conductor-routing";
import { interpretReviewerLoopState, REVIEWER_STATE, REVIEWER_TRANSITIONS } from "@dev-loops/core/loop/reviewer-loop-state";
import { PR_LIFECYCLE_STATES, PR_LIFECYCLE_TRANSITIONS } from "./_pr-lifecycle-tables.mjs";

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

/**
 * L2 doc-side parser: read a contract doc's structured transition section
 * (top-level bullets of the shape "- `from` -> `to`" under `sectionHeading`)
 * into a [from, to][] table. Rows whose from/to is prose rather than a
 * backtick token (abstract rows like "any open non-terminal lifecycle slice")
 * MUST be resolved via an explicit `abstractRows` mapping
 * (Map<"from->to raw text", [from, to][]>) — an unmapped abstract row throws,
 * never silently drops, so a new abstract bullet in the doc is loud.
 *
 * Caveat: a top-level line that does not match "- X -> Y" at all (a unicode
 * arrow, or missing the "- " bullet prefix) is treated as prose and skipped —
 * that drop is silent. A line that DOES match "- X -> Y" but whose from/to is
 * neither a `backtick token` nor a mapped abstractRows entry (e.g. a bullet
 * with a trailing annotation after the arrow) is NOT silent: it fails the
 * backtick-token match and throws via the unmapped-abstract-row path above.
 * For pr-gate-coordination the load-time 1:1 doc<->atlas binding below
 * additionally catches every silent-drop case; a second machine MUST pair
 * this parser with an equivalent independent binding (or extend the parser
 * with a "looks like a transition bullet but did not parse" check).
 */
export function parseRequiredTransitions(markdown, { sectionHeading = "## Required transitions", abstractRows = new Map() } = {}) {
  // The heading may open the file (index 0, no leading "\n") or appear further down (leading
  // "\n"); check both so a doc that starts with this section is not falsely reported as missing.
  const atStart = markdown.startsWith(`${sectionHeading}\n`);
  const sectionStart = atStart ? 0 : markdown.indexOf(`\n${sectionHeading}\n`);
  if (sectionStart === -1) throw new Error(`doc has no "${sectionHeading}" section`);
  const headingEnd = sectionStart + (atStart ? 0 : 1) + sectionHeading.length + 1;
  const afterHeading = markdown.slice(headingEnd);
  const body = afterHeading.split(/\n#{1,6} /)[0];

  const transitions = [];
  for (const line of body.split(/\r?\n/)) {
    const bullet = line.match(/^- (.+?) -> (.+)$/);
    if (!bullet) continue; // sub-bullets (guards) are indented and skipped
    const parts = [bullet[1].trim(), bullet[2].trim()];
    const tokens = parts.map((p) => p.match(/^`([A-Za-z0-9_]+)`$/)?.[1] ?? null);
    if (tokens[0] !== null && tokens[1] !== null) {
      transitions.push([tokens[0], tokens[1]]);
      continue;
    }
    const rawKey = `${parts[0]}->${parts[1]}`;
    const mapped = abstractRows.get(rawKey);
    if (!mapped) throw new Error(`unmapped abstract transition row in doc: "${rawKey}" — add it to abstractRows`);
    transitions.push(...mapped);
  }
  if (transitions.length === 0) throw new Error(`"${sectionHeading}" section contains no transition bullets`);
  return transitions;
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
 * checks. `transitionChecks` is a Map keyed by `"from->to"`. Bidirectional:
 * a doc transition with no check is "missing"; a check key no doc transition
 * references is "unreferenced" (a stale check, or a code-side transition the
 * doc dropped) — both fail. A `verify()` that throws is caught per-transition
 * and reported as "divergent" (fail-closed) rather than aborting the run, so
 * every other transition still gets checked and surfaces in the same report.
 */
export function compareDocCodeTransitions(docTransitions, transitionChecks) {
  const results = [];
  const observations = [];
  const referencedKeys = new Set();
  for (const [from, to] of realEdges(docTransitions)) {
    const key = `${from}->${to}`;
    referencedKeys.add(key);
    const check = transitionChecks.get(key);
    if (!check) {
      results.push({ from, to, status: "missing" });
      continue;
    }
    if (check.status === "verified") {
      // A throwing verify() is itself a divergence (fail-closed), not a reason to abort the
      // whole run: report this transition as divergent with the error and keep checking the
      // rest so other missing/unreferenced edges still surface in the same report.
      try {
        const outcome = check.verify();
        if (outcome && outcome.result !== undefined) observations.push(outcome.result);
        results.push({ from, to, status: outcome.ok ? "verified" : "divergent", detail: outcome.detail });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ from, to, status: "divergent", detail: `verify() threw: ${message}` });
      }
    } else {
      results.push({ from, to, status: check.status, issue: check.issue ?? null, note: check.note ?? null });
    }
  }
  for (const key of transitionChecks.keys()) {
    if (!referencedKeys.has(key)) {
      const [from, to] = key.split("->");
      results.push({ from, to, status: "unreferenced" });
    }
  }
  const ok = results.every((r) => r.status !== "missing" && r.status !== "divergent" && r.status !== "unreferenced");
  return { ok, results, observations };
}

const REGISTRY = new Map();

/** Register a machine for conformance + invariant checking (see header). */
export function registerMachine(machine) {
  if (!machine || typeof machine.name !== "string" || machine.name.trim().length === 0) {
    throw new Error("registerMachine requires a non-empty `name`");
  }
  // Fail-closed shape check: L2 needs BOTH tables; exactly one present is a
  // half-registered machine that would otherwise skip L2 silently as ok:true.
  if (Boolean(machine.docTransitions) !== Boolean(machine.transitionChecks)) {
    throw new Error(`machine "${machine.name}" must provide docTransitions and transitionChecks together (or neither)`);
  }
  if (REGISTRY.has(machine.name)) {
    throw new Error(`machine "${machine.name}" is already registered — duplicate registration would silently overwrite it`);
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
// Doc side: skills/docs/pr-lifecycle-contract.md's "## Required transitions"
// bullets, parsed at load time via parseRequiredTransitions so a doc edit is
// immediately visible to the harness. The two abstract (non-backtick) rows are
// mapped explicitly to their concrete representatives below. The parsed table
// is additionally asserted to bind 1:1 to _pr-lifecycle-tables.mjs's
// PR_LIFECYCLE_TRANSITIONS (the shared pure-data table also consumed by
// build-state-atlas.mjs's diagram), so that constant cannot drift from the doc
// either.
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Abstract doc rows -> concrete graph edges. "any open non-terminal lifecycle
// slice" is represented by waiting_for_copilot_review (the guard fires ahead of
// every lifecycle-state branch in the code, so one representative suffices);
// "normal lifecycle re-entry state" re-enters the same representative slice.
const PR_LIFECYCLE_ABSTRACT_ROWS = new Map([
  ["any open non-terminal lifecycle slice->`merge_conflict_resolution`", [["waiting_for_copilot_review", "merge_conflict_resolution"]]],
  ["`merge_conflict_resolution`->normal lifecycle re-entry state", [["merge_conflict_resolution", "waiting_for_copilot_review"]]],
]);

// Edges the doc implies but does not bullet under "Required transitions".
// pr-lifecycle-contract.md sends pre-approval findings to final_gate_remediation
// and its "Remediation ownership boundary" section routes that remediation back
// to the gate, but no explicit re-entry bullet exists (unlike the draft pair's
// draft_local_remediation -> draft_local_review_gate). Without this edge the
// state is a non-terminal dead-end, so the atlas diagram carries it; it is
// allowlisted here explicitly instead of silently — remove this entry if the
// doc ever gains the bullet.
const PR_LIFECYCLE_IMPLIED_EDGES = [["final_gate_remediation", "final_local_preapproval_gate"]];

const PR_LIFECYCLE_PARSED_DOC_TRANSITIONS = parseRequiredTransitions(
  readFileSync(path.join(REPO_ROOT, "skills", "docs", "pr-lifecycle-contract.md"), "utf8"),
  { abstractRows: PR_LIFECYCLE_ABSTRACT_ROWS },
);

// Self-retiring seam: once the doc bullets an implied edge, this entry is stale.
for (const [from, to] of PR_LIFECYCLE_IMPLIED_EDGES) {
  if (PR_LIFECYCLE_PARSED_DOC_TRANSITIONS.some(([a, b]) => a === from && b === to)) {
    throw new Error(`implied edge ${from}->${to} now appears in the doc — remove it from PR_LIFECYCLE_IMPLIED_EDGES`);
  }
}

const PR_LIFECYCLE_DOC_TRANSITIONS = [
  ...PR_LIFECYCLE_PARSED_DOC_TRANSITIONS,
  ...PR_LIFECYCLE_IMPLIED_EDGES,
];

// Bind the parsed doc table 1:1 to the atlas constant (order-insensitive).
{
  const docSet = new Set(PR_LIFECYCLE_DOC_TRANSITIONS.map(([a, b]) => `${a}->${b}`));
  const atlasSet = new Set(realEdges(PR_LIFECYCLE_TRANSITIONS).map(([a, b]) => `${a}->${b}`));
  const onlyDoc = [...docSet].filter((k) => !atlasSet.has(k));
  const onlyAtlas = [...atlasSet].filter((k) => !docSet.has(k));
  if (onlyDoc.length > 0 || onlyAtlas.length > 0) {
    throw new Error(
      "pr-lifecycle-contract.md Required transitions and build-state-atlas.mjs PR_LIFECYCLE_TRANSITIONS have drifted apart. "
      + `Only in doc: [${onlyDoc.join(", ")}]. Only in atlas: [${onlyAtlas.join(", ")}].`,
    );
  }
}

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
    + "comment thread; tracked in #1190. NOTE: this allowlist entry never fails the CLI — if #1190 "
    + "lands a backward-compatible gate-entry guard, this run keeps passing silently; the loud guard "
    + "is the known-gap regression test in test/docs/validate-state-machine-conformance.test.mjs, "
    + "which starts failing the moment the gap closes and tells you to retire this entry.",
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
  docTransitions: PR_LIFECYCLE_DOC_TRANSITIONS,
  transitionChecks: PR_GATE_TRANSITION_CHECKS,
  safetyRules: [
    {
      // Analog of "no ->merged without both gates clean at head": final-approval readiness
      // (this machine's closest reachable state to "ready to merge") requires both draft_gate and
      // pre_approval_gate to be clean-at-head. The other half of the analog — DECLARE_MERGE_READY
      // never appearing in any allowedNextActions (merge is external/human-only) — is asserted over
      // the gathered observations in test/docs/validate-state-machine-conformance.test.mjs.
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

// ---------------------------------------------------------------------------
// Second machine (issue #1156): conductor-routing.
//
// Doc side: docs/conductor-routing-contract.md's "## Required transitions" bullets,
// parsed at load time via parseRequiredTransitions. The doc bullets one abstract row
// per non-terminal outer state ("`state` -> any outer state") because the outer-loop
// graph is stateless per cycle (every evaluation is independent, so a non-terminal
// outcome can be followed, next cycle, by any of the 7 outcomes) — the abstractRows
// map below expands each row to its 7 concrete edges.
//
// Code side: packages/core/src/loop/conductor-routing.mjs exports OUTER_STATE,
// OUTER_TERMINAL_STATES, and getAllowedOuterTransitions. Each expanded edge is checked
// by calling the real evaluateConductorRouting with a fixture drawn verbatim from the
// doc's own "Scenario matrix" (one fixture per reachable `to` state, reused across every
// `from`) and asserting getAllowedOuterTransitions(from) structurally allows `to` while
// the fixture's real routingOutcome matches `to` — a real characterization of the code,
// not a hand-copied assumption.
// ---------------------------------------------------------------------------

const OUTER_STATE_VALUES = Object.values(OUTER_STATE);
const OUTER_NON_TERMINAL_STATES = OUTER_STATE_VALUES.filter((s) => !OUTER_TERMINAL_STATES.includes(s));

const CONDUCTOR_ROUTING_ABSTRACT_ROWS = new Map(
  OUTER_NON_TERMINAL_STATES.map((from) => [
    `\`${from}\`->any outer state`,
    OUTER_STATE_VALUES.map((to) => [from, to]),
  ]),
);

const CONDUCTOR_ROUTING_DOC_TRANSITIONS = parseRequiredTransitions(
  readFileSync(path.join(REPO_ROOT, "docs", "conductor-routing-contract.md"), "utf8"),
  { abstractRows: CONDUCTOR_ROUTING_ABSTRACT_ROWS },
);

const TARGET = { repo: "acme/widgets", pr: 42 };

function routeOuter(input) {
  return evaluateConductorRouting({ target: TARGET, ...input });
}

// One fixture per reachable outer state. Inputs are doc-described routing-policy
// combinations (mostly the doc's Scenario matrix; CONTINUE_CURRENT_WAIT and
// HANDOFF_TO_COPILOT_LOOP use equivalent doc-described input pairs where the
// literal scenario rows were repurposed for other states) — no invented behavior.
const OUTER_TO_FIXTURE = new Map([
  [OUTER_STATE.CONTINUE_CURRENT_WAIT, () => routeOuter({ copilotState: "waiting_for_copilot_review", reviewerState: "waiting_for_author_followup" })],
  [OUTER_STATE.HANDOFF_TO_COPILOT_LOOP, () => routeOuter({ copilotState: "pr_draft", reviewerState: "waiting_for_review_request" })],
  [OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP, () => routeOuter({ copilotState: "pr_ready_no_feedback", reviewerState: "review_requested" })],
  [OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER, () => routeOuter({ copilotState: "unresolved_feedback_present", reviewerState: "waiting_for_author_followup", ownershipState: "live_owner" })],
  [OUTER_STATE.STOP_NEEDS_HUMAN, () => routeOuter({ copilotState: "blocked_needs_user_decision", reviewerState: "waiting_for_review_request" })],
  [OUTER_STATE.DONE_TERMINAL, () => routeOuter({ copilotState: "done", reviewerState: "waiting_for_review_request" })],
  [OUTER_STATE.NEEDS_RECONCILE, () => routeOuter({ copilotState: "some_unmapped_copilot_state", reviewerState: "some_unmapped_reviewer_state" })],
]);

const CONDUCTOR_ROUTING_TRANSITION_CHECKS = new Map();
for (const from of OUTER_NON_TERMINAL_STATES) {
  for (const to of OUTER_STATE_VALUES) {
    CONDUCTOR_ROUTING_TRANSITION_CHECKS.set(`${from}->${to}`, {
      status: "verified",
      verify: () => {
        const result = OUTER_TO_FIXTURE.get(to)();
        const ok = result.routingOutcome === to && getAllowedOuterTransitions(from).includes(to);
        return { ok, detail: result, result };
      },
    });
  }
}

const CONDUCTOR_ROUTING_MACHINE = {
  name: "conductor-routing",
  states: OUTER_STATE_VALUES,
  terminalStates: OUTER_TERMINAL_STATES,
  transitions: OUTER_NON_TERMINAL_STATES.flatMap((from) => getAllowedOuterTransitions(from).map((to) => [from, to])),
  docTransitions: CONDUCTOR_ROUTING_DOC_TRANSITIONS,
  transitionChecks: CONDUCTOR_ROUTING_TRANSITION_CHECKS,
  safetyRules: [
    {
      // Analog of "fail-closed states never dispatch a Backlog pull" (epic #1104 / docs:
      // ROUTING-FAIL-CLOSED-RECONCILE): a fail-closed observation never carries a live handoff.
      name: "fail-closed-no-dispatch",
      check: (result) => (result.routingOutcome !== OUTER_STATE.STOP_NEEDS_HUMAN && result.routingOutcome !== OUTER_STATE.NEEDS_RECONCILE)
        || (result.handoffEnvelope.loopFamily === null && result.handoffEnvelope.entrypoint === null),
    },
  ],
};

registerMachine(CONDUCTOR_ROUTING_MACHINE);

// ---------------------------------------------------------------------------
// Third machine (issue #1157): copilot-loop-state.
//
// Doc side: docs/copilot-loop-state-graph.md's "## Required transitions" bullets,
// parsed at load time via parseRequiredTransitions.
//
// Code side: packages/core/src/loop/copilot-loop-state.mjs exports STATE, TRANSITIONS,
// and interpretLoopState. Both STATE/TRANSITIONS are a plain lookup table (there is no
// "evaluate a from->to edge" function), so each doc transition is checked two ways: (1)
// structurally, TRANSITIONS[from] must include `to` (the real code table, not a hand-copied
// assumption); (2) behaviorally, a real snapshot fixture reaching `to` is run through the
// real interpretLoopState and must actually land on `to` — one fixture per reachable `to`
// state, reused across every `from` that doc-declares an edge into it (same pattern as
// conductor-routing's OUTER_TO_FIXTURE).
// ---------------------------------------------------------------------------

// Independent doc<->code binding required by the parseRequiredTransitions header caveat:
// the transitionChecks below are DERIVED from the parsed doc, so on their own they are
// one-directional (a silently dropped/deleted doc bullet would just shrink both tables in
// lockstep and keep passing). This load-time set-equality against the code's own transition
// table (mirroring pr-gate-coordination's atlas binding) makes any dropped, mangled, or
// deleted bullet throw loudly.
function bindDocToCodeTable(machineName, docTransitions, codeEdges) {
  const docSet = new Set(realEdges(docTransitions).map(([a, b]) => `${a}->${b}`));
  const codeSet = new Set(codeEdges.map(([a, b]) => `${a}->${b}`));
  const onlyDoc = [...docSet].filter((k) => !codeSet.has(k));
  const onlyCode = [...codeSet].filter((k) => !docSet.has(k));
  if (onlyDoc.length > 0 || onlyCode.length > 0) {
    throw new Error(
      `${machineName}: doc "Required transitions" and the code transition table have drifted apart. `
      + `Only in doc: [${onlyDoc.join(", ")}]. Only in code: [${onlyCode.join(", ")}].`,
    );
  }
}

function tableEdges(table) {
  return Object.entries(table).flatMap(([from, tos]) => tos.map((to) => [from, to]));
}

function tableTerminalStates(table) {
  return Object.entries(table).filter(([, tos]) => tos.length === 0).map(([state]) => state);
}

const COPILOT_LOOP_STATE_DOC_TRANSITIONS = parseRequiredTransitions(
  readFileSync(path.join(REPO_ROOT, "docs", "copilot-loop-state-graph.md"), "utf8"),
);

bindDocToCodeTable("copilot-loop-state", COPILOT_LOOP_STATE_DOC_TRANSITIONS, tableEdges(TRANSITIONS));

const COPILOT_LOOP_STATE_TO_FIXTURE = new Map([
  [STATE.PR_READY_NO_FEEDBACK, () => ({ prExists: true, prDraft: false, copilotReviewRequestStatus: "none", copilotReviewPresent: false, unresolvedThreadCount: 0, ciStatus: "success" })],
  [STATE.WAITING_FOR_COPILOT_REVIEW, () => ({ prExists: true, prDraft: false, copilotReviewRequestStatus: "requested", unresolvedThreadCount: 0 })],
  [STATE.UNRESOLVED_FEEDBACK_PRESENT, () => ({ prExists: true, prDraft: false, unresolvedThreadCount: 2, agentFixStatus: null })],
  [STATE.ALREADY_FIXED_NEEDS_REPLY_RESOLVE, () => ({ prExists: true, prDraft: false, unresolvedThreadCount: 2, agentFixStatus: "applied" })],
  [STATE.READY_TO_REREQUEST_REVIEW, () => ({ prExists: true, prDraft: false, copilotReviewPresent: true, unresolvedThreadCount: 0, ciStatus: "success", copilotReviewRequestStatus: "none" })],
  [STATE.WAITING_FOR_CI, () => ({ prExists: true, prDraft: false, copilotReviewPresent: true, unresolvedThreadCount: 0, ciStatus: "pending", copilotReviewRequestStatus: "none" })],
  [STATE.BLOCKED_NEEDS_USER_DECISION, () => ({ prExists: true, prDraft: false, copilotReviewRequestStatus: "failed" })],
  [STATE.REVIEW_REQUEST_UNAVAILABLE, () => ({ prExists: true, prDraft: false, copilotReviewRequestStatus: "unavailable" })],
  [STATE.DONE, () => ({ prExists: true, prMerged: true })],
]);

const COPILOT_LOOP_STATE_TRANSITION_CHECKS = new Map();
for (const [from, to] of realEdges(COPILOT_LOOP_STATE_DOC_TRANSITIONS)) {
  const buildFixture = COPILOT_LOOP_STATE_TO_FIXTURE.get(to);
  if (!buildFixture) throw new Error(`copilot-loop-state: no fixture registered for reachable state "${to}"`);
  COPILOT_LOOP_STATE_TRANSITION_CHECKS.set(`${from}->${to}`, {
    status: "verified",
    verify: () => {
      const fixture = buildFixture();
      const interpretation = interpretLoopState(fixture);
      const ok = interpretation.state === to && (TRANSITIONS[from] || []).includes(to);
      return {
        ok,
        detail: interpretation,
        result: {
          state: interpretation.state,
          unresolvedThreadCount: fixture.unresolvedThreadCount ?? 0,
          copilotReviewRequestStatus: fixture.copilotReviewRequestStatus ?? "none",
        },
      };
    },
  });
}

const COPILOT_LOOP_STATE_MACHINE = {
  name: "copilot-loop-state",
  states: Object.values(STATE),
  terminalStates: tableTerminalStates(TRANSITIONS),
  transitions: tableEdges(TRANSITIONS),
  docTransitions: COPILOT_LOOP_STATE_DOC_TRANSITIONS,
  transitionChecks: COPILOT_LOOP_STATE_TRANSITION_CHECKS,
  safetyRules: [
    {
      // Analog of "fail-closed states never dispatch a Backlog pull" for this machine
      // (docs: COPILOT-STATE-UNRESOLVED-PRIORITY): unresolved feedback must never resolve
      // to a wait state, even when an active review request is also present.
      name: "unresolved-feedback-outranks-active-request-wait",
      check: (observation) => observation.unresolvedThreadCount === 0
        || (observation.state !== STATE.WAITING_FOR_COPILOT_REVIEW && observation.state !== STATE.WAITING_FOR_CI),
    },
  ],
};

registerMachine(COPILOT_LOOP_STATE_MACHINE);

// ---------------------------------------------------------------------------
// Fourth machine (issue #1157): reviewer-loop-state.
//
// Doc side: docs/reviewer-loop-state-graph.md's "## Required transitions" bullets. The doc
// bullets one abstract row for the five reviewer-pass states that all fail closed into
// `blocked_needs_user_decision` on an unexpected failure, expanded below.
//
// Code side: packages/core/src/loop/reviewer-loop-state.mjs exports REVIEWER_STATE,
// REVIEWER_TRANSITIONS, and interpretReviewerLoopState. Checked the same two ways as
// copilot-loop-state above. `waiting_for_author_followup` / `waiting_for_re_request` are
// legacy compatibility states `interpretReviewerLoopState` never assigns as its own output
// (see the doc's note); their re-entry transitions are owned_elsewhere (the outer-loop
// compatibility layer), not by this pure interpreter.
// ---------------------------------------------------------------------------

const REVIEWER_LOOP_STATE_ABSTRACT_ROWS = new Map([
  ["any active reviewer-pass state->`blocked_needs_user_decision`", [
    [REVIEWER_STATE.REVIEW_REQUESTED, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION],
    [REVIEWER_STATE.DETERMINE_REVIEW_PLAN, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION],
    [REVIEWER_STATE.REVIEWS_RUNNING, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION],
    [REVIEWER_STATE.MERGE_RESULTS, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION],
    [REVIEWER_STATE.DRAFT_REVIEW_READY, REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION],
  ]],
]);

const REVIEWER_LOOP_STATE_DOC_TRANSITIONS = parseRequiredTransitions(
  readFileSync(path.join(REPO_ROOT, "docs", "reviewer-loop-state-graph.md"), "utf8"),
  { abstractRows: REVIEWER_LOOP_STATE_ABSTRACT_ROWS },
);

bindDocToCodeTable("reviewer-loop-state", REVIEWER_LOOP_STATE_DOC_TRANSITIONS, tableEdges(REVIEWER_TRANSITIONS));

// Transitions owned by the outer-loop legacy-compatibility layer, not by this pure
// interpreter (see header comment): interpretReviewerLoopState never assigns
// WAITING_FOR_AUTHOR_FOLLOWUP or WAITING_FOR_RE_REQUEST as its own output state, so no
// fixture can characterize a real "from" call landing on either of them.
const REVIEWER_LOOP_STATE_OWNED_ELSEWHERE_EDGES = [
  [REVIEWER_STATE.WAITING_FOR_AUTHOR_FOLLOWUP, REVIEWER_STATE.SUBMITTED_REVIEW],
  [REVIEWER_STATE.WAITING_FOR_AUTHOR_FOLLOWUP, REVIEWER_STATE.REVIEW_REQUESTED],
  [REVIEWER_STATE.WAITING_FOR_AUTHOR_FOLLOWUP, REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST],
  [REVIEWER_STATE.WAITING_FOR_RE_REQUEST, REVIEWER_STATE.REVIEW_REQUESTED],
  [REVIEWER_STATE.WAITING_FOR_RE_REQUEST, REVIEWER_STATE.SUBMITTED_REVIEW],
];

const REVIEWER_LOOP_STATE_TO_FIXTURE = new Map([
  [REVIEWER_STATE.REVIEW_REQUESTED, () => ({ prExists: true, prDraft: false, reviewRequested: true })],
  [REVIEWER_STATE.DETERMINE_REVIEW_PLAN, () => ({ prExists: true, prDraft: false, localPlanningStatus: "determining" })],
  [REVIEWER_STATE.REVIEWS_RUNNING, () => ({ prExists: true, prDraft: false, localReviewRunsStatus: "running" })],
  [REVIEWER_STATE.MERGE_RESULTS, () => ({ prExists: true, prDraft: false, localReviewRunsStatus: "completed" })],
  [REVIEWER_STATE.DRAFT_REVIEW_READY, () => ({ prExists: true, prDraft: false, draftReviewPrepared: true })],
  [REVIEWER_STATE.DRAFT_REVIEW_POSTED, () => ({ prExists: true, prDraft: false, draftReviewPosted: true, draftReviewNotificationStatus: "none", prHeadSha: "abc1234", draftReviewCommitSha: "abc1234" })],
  [REVIEWER_STATE.WAITING_FOR_USER_SUBMIT, () => ({ prExists: true, prDraft: false, draftReviewPosted: true, draftReviewNotificationStatus: "notified", prHeadSha: "abc1234", draftReviewCommitSha: "abc1234" })],
  [REVIEWER_STATE.SUBMITTED_REVIEW, () => ({ prExists: true, prDraft: false, submittedReviewPresent: true, prHeadSha: "abc1234", submittedReviewCommitSha: "abc1234", reviewRequested: false })],
  [REVIEWER_STATE.REVIEW_INVALIDATED, () => ({ prExists: true, prDraft: false, draftReviewPosted: true, prHeadSha: "def5678", draftReviewCommitSha: "abc1234" })],
  [REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST, () => ({ prExists: false })],
  [REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION, () => ({ prExists: true, prDraft: false, localPlanningStatus: "failed" })],
]);

const REVIEWER_LOOP_STATE_TRANSITION_CHECKS = new Map();
for (const [from, to] of REVIEWER_LOOP_STATE_OWNED_ELSEWHERE_EDGES) {
  // owned_elsewhere skips the behavioral verify(), but the cheap structural check still
  // applies: the edge must exist in the real code table, so removing it from
  // REVIEWER_TRANSITIONS surfaces here instead of passing silently.
  if (!(REVIEWER_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`reviewer-loop-state: owned_elsewhere edge ${from}->${to} is not in REVIEWER_TRANSITIONS`);
  }
  REVIEWER_LOOP_STATE_TRANSITION_CHECKS.set(`${from}->${to}`, {
    status: "owned_elsewhere",
    note: "Legacy external-wait compatibility state re-entry is owned by the outer-loop "
      + "compatibility layer, not by interpretReviewerLoopState, which never assigns "
      + `"${from}" as its own output state (see docs/reviewer-loop-state-graph.md).`,
  });
}
for (const [from, to] of realEdges(REVIEWER_LOOP_STATE_DOC_TRANSITIONS)) {
  const key = `${from}->${to}`;
  if (REVIEWER_LOOP_STATE_TRANSITION_CHECKS.has(key)) continue;
  const buildFixture = REVIEWER_LOOP_STATE_TO_FIXTURE.get(to);
  if (!buildFixture) throw new Error(`reviewer-loop-state: no fixture registered for reachable state "${to}"`);
  REVIEWER_LOOP_STATE_TRANSITION_CHECKS.set(key, {
    status: "verified",
    verify: () => {
      const fixture = buildFixture();
      const interpretation = interpretReviewerLoopState(fixture);
      const ok = interpretation.state === to && (REVIEWER_TRANSITIONS[from] || []).includes(to);
      return {
        ok,
        detail: interpretation,
        result: {
          state: interpretation.state,
          // Only localPlanningStatus is ever set to "failed" by a registered
          // fixture (the BLOCKED one); other failure fields join here if a
          // future fixture exercises them.
          failed: fixture.localPlanningStatus === "failed",
        },
      };
    },
  });
}

const REVIEWER_LOOP_STATE_MACHINE = {
  name: "reviewer-loop-state",
  states: Object.values(REVIEWER_STATE),
  terminalStates: tableTerminalStates(REVIEWER_TRANSITIONS),
  transitions: tableEdges(REVIEWER_TRANSITIONS),
  docTransitions: REVIEWER_LOOP_STATE_DOC_TRANSITIONS,
  transitionChecks: REVIEWER_LOOP_STATE_TRANSITION_CHECKS,
  safetyRules: [
    {
      // Analog of "fail-closed states never dispatch a Backlog pull" for this machine:
      // any local-status failure must fail closed into blocked_needs_user_decision, never
      // silently proceed into a draft/submit/wait branch.
      name: "local-failure-always-fails-closed",
      check: (observation) => !observation.failed || observation.state === REVIEWER_STATE.BLOCKED_NEEDS_USER_DECISION,
    },
  ],
};

registerMachine(REVIEWER_LOOP_STATE_MACHINE);

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
        if (r.status === "missing" || r.status === "divergent" || r.status === "unreferenced") {
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
