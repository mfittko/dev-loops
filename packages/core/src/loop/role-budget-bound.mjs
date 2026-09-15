/**
 * role-budget-bound.mjs — dev-loop execution-cap bounded role-budget
 * primitive. Mirrors ./reviewer-unit-bound.mjs's style: a bounded,
 * deterministic primitive that caps a judge-round, fixer-pass, or
 * coordinator-phase role unit at a fixed per-role execution budget and
 * always produces a durable blocked record — never a silent pass — when the
 * unit runs over budget.
 *
 * Consolidated from the execution-cap epic's deferred per-role budgets.
 * Coordinator phase: 40 model turns / 50 tool calls / 20,000 output tokens.
 *
 * Pure and offline: no runtime/harness adapter import, no file reads, no
 * network, no state held across calls. This primitive is a post-hoc verdict
 * over a `consumed` snapshot — it does not sequence or time the caller's
 * before/after measurement; that stays the caller's concern.
 */

/**
 * Dev-loop harnesses this bound recognizes. Re-declared locally (not
 * imported from child-launch-bound.mjs) so this primitive stays free of any
 * cross-module coupling; it does not branch on harness, it only carries the
 * label through caller-supplied gateContext.
 */
export const HARNESS_VALUES = Object.freeze(["pi", "claude", "codex"]);

/** The three roles this primitive caps. */
export const ROLE_VALUES = Object.freeze(["judge_round", "fixer_pass", "coordinator_phase"]);

/**
 * The fixed per-role execution budgets. Judge-round: 12 model turns / 15
 * tool calls / 100k input tokens / 10k output tokens. Fixer-pass: 45 model
 * turns / 50 tool calls / at most 1 push per gate round. Coordinator-phase:
 * 40 model turns / 50 tool calls / 20,000 output tokens.
 */
export const ROLE_BUDGETS = Object.freeze({
  judge_round: Object.freeze({
    maxModelTurns: 12,
    maxToolCalls: 15,
    maxInputTokens: 100000,
    maxOutputTokens: 10000,
  }),
  fixer_pass: Object.freeze({
    maxModelTurns: 45,
    maxToolCalls: 50,
    maxPushesPerGateRound: 1,
  }),
  coordinator_phase: Object.freeze({
    maxModelTurns: 40,
    maxToolCalls: 50,
    maxOutputTokens: 20000,
  }),
});

/**
 * Maps each role's required `consumed` dimension name to the matching
 * ROLE_BUDGETS max-field name. A consumed dimension belonging to the OTHER
 * role is simply never read here — this map is the sole source of which
 * dimensions a given role's consumed object must carry.
 */
const ROLE_DIMENSION_BUDGET_KEYS = Object.freeze({
  judge_round: Object.freeze({
    modelTurns: "maxModelTurns",
    toolCalls: "maxToolCalls",
    inputTokens: "maxInputTokens",
    outputTokens: "maxOutputTokens",
  }),
  fixer_pass: Object.freeze({
    modelTurns: "maxModelTurns",
    toolCalls: "maxToolCalls",
    pushesThisGateRound: "maxPushesPerGateRound",
  }),
  coordinator_phase: Object.freeze({
    modelTurns: "maxModelTurns",
    toolCalls: "maxToolCalls",
    outputTokens: "maxOutputTokens",
  }),
});

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
 * Validate + normalize a role unit at the trust boundary. Fails closed
 * (TypeError naming the violation) on any malformed field.
 * @param {{role:string, run:string, gateContext:object}} unit
 * @returns {{role:string, run:string, gateContext:object}} frozen, normalized.
 */
