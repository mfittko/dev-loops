/**
 * review-operation
 *
 * The ONE operation-scoped authority for the legal dispatchable-angle pool and
 * the reviewer role it authorizes. Dispatch/planning and defensive
 * reviewer-role validation both consume this module instead of
 * reconstructing membership/eligibility rules of their own — a duplicated,
 * partial eligibility implementation (fallback roles, missing prompts,
 * config errors, additive pools, disabled angles, gate-specific membership,
 * standalone-review membership, and spike membership resolved independently
 * in more than one place) is exactly what this single authority replaces.
 *
 * `resolveOperationAnglePool` owns only the legal CANDIDATE catalog for an
 * operation. Diff-/tier-/PR-fact-driven SELECTION from that catalog (which
 * angles actually run this round) and any later spec-of-record pruning stay
 * downstream dispatch/planning concerns (see write-gate-context.mjs's
 * `resolveReviewGateAngles`, which imports this module for its union instead
 * of recomputing it).
 *
 * `resolveOperationReviewerRole` is the ONE authoritative exit-code boundary a
 * reviewer role source — a CLI, dispatch/planning, or defensive validation —
 * must consume: `ok` is fail-closed true only when the merged config loaded
 * with no errors AND the requested angle is a legal member of the named
 * operation's pool. `status` is a DIAGNOSTIC field only (never a second
 * reviewer decision surface); see skills/docs/gate-review-comment-contract.md
 * and skills/docs/gate-review-sub-loop-contract.md.
 */
import { resolveGateAngleContract, resolveGateAngles, resolveReviewerRole, resolveRoleModel } from "../config/config.mjs";
import { GATE_CONFIG_KEY } from "./gate-fanin.mjs";

/** The closed review-operation vocabulary. Standalone `review` is only ever selected by name, never inferred. */
export const REVIEW_OPERATIONS = Object.freeze(["draft_gate", "pre_approval_gate", "review", "spike"]);

// GATE_CONFIG_KEY (gate-fanin.mjs) has no `spike` entry — other code relies on
// its absence of review/spike — so this operation-scoped table adds it locally
// instead of widening the shared one.
const OPERATION_GATE_KEY = Object.freeze({ ...GATE_CONFIG_KEY, spike: "spike" });

/**
 * Resolve the legal candidate angle pool for a review operation from the
 * fully merged config:
 *   - draft_gate / pre_approval_gate / spike: the effective `gates.<key>`
 *     pool (`resolveGateAngleContract(config, key).pool` — mandatory/static/
 *     additive rules applied, disabled/excluded angles removed).
 *   - review: the de-duplicated, order-stable union of the static draft and
 *     pre-approval angle sets (`resolveGateAngles`, NOT the additive/tier
 *     pool) — standalone review's existing dedicated semantics; it gains no
 *     diff-tier or additive selection here.
 * An unrecognized operation throws (arg-identity error, not a config-layer
 * concern; callers validate `--gate` before ever reaching config load).
 * @param {import("../config/config.mjs").DevLoopConfig} config
 * @param {"draft_gate"|"pre_approval_gate"|"review"|"spike"} operation
 * @returns {string[]}
 */
export function resolveOperationAnglePool(config, operation) {
  if (!REVIEW_OPERATIONS.includes(operation)) {
    throw new Error(`Unknown review operation: ${JSON.stringify(operation)} (expected one of ${REVIEW_OPERATIONS.join(", ")})`);
  }
  if (operation === "review") {
    return [...new Set([
      ...(resolveGateAngles(config, "draft") ?? []),
      ...(resolveGateAngles(config, "preApproval") ?? []),
    ])];
  }
  return resolveGateAngleContract(config, OPERATION_GATE_KEY[operation]).pool ?? [];
}

