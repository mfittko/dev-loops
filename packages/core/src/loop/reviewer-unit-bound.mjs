/**
 * reviewer-unit-bound.mjs — dev-loop execution-cap bounded scoped-reviewer
 * dispatch unit (epic #2153 slice 2/4). Mirrors
 * ./child-launch-bound.mjs's style: a bounded, deterministic primitive that
 * caps a reviewer unit at a small assigned-angle set, denies every operation
 * outside a narrow allow-list by default, and always produces a durable
 * blocker record — never a silent pass — when the unit runs over budget or
 * leaves an assigned angle unreviewed.
 *
 * Pure and offline: no runtime/harness adapter import, no file reads, no
 * network, no state held across calls.
 */

/**
 * Dev-loop harnesses this bound recognizes. Re-declared locally (not
 * imported from child-launch-bound.mjs) so this primitive stays free of any
 * cross-module coupling; it does not branch on harness, it only carries the
 * label through caller-supplied gateContext.
 */
export const HARNESS_VALUES = Object.freeze(["pi", "claude", "codex"]);

/** A reviewer unit is bounded to at most this many assigned angles. */
export const REVIEWER_UNIT_MAX_ANGLES = 3;

/** The fixed execution budget for one scoped-reviewer dispatch unit. */
export const REVIEWER_UNIT_BUDGET = Object.freeze({
  maxModelTurns: 45,
  maxToolCalls: 50,
  maxAngles: REVIEWER_UNIT_MAX_ANGLES,
});

/**
 * Operation kinds a reviewer unit is never allowed to perform, verbatim from
 * the issue AC enumeration. Default-deny governs everything else that is not
 * explicitly on the allow-list in assertReviewerOperationAllowed.
 */
export const PROHIBITED_REVIEWER_OPERATIONS = Object.freeze(
  new Set([
    "poll_pr_state",
    "poll_ci_state",
    "poll_copilot_state",
    "network_status_probe",
    "rerun_validation",
    "inspect_orchestration_runtime",
    "review_unassigned_angle",
  ]),
);

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate + normalize a reviewer unit at the trust boundary. Fails closed
 * (TypeError naming the violation) on any malformed field.
 * @param {{run:string, gateContext:object, angles:string[]}} unit
 * @returns {{run:string, gateContext:object, angles:string[]}} frozen, normalized.
 */
export function validateReviewerUnit(unit) {
  if (!unit || typeof unit !== "object") {
    throw new TypeError("validateReviewerUnit requires a unit object");
  }
  const { run, gateContext, angles } = unit;
  if (!isNonEmptyString(run)) {
    throw new TypeError("unit.run must be a non-empty string");
  }
  if (!gateContext || typeof gateContext !== "object") {
    throw new TypeError("unit.gateContext must be a non-null object");
  }
  if (!isNonEmptyString(gateContext.headSha)) {
    throw new TypeError("unit.gateContext.headSha must be a non-empty string");
  }
  if (!Array.isArray(angles) || angles.length === 0) {
    throw new TypeError("unit.angles must be a non-empty array of angle names");
  }
  if (angles.length > REVIEWER_UNIT_MAX_ANGLES) {
    throw new TypeError(`unit.angles must not exceed ${REVIEWER_UNIT_MAX_ANGLES} angles, got ${angles.length}`);
  }

  const normalizedAngles = [];
  const seen = new Set();
  for (const angle of angles) {
    if (!isNonEmptyString(angle)) {
      throw new TypeError("unit.angles must contain only non-empty strings");
    }
    const trimmed = angle.trim();
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) {
      throw new TypeError(`unit.angles must not contain duplicate angle (case-insensitive): ${trimmed}`);
    }
    seen.add(lower);
    normalizedAngles.push(trimmed);
  }

  // Freeze the gate context so the reviewer cannot mutate the current-head
  // identity it was handed; freeze the returned unit + angles for the same
  // reason.
  return Object.freeze({
    run: run.trim(),
    gateContext: Object.freeze({ ...gateContext }),
    angles: Object.freeze(normalizedAngles),
  });
}

/**
 * Pure default-deny guard for one reviewer operation. Only inspect_diff,
 * inspect_adjacent_code, and review_angle (for an assigned angle) pass.
 * @param {{kind:string, angle?:string}} operation
 * @param {{assignedAngles?: string[]}} [options]
 * @returns {object} the operation, unchanged, when allowed.
 */
