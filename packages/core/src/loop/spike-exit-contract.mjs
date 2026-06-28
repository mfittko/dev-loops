/**
 * Spike-mode exit (P2 of the spike-mode track #965).
 *
 * Phase 1 (#964) shipped the spike intake state machine
 * (`evaluateSpikeIntakeState` → SPIKE_INTAKE_STATE). A spike becomes exitable
 * only once it carries a Recommendation (`spike_ready_for_exit`). This module is
 * the exit decision: from that ready state, the operator picks a disposition —
 *   - DISCARD  — the recommendation is "don't pursue"; drop the spike with ZERO
 *                tracker artifacts (the findings doc is the whole record).
 *   - GRADUATE — promote the exploration into a #947-consumable plan file
 *                (Status/Objective/In scope/Explicit non-goals) built from the
 *                spike's Question/Approach/Findings/Recommendation, which then
 *                enters the existing local-first plan→PR promotion path (#952).
 *
 * Pure: no fs/network/gh, no `scripts/` import (mirrors spike-intake-contract
 * and plan-file-promote-contract). The CLI (`scripts/refine/exit-spike.mjs`)
 * owns all I/O. Fail-closed on an unknown disposition or a non-ready state so
 * the CLI makes zero mutation on those paths.
 */

import { SPIKE_INTAKE_STATE } from "./spike-intake-contract.mjs";

/** Dispositions the operator can choose at a ready spike's exit. */
export const SPIKE_EXIT_DISPOSITION = Object.freeze({
  /** Drop the spike with no tracker artifact (recommendation: don't pursue). */
  DISCARD: "discard",
  /** Promote into a plan file consumable by the #947 local-first flow. */
  GRADUATE: "graduate",
});

/** Actions the exit decision can return (1:1 with the eligible dispositions). */
export const SPIKE_EXIT_ACTION = Object.freeze({
  DISCARD: "discard",
  GRADUATE: "graduate",
});

const DISPOSITION_TO_ACTION = Object.freeze({
  [SPIKE_EXIT_DISPOSITION.DISCARD]: SPIKE_EXIT_ACTION.DISCARD,
  [SPIKE_EXIT_DISPOSITION.GRADUATE]: SPIKE_EXIT_ACTION.GRADUATE,
});

/**
 * Pure exit-eligibility decision.
 *
 * Eligible ONLY from `spike_ready_for_exit` (a Recommendation has been reached).
 * Any other state — in-progress or ambiguous — fails closed with
 * `not_ready_for_exit` and no action; the CLI must make zero tracker mutation.
 * An unrecognized disposition fails closed with `unknown_disposition`.
 *
 * @param {object} facts
 * @param {string} facts.spikeIntakeState  one of SPIKE_INTAKE_STATE values (from evaluateSpikeIntakeState)
 * @param {string} facts.disposition  one of SPIKE_EXIT_DISPOSITION values
 * @returns {{ ok: boolean, action?: string, reason?: string, spikeIntakeState?: string }}
 */
export function evaluateSpikeExit({ spikeIntakeState, disposition } = {}) {
  // The ready gate: an exit decision is only meaningful once a recommendation
  // exists. Fail closed otherwise — never guess an exit for an in-progress or
  // malformed spike.
  if (spikeIntakeState !== SPIKE_INTAKE_STATE.SPIKE_READY_FOR_EXIT) {
    return { ok: false, reason: "not_ready_for_exit", spikeIntakeState: spikeIntakeState ?? null };
  }

  // Own-property check: a bare index lookup would also match inherited
  // Object.prototype keys (`toString`, `__proto__`, `constructor`), letting an
  // unknown disposition resolve to a truthy value and bypass the fail-closed
  // contract. Require a string that is an own key of the map.
  if (typeof disposition !== "string" || !Object.hasOwn(DISPOSITION_TO_ACTION, disposition)) {
    return { ok: false, reason: "unknown_disposition", spikeIntakeState };
  }
  const action = DISPOSITION_TO_ACTION[disposition];

  return { ok: true, action, spikeIntakeState };
}

/**
 * Build a #947-consumable plan-file body from a ready spike's sections.
 *
 * The emitted body carries the four base authoring sections the plan-file
 * format requires (Status / Objective / In scope / Explicit non-goals — see
 * scripts/refine/validate-plan-file.mjs), so it passes `validatePlanFile` and
 * enters the existing local-first plan→PR promotion path (#952) unchanged.
 *
 * The spike sections map onto the plan as: the Question + Approach become the
 * Objective's context, the Recommendation becomes the In-scope work, the
 * Findings record the evidence, and a fixed non-goal keeps the plan from
 * re-opening the (now-concluded) exploration. Status starts as Draft.
 *
 * Idempotent and pure: same input → identical output, no side effects. Fails
 * closed (throws) on an empty required section so a graduate exit cannot emit a
 * plan that the validator would reject.
 *
 * @param {object} sections
 * @param {string} sections.question
 * @param {string} sections.approach
 * @param {string} sections.findings
 * @param {string} sections.recommendation
 * @returns {string} markdown plan-file body
 */
export function buildGraduatedPlanBody({ question, approach, findings, recommendation } = {}) {
  const q = String(question ?? "").trim();
  const a = String(approach ?? "").trim();
  const f = String(findings ?? "").trim();
  const r = String(recommendation ?? "").trim();
  if (q.length === 0) throw new Error("buildGraduatedPlanBody requires a non-empty question");
  if (a.length === 0) throw new Error("buildGraduatedPlanBody requires a non-empty approach");
  if (f.length === 0) throw new Error("buildGraduatedPlanBody requires non-empty findings");
  if (r.length === 0) throw new Error("buildGraduatedPlanBody requires a non-empty recommendation");

  return [
    "# Graduated spike plan",
    "",
    "## Status",
    "",
    "Draft (graduated from a spike). Needs refinement before promotion.",
    "",
    "## Objective",
    "",
    `Act on the spike's recommendation. The spike asked: ${q}`,
    "",
    "Approach explored:",
    "",
    a,
    "",
    "## In scope",
    "",
    r,
    "",
    "Supporting findings from the spike:",
    "",
    f,
    "",
    "## Explicit non-goals",
    "",
    "- Re-running the spike's exploration; that question is concluded.",
    "- Work beyond the recommendation above.",
    "",
  ].join("\n");
}