export function validateRoleUnit(unit) {
  if (!unit || typeof unit !== "object") {
    throw new TypeError("validateRoleUnit requires a unit object");
  }
  const { role, run, gateContext } = unit;
  if (!ROLE_VALUES.includes(role)) {
    throw new TypeError(`unit.role must be one of ${ROLE_VALUES.join(", ")}, got ${JSON.stringify(role)}`);
  }
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
  // recognized dev-loop harness — mirrors reviewer-unit-bound.mjs's own
  // harness enforcement instead of silently carrying an unrecognized label.
  if (gateContext.harness != null && !HARNESS_VALUES.includes(gateContext.harness)) {
    throw new TypeError(`unit.gateContext.harness must be one of ${HARNESS_VALUES.join(", ")}, got ${JSON.stringify(gateContext.harness)}`);
  }

  // Freeze the gate context so the role unit cannot mutate the current-head
  // identity it was handed; freeze the returned unit for the same reason.
  // The freeze is deep — a shallow freeze would leave a nested gateContext
  // value (e.g. provenance) mutable. Deep-CLONE before freezing: a shallow
  // `{ ...gateContext }` spread shares nested objects with the caller, so
  // deepFreeze would freeze the CALLER's own objects in place — an
  // observable side effect on this otherwise-pure validator. A gate context
  // is plain data; if it is not structured-cloneable that is a malformed
  // non-data context, and throwing a TypeError here (not letting
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
    role,
    run: run.trim(),
    gateContext: deepFreeze(clonedGateContext),
  });
}

/** @param {unknown} value @returns {boolean} */
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate `consumed` against exactly the dimensions the given role
 * requires — a dimension belonging to the OTHER role, if present, is never
 * read (it is silently ignored, not accepted as satisfying this role's own
 * requirement).
 * @param {"judge_round"|"fixer_pass"|"coordinator_phase"} role
 * @param {object} consumed
 * @returns {object} normalized consumed, containing only this role's dimensions.
 */
function validateConsumedForRole(role, consumed) {
  const dimensionBudgetKeys = ROLE_DIMENSION_BUDGET_KEYS[role];
  if (!consumed || typeof consumed !== "object") {
    throw new TypeError(`enforceRoleBudget requires consumed to be an object with ${Object.keys(dimensionBudgetKeys).join(", ")}`);
  }
  const normalized = {};
  for (const dimension of Object.keys(dimensionBudgetKeys)) {
    const value = consumed[dimension];
    // Each dimension is a discrete counter — a fractional value (e.g. 44.5)
    // is never a genuine count and must fail closed, not round/truncate.
    if (!isNonNegativeInteger(value)) {
      throw new TypeError(`consumed.${dimension} must be a non-negative integer`);
    }
    normalized[dimension] = value;
  }
  return normalized;
}

/**
 * Enforce the fixed per-role execution budget. Validates the unit, selects
 * the budget by `unit.role`, validates `consumed` against exactly that
 * role's dimensions, and blocks (fail-closed, durable — never a silent
 * pass) when any dimension exceeds its budget max.
 *
 * @param {object} options
 * @param {{role:"judge_round"|"fixer_pass"|"coordinator_phase", run:string, gateContext:object}} options.unit
 * @param {object} options.consumed
 * @returns {object} `{ ok: true, role, unit, consumed, budget }` on success,
 *   or the durable blocker `{ ok: false, verdict: "blocked", reason,
 *   exceededDimensions, headSha, role, unit, consumed, budget }` on failure.
 */
export function enforceRoleBudget({ unit, consumed } = {}) {
  const normalizedUnit = validateRoleUnit(unit);
  const { role } = normalizedUnit;
  const budget = ROLE_BUDGETS[role];
  const dimensionBudgetKeys = ROLE_DIMENSION_BUDGET_KEYS[role];
  const normalizedConsumed = validateConsumedForRole(role, consumed);

  const exceededDimensions = Object.keys(dimensionBudgetKeys).filter(
    (dimension) => normalizedConsumed[dimension] > budget[dimensionBudgetKeys[dimension]],
  );

  if (exceededDimensions.length > 0) {
    // Fail-closed: never a silent pass on exhaustion — the durable blocked
    // record names every exceeded dimension, not just the first found.
    return {
      ok: false,
      verdict: "blocked",
      reason: `${role}_budget_exhausted`,
      exceededDimensions,
      headSha: normalizedUnit.gateContext.headSha,
      role,
      unit: normalizedUnit,
      consumed: normalizedConsumed,
      budget,
    };
  }

  return { ok: true, role, unit: normalizedUnit, consumed: normalizedConsumed, budget };
}
