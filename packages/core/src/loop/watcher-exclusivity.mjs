/**
 * watcher-exclusivity.mjs — dev-loop execution-cap watcher-exclusivity
 * resolver. Mirrors ./reviewer-unit-bound.mjs and ./role-budget-bound.mjs's
 * style: a bounded, deterministic primitive that resolves the current
 * watch-owner verdict for a (target, head, wait-kind) boundary from
 * caller-supplied lease/transition evidence, and always fails closed
 * (blocked, never a silent pass) on any owner mismatch, stale lease, or
 * malformed transition.
 *
 * The whole point of this primitive: the coordinator never becomes a SECOND
 * observer of an in-flight external wait (Copilot review, CI, workflow run).
 * `secondObserverAuthorized` is `false` in every branch of
 * `resolveWatchOwnership` — there is no verdict shape that authorizes the
 * caller to start its own competing watch/probe loop. The owner and
 * transition evidence each carry a `target` field, compared against
 * `boundary.target` alongside `head` and `waitKind`, so the resolver
 * genuinely keys on the full (target, head, wait-kind) triple instead of
 * accepting evidence for a different target.
 *
 * This resolver is caller-AGNOSTIC: it reports the single-owner verdict over
 * SUPPLIED evidence and does not authenticate the calling runner. It cannot
 * tell whether the process invoking it IS the recorded lease owner — that
 * caller-identity check (verifying the calling runner matches
 * `evidence.owner`, and gating the wait before it starts) is the consumer's
 * responsibility and is deferred to the slice-b live wiring.
 *
 * Pure and offline: no runtime/harness adapter import, no file reads, no
 * network, no state held across calls. This primitive is a post-hoc verdict
 * over caller-supplied `evidence` — it does not read or write any lease
 * file itself; that stays the caller's concern (the existing
 * runner-coordination lease read/write path).
 */

import { EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY } from "./timeout-policy.mjs";

/** Wait kinds this primitive recognizes. */
export const WATCH_KINDS = Object.freeze(["copilot_review", "ci", "workflow_run"]);

/**
 * Coordinator operation kinds that are always prohibited under watcher
 * exclusivity: every one of these would make the coordinator a second
 * observer of an in-flight external wait instead of the sole lease owner.
 *
 * Exported as a frozen ARRAY, not a Set: `Object.freeze(new Set(...))`
 * freezes only the Set's own properties, not its contents — `.add`/
 * `.delete`/`.clear` still work on a frozen Set and the mutation persists on
 * this module-singleton export. A frozen array has no such escape hatch.
 */
export const PROHIBITED_COORDINATOR_OBSERVER_OPERATIONS = Object.freeze([
  "direct_probe",
  "start_watcher",
  "sleep_retry",
  "second_watch_loop",
]);

const PROHIBITED_COORDINATOR_OBSERVER_OPERATIONS_SET = new Set(PROHIBITED_COORDINATOR_OBSERVER_OPERATIONS);

/** Transition statuses that authorize a phase advance once owner+transition match the boundary. */
const ADVANCING_TRANSITION_STATUSES = new Set(["changed", "completed"]);
/** Transition statuses that keep a matching owner in a healthy wait (never advance). */
const WAITING_TRANSITION_STATUSES = new Set(["timeout", "idle", "pending"]);

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Recursively freeze a plain object/array value's own nested plain
 * objects/arrays. A shallow Object.freeze leaves nested values mutable.
 * Recurses into children even when the current container is already frozen.
 * A WeakSet cycle guard prevents infinite recursion on a cyclic object graph.
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
 * Validate + normalize the trust-boundary identity at the boundary. Fails
 * closed (TypeError naming the violation) on any malformed field.
 * @param {{target:string, head:string, waitKind:string}} boundary
 * @returns {{target:string, head:string, waitKind:string}}
 */