export function assertReviewerOperationAllowed(operation, { assignedAngles = [] } = {}) {
  if (!operation || typeof operation !== "object" || !isNonEmptyString(operation.kind)) {
    // Malformed op fails closed — never silently allowed.
    throw new TypeError("assertReviewerOperationAllowed requires operation.kind to be a non-empty string");
  }
  const { kind } = operation;

  if (PROHIBITED_REVIEWER_OPERATIONS.has(kind)) {
    throw new Error(`reviewer operation prohibited: ${kind}`);
  }

  if (kind === "review_angle") {
    const angle = operation.angle;
    const assignedLower = new Set(assignedAngles.map((a) => String(a).trim().toLowerCase()));
    if (!isNonEmptyString(angle) || !assignedLower.has(angle.trim().toLowerCase())) {
      throw new Error(`review_unassigned_angle: ${JSON.stringify(angle ?? null)} is not assigned to this reviewer unit`);
    }
    return operation;
  }

  if (kind === "inspect_diff" || kind === "inspect_adjacent_code") {
    return operation;
  }

  // Neither explicitly allowed nor explicitly prohibited: default-deny.
  throw new Error(`unknown_reviewer_operation: ${kind}`);
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * @param {{modelTurns:unknown, toolCalls:unknown}} consumed
 * @returns {{modelTurns:number, toolCalls:number}}
 */
function validateConsumed(consumed) {
  if (!consumed || typeof consumed !== "object") {
    throw new TypeError("enforceReviewerUnitBound requires consumed to be an object with modelTurns and toolCalls");
  }
  const { modelTurns, toolCalls } = consumed;
  if (!isFiniteNonNegative(modelTurns)) {
    throw new TypeError("consumed.modelTurns must be a finite number >= 0");
  }
  if (!isFiniteNonNegative(toolCalls)) {
    throw new TypeError("consumed.toolCalls must be a finite number >= 0");
  }
  return { modelTurns, toolCalls };
}

/**
 * @param {Iterable<string>|null|undefined} completedAngles
 * @returns {Set<string>} lower-cased, trimmed angle names.
 */
function normalizeCompletedAngles(completedAngles) {
  if (completedAngles == null) return new Set();
  if (typeof completedAngles[Symbol.iterator] !== "function") {
    throw new TypeError("enforceReviewerUnitBound requires completedAngles to be an iterable of angle names");
  }
  const completed = new Set();
  for (const angle of completedAngles) {
    if (isNonEmptyString(angle)) completed.add(angle.trim().toLowerCase());
  }
  return completed;
}

/**
 * Enforce the bounded scoped-reviewer-unit protocol. Validates the unit,
 * measures consumption against the fixed REVIEWER_UNIT_BUDGET, and computes
 * angle coverage. Two independent fail-closed REVOKE conditions can block
 * the unit; budget exhaustion always wins over "completion" — an over-budget
 * run's reported completion is untrustworthy and can never be clean.
 *
 * @param {object} options
 * @param {{run:string, gateContext:object, angles:string[]}} options.unit
 * @param {{modelTurns:number, toolCalls:number}} options.consumed
 * @param {Iterable<string>} [options.completedAngles]
 * @returns {object} `{ ok: true, unit, consumed, reviewedAngles }` on
 *   success, or the durable blocker `{ ok: false, verdict: "blocked",
 *   reason, unreviewedAngles, headSha, unit, consumed, budget }` on failure.
 */
export function enforceReviewerUnitBound({ unit, consumed, completedAngles } = {}) {
  const normalizedUnit = validateReviewerUnit(unit);
  const normalizedConsumed = validateConsumed(consumed);
  const completedSet = normalizeCompletedAngles(completedAngles);

  const assignedAngles = normalizedUnit.angles;
  const unreviewedAngles = assignedAngles.filter((angle) => !completedSet.has(angle.toLowerCase()));

  const budgetExceeded = normalizedConsumed.modelTurns > REVIEWER_UNIT_BUDGET.maxModelTurns
    || normalizedConsumed.toolCalls > REVIEWER_UNIT_BUDGET.maxToolCalls;

  if (budgetExceeded) {
    // Fail-closed revoke: even a nominally "complete" run cannot be reported
    // clean once it ran over budget — nothing under exhaustion is
    // trustworthily reviewed.
    return {
      ok: false,
      verdict: "blocked",
      reason: "reviewer_budget_exhausted",
      unreviewedAngles: [...assignedAngles],
      headSha: normalizedUnit.gateContext.headSha,
      unit: normalizedUnit,
      consumed: normalizedConsumed,
      budget: REVIEWER_UNIT_BUDGET,
    };
  }

  if (unreviewedAngles.length > 0) {
    return {
      ok: false,
      verdict: "blocked",
      reason: "reviewer_coverage_incomplete",
      unreviewedAngles,
      headSha: normalizedUnit.gateContext.headSha,
      unit: normalizedUnit,
      consumed: normalizedConsumed,
      budget: REVIEWER_UNIT_BUDGET,
    };
  }

  return {
    ok: true,
    unit: normalizedUnit,
    consumed: normalizedConsumed,
    reviewedAngles: [...assignedAngles],
  };
}
