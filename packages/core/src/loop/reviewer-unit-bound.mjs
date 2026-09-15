/**
 * reviewer-unit-bound.mjs — dev-loop execution-cap bounded scoped-reviewer
 * dispatch unit. Mirrors
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
 *
 * Exported as a frozen ARRAY, not a Set: `Object.freeze(new Set(...))`
 * freezes only the Set's own properties, not its contents — `.add`/
 * `.delete`/`.clear` still work on a frozen Set and the mutation persists on
 * this module-singleton export. A frozen array has no such escape hatch.
 */
export const PROHIBITED_REVIEWER_OPERATIONS = Object.freeze([
  "poll_pr_state",
  "poll_ci_state",
  "poll_copilot_state",
  "network_status_probe",
  "rerun_validation",
  "inspect_orchestration_runtime",
  "review_unassigned_angle",
]);

/** Private O(1)-membership mirror of PROHIBITED_REVIEWER_OPERATIONS. */
const PROHIBITED_REVIEWER_OPERATIONS_SET = new Set(PROHIBITED_REVIEWER_OPERATIONS);

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Recursively freeze a plain object/array value's own nested plain
 * objects/arrays. A shallow Object.freeze leaves nested values mutable;
 * the gate context must be genuinely immutable, not just its top level.
 *
 * Recurses into children even when the current container is already frozen
 * (an already-frozen container can still hold mutable grandchildren — an
 * early return on Object.isFrozen would skip them). A WeakSet cycle guard
 * prevents infinite recursion on a cyclic object graph.
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown} the same value, deep-frozen.
 */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
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
  // harness is optional (absent is allowed), but when present it must be a
  // recognized dev-loop harness — mirrors child-launch-bound.mjs's own
  // harness enforcement instead of silently carrying an unrecognized label.
  if (gateContext.harness != null && !HARNESS_VALUES.includes(gateContext.harness)) {
    throw new TypeError(`unit.gateContext.harness must be one of ${HARNESS_VALUES.join(", ")}, got ${JSON.stringify(gateContext.harness)}`);
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
  // reason. The freeze is deep — a shallow freeze would leave a nested
  // gateContext value (e.g. provenance) mutable. Deep-CLONE before freezing:
  // a shallow `{ ...gateContext }` spread shares nested objects with the
  // caller, so deepFreeze would freeze the CALLER's own objects in place —
  // an observable side effect on this otherwise-pure validator. A gate
  // context is plain data; if it is not structured-cloneable that is a
  // malformed non-data context, and throwing a TypeError here (not letting
  // structuredClone's own DataCloneError escape) keeps the fail-closed
  // posture consistent with every other malformed-input branch in this
  // module.
  let clonedGateContext;
  try {
    clonedGateContext = structuredClone(gateContext);
  } catch {
    throw new TypeError("unit.gateContext must be structured-cloneable (plain data, no functions/symbols/etc.)");
  }
  // structuredClone (like object spread) copies only own-enumerable
  // properties, so an inherited/non-enumerable headSha would validate above
  // yet be absent from the clone. Re-assert the validated value explicitly
  // so the frozen context always carries it.
  clonedGateContext.headSha = gateContext.headSha;

  return Object.freeze({
    run: run.trim(),
    gateContext: deepFreeze(clonedGateContext),
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

  if (PROHIBITED_REVIEWER_OPERATIONS_SET.has(kind)) {
    throw new Error(`reviewer operation prohibited: ${kind}`);
  }

  if (kind === "review_angle") {
    const angle = operation.angle;
    // A non-string assignedAngles entry (e.g. a bare number) must never
    // coerce into a matching authorization — skip it instead of
    // String()-coercing, so it can never default-deny-bypass an angle.
    const assignedLower = new Set(
      assignedAngles.filter((a) => isNonEmptyString(a)).map((a) => a.trim().toLowerCase()),
    );
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
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
  // modelTurns/toolCalls are discrete counters — a fractional value (e.g.
  // 44.5) is never a genuine count and must fail closed, not round/truncate.
  if (!isNonNegativeInteger(modelTurns)) {
    throw new TypeError("consumed.modelTurns must be a non-negative integer");
  }
  if (!isNonNegativeInteger(toolCalls)) {
    throw new TypeError("consumed.toolCalls must be a non-negative integer");
  }
  return { modelTurns, toolCalls };
}

/**
 * @param {Iterable<string>|null|undefined} completedAngles
 * @returns {Set<string>} lower-cased, trimmed angle names.
 */
function normalizeCompletedAngles(completedAngles) {
  if (completedAngles == null) return new Set();
  if (typeof completedAngles === "string") {
    // A bare string is iterable (per-character) but must never be accepted
    // as a set of completed angles — fail closed instead of silently
    // iterating characters.
    throw new TypeError("enforceReviewerUnitBound requires completedAngles to be an iterable of angle names, not a bare string");
  }
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

  /** @param {string} reason @param {string[]} angles @returns {object} the durable blocker. */
  const blockedResult = (reason, angles) => ({
    ok: false,
    verdict: "blocked",
    reason,
    unreviewedAngles: angles,
    headSha: normalizedUnit.gateContext.headSha,
    unit: normalizedUnit,
    consumed: normalizedConsumed,
    budget: REVIEWER_UNIT_BUDGET,
  });

  const budgetExceeded = normalizedConsumed.modelTurns > REVIEWER_UNIT_BUDGET.maxModelTurns
    || normalizedConsumed.toolCalls > REVIEWER_UNIT_BUDGET.maxToolCalls;

  if (budgetExceeded) {
    // Fail-closed revoke: even a nominally "complete" run cannot be reported
    // clean once it ran over budget, so the verdict is always "blocked" —
    // never a silent pass — regardless of angle coverage. unreviewedAngles
    // still names the genuinely-remaining angles (not the full assigned
    // set): the "never reported clean" guarantee comes from the blocked
    // verdict itself, not from inflating this list.
    return blockedResult("reviewer_budget_exhausted", unreviewedAngles);
  }

  if (unreviewedAngles.length > 0) {
    return blockedResult("reviewer_coverage_incomplete", unreviewedAngles);
  }

  return {
    ok: true,
    unit: normalizedUnit,
    consumed: normalizedConsumed,
    reviewedAngles: [...assignedAngles],
  };
}