function validateBoundary(boundary) {
  if (!boundary || typeof boundary !== "object") {
    throw new TypeError("resolveWatchOwnership requires boundary to be an object");
  }
  if (!isNonEmptyString(boundary.target)) {
    throw new TypeError("boundary.target must be a non-empty string");
  }
  if (!isNonEmptyString(boundary.head)) {
    throw new TypeError("boundary.head must be a non-empty string");
  }
  if (!WATCH_KINDS.includes(boundary.waitKind)) {
    throw new TypeError(`boundary.waitKind must be one of ${WATCH_KINDS.join(", ")}, got ${JSON.stringify(boundary.waitKind)}`);
  }
  return { target: boundary.target.trim(), head: boundary.head.trim(), waitKind: boundary.waitKind };
}

/**
 * Validate + normalize `evidence.owner`. `null` (no active owner) is valid;
 * a present owner must carry every required field.
 * @param {unknown} owner
 * @returns {{runId:string, target:string, head:string, waitKind:string, updatedAt:string}|null}
 */
function validateOwner(owner) {
  if (owner === null || owner === undefined) return null;
  if (typeof owner !== "object") {
    throw new TypeError("evidence.owner must be null or an object");
  }
  if (!isNonEmptyString(owner.runId)) {
    throw new TypeError("evidence.owner.runId must be a non-empty string");
  }
  if (!isNonEmptyString(owner.target)) {
    throw new TypeError("evidence.owner.target must be a non-empty string");
  }
  if (!isNonEmptyString(owner.head)) {
    throw new TypeError("evidence.owner.head must be a non-empty string");
  }
  if (!WATCH_KINDS.includes(owner.waitKind)) {
    throw new TypeError(`evidence.owner.waitKind must be one of ${WATCH_KINDS.join(", ")}, got ${JSON.stringify(owner.waitKind)}`);
  }
  if (!isNonEmptyString(owner.updatedAt) || Number.isNaN(Date.parse(owner.updatedAt))) {
    throw new TypeError("evidence.owner.updatedAt must be a non-empty, Date.parse-able timestamp string");
  }
  return {
    runId: owner.runId.trim(),
    target: owner.target.trim(),
    head: owner.head.trim(),
    waitKind: owner.waitKind,
    updatedAt: owner.updatedAt.trim(),
  };
}

/**
 * Validate + normalize `evidence.transition`. `null`/absent (no transition
 * observed yet) is valid; a present transition must carry every required
 * field.
 * @param {unknown} transition
 * @returns {{target:string, head:string, waitKind:string, status:string}|null}
 */
function validateTransition(transition) {
  if (transition === null || transition === undefined) return null;
  if (typeof transition !== "object") {
    throw new TypeError("evidence.transition must be null or an object");
  }
  if (!isNonEmptyString(transition.target)) {
    throw new TypeError("evidence.transition.target must be a non-empty string");
  }
  if (!isNonEmptyString(transition.head)) {
    throw new TypeError("evidence.transition.head must be a non-empty string");
  }
  if (!WATCH_KINDS.includes(transition.waitKind)) {
    throw new TypeError(`evidence.transition.waitKind must be one of ${WATCH_KINDS.join(", ")}, got ${JSON.stringify(transition.waitKind)}`);
  }
  if (!isNonEmptyString(transition.status)) {
    throw new TypeError("evidence.transition.status must be a non-empty string");
  }
  return {
    target: transition.target.trim(),
    head: transition.head.trim(),
    waitKind: transition.waitKind,
    status: transition.status.trim(),
  };
}