/**
 * @typedef {object} OperationReviewerRoleResult
 * @property {boolean} ok - Fail-closed reviewer safety boundary: `configErrors.length === 0 && pool.includes(angle)`.
 * @property {"draft_gate"|"pre_approval_gate"|"review"|"spike"} operation
 * @property {string} angle
 * @property {"claude"|"pi"} harness
 * @property {string} persona
 * @property {string|null} prompt
 * @property {string|null} model - Authoritative merged model tier (`resolveRoleModel(..., { kind: "angle" })`).
 * @property {boolean} fallback
 * @property {"config-error"|"non-member"|"fallback"|"prompt-missing"|"resolved"} status - Diagnostic only; never a reviewer decision branch.
 * @property {string[]} warnings
 * @property {Array<unknown>} configErrors
 */

/**
 * Resolve one angle's reviewer role for a review operation, authorized
 * against `resolveOperationAnglePool`. This is the shared authority a CLI
 * (`gate resolve-role`), dispatch/planning, or defensive validation all call —
 * none of them may reimplement membership/union/additive/disabled/spike
 * classification locally.
 * @param {{ config: import("../config/config.mjs").DevLoopConfig, errors?: Array<unknown> }} loadResult - the `{ config, errors }` shape `loadDevLoopConfig` returns.
 * @param {{ operation: "draft_gate"|"pre_approval_gate"|"review"|"spike", angle: string, harness: "claude"|"pi" }} params
 * @returns {OperationReviewerRoleResult}
 */
export function resolveOperationReviewerRole(loadResult, { operation, angle, harness }) {
  const config = loadResult?.config;
  const configErrors = Array.isArray(loadResult?.errors) ? loadResult.errors : [];
  const configErrorPresent = configErrors.length > 0;
  // An unrecognized operation is a closed-vocabulary argument failure, not a
  // config-layer concern; it must throw unconditionally, even when a config
  // error is also on record — never degraded to a misleading config-error
  // result below. Validate before the try so this throw is never swallowed.
  if (!REVIEW_OPERATIONS.includes(operation)) {
    throw new Error(`Unknown review operation: ${JSON.stringify(operation)} (expected one of ${REVIEW_OPERATIONS.join(", ")})`);
  }
  let pool;
  try {
    pool = resolveOperationAnglePool(config, operation);
  } catch (error) {
    // A config that already failed merged schema validation (non-empty
    // `errors` from loadDevLoopConfig) can still reach here with a gate shape
    // resolveGateConfig itself rejects (e.g. an invalid
    // `gates.<gate>.blockCleanOnFindingSeverities`). That is a config-layer
    // failure the caller's own config-error fail-closed status already
    // covers, so degrade to an empty pool instead of an unhandled exception
    // reaching the reviewer boundary. With no config error on record, this is
    // a real schema-invalid gate shape a caller must see: rethrow.
    if (!configErrorPresent) throw error;
    pool = [];
  }
  const member = pool.includes(angle);
  const ok = !configErrorPresent && member;

  const role = resolveReviewerRole(config, angle);
  const model = resolveRoleModel(config, { role: angle, harness, kind: "angle" });

  const warnings = [];
  let status;
  if (configErrorPresent) {
    status = "config-error";
    warnings.push(
      `${configErrors.length} config-layer error(s); the resolved role may be a shipped default and must not be trusted.`,
    );
  } else if (!member) {
    status = "non-member";
    warnings.push(`angle '${angle}' is not a member of the '${operation}' operation's legal candidate pool.`);
  } else if (role.fallback) {
    status = "fallback";
    warnings.push(
      `angle '${angle}' is authorized for '${operation}' but has no dedicated persona/prompt entry; the default-reviewer persona is returned.`,
    );
  } else if (typeof role.prompt !== "string" || role.prompt.trim() === "") {
    status = "prompt-missing";
    warnings.push(
      `angle '${angle}' resolved persona '${role.persona}' but its focus prompt is null/empty; review with no angle-specific focus instruction.`,
    );
  } else {
    status = "resolved";
  }

  return {
    ok,
    operation,
    angle,
    harness,
    persona: role.persona,
    prompt: role.prompt,
    model,
    fallback: role.fallback,
    status,
    warnings,
    configErrors,
  };
}