/** @param {string} a @param {string} b @returns {boolean} case-insensitive, trimmed equality. */
function sameNormalized(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Resolve the current watch-owner verdict for one (target, head, wait-kind)
 * boundary from caller-supplied lease/transition evidence. Validates every
 * input at the trust boundary and fails closed on malformed input
 * (TypeError) or on any owner/transition mismatch (a "blocked" verdict —
 * never a silent pass).
 *
 * `secondObserverAuthorized` is `false` in every returned verdict: there is
 * no shape this function returns that authorizes the caller to start its
 * own competing watch/probe loop.
 *
 * @param {object} options
 * @param {{target:string, head:string, waitKind:"copilot_review"|"ci"|"workflow_run"}} options.boundary
 * @param {{owner: object|null, transition?: object|null}} options.evidence
 * @param {number} options.now non-negative integer ms epoch.
 * @param {number} options.staleAfterMs positive integer.
 * @returns {object} a frozen verdict; see module header for shapes.
 */
export function resolveWatchOwnership({ boundary, evidence, now, staleAfterMs } = {}) {
  const normalizedBoundary = validateBoundary(boundary);
  if (!Number.isInteger(now) || now < 0) {
    throw new TypeError("resolveWatchOwnership requires now to be a non-negative integer");
  }
  if (!Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new TypeError("resolveWatchOwnership requires staleAfterMs to be a positive integer");
  }
  if (!evidence || typeof evidence !== "object") {
    throw new TypeError("resolveWatchOwnership requires evidence to be an object with an owner field");
  }
  const owner = validateOwner(evidence.owner);
  const transition = validateTransition(evidence.transition);

  const blocked = (reason) => deepFreeze({
    ok: false,
    verdict: "blocked",
    reason,
    boundary: normalizedBoundary,
    secondObserverAuthorized: false,
    advancePhaseAuthorized: false,
    probeAuthorized: false,
    waitTimeoutPolicy: EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  });

  if (owner === null) {
    return blocked("no_active_owner");
  }
  if (!sameNormalized(owner.target, normalizedBoundary.target)) {
    return blocked("owner_target_mismatch");
  }
  if (!sameNormalized(owner.head, normalizedBoundary.head)) {
    return blocked("owner_head_mismatch");
  }
  if (owner.waitKind !== normalizedBoundary.waitKind) {
    return blocked("owner_wait_kind_mismatch");
  }
  if (now - Date.parse(owner.updatedAt) > staleAfterMs) {
    return blocked("owner_lease_stale");
  }

  const ownedWaiting = () => deepFreeze({
    ok: true,
    status: "owned_waiting",
    owner,
    advancePhaseAuthorized: false,
    probeAuthorized: false,
    secondObserverAuthorized: false,
    waitTimeoutPolicy: EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  });

  if (transition === null) {
    return ownedWaiting();
  }
  if (
    !sameNormalized(transition.target, normalizedBoundary.target) ||
    !sameNormalized(transition.head, normalizedBoundary.head) ||
    transition.waitKind !== normalizedBoundary.waitKind
  ) {
    return blocked("stale_or_malformed_transition");
  }
  if (ADVANCING_TRANSITION_STATUSES.has(transition.status)) {
    return deepFreeze({
      ok: true,
      status: "transition_ready",
      owner,
      transition,
      advancePhaseAuthorized: true,
      probeAuthorized: false,
      secondObserverAuthorized: false,
      waitTimeoutPolicy: EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
    });
  }
  if (WAITING_TRANSITION_STATUSES.has(transition.status)) {
    // A timeout does not advance the phase — the existing timeout policy
    // governs escalation, this resolver only reports the healthy wait.
    return ownedWaiting();
  }
  return blocked("stale_or_malformed_transition");
}

/**
 * Pure default-deny guard: the coordinator has no sanctioned observer
 * operation while watcher exclusivity holds — the lease owner is the sole
 * observer. Every explicitly prohibited kind throws a named prohibition
 * error; every OTHER kind (there is no allow-list) throws
 * unknown_coordinator_observer_operation. This mirrors
 * assertReviewerOperationAllowed's default-deny posture, but with an empty
 * allow-list: there is nothing a coordinator may do here except wait for the
 * lease owner's evidence to change.
 * @param {{kind:string}} operation
 * @returns {never}
 */
export function assertNoOverlappingObserver(operation) {
  if (!operation || typeof operation !== "object" || !isNonEmptyString(operation.kind)) {
    throw new TypeError("assertNoOverlappingObserver requires operation.kind to be a non-empty string");
  }
  const { kind } = operation;
  if (PROHIBITED_COORDINATOR_OBSERVER_OPERATIONS_SET.has(kind)) {
    throw new Error(`coordinator observer operation prohibited under watcher exclusivity: ${kind}`);
  }
  throw new Error(`unknown_coordinator_observer_operation: ${kind}`);
}
