/**
 * child-launch-bound.mjs — dev-loop execution-cap fail-fast child-launch
 * bound (epic decided approach): a bounded, deterministic primitive that
 * attempts a child launch AT MOST ONCE, queries the harness-supported-model
 * inventory AT MOST ONCE and ONLY after a failed launch, and always produces
 * a durable blocker record on failure — never a retry, a silent model
 * substitution, or a dispatch without the requested override.
 *
 * Pure and offline: launch/query behavior is fully caller-injected
 * (attemptLaunch/querySupportedModels); this module never imports a runtime
 * harness adapter, reads a file, or performs I/O of its own.
 */

/**
 * Dev-loop harnesses this bound recognizes; any other value fails closed.
 * This primitive only carries the harness label through the request/blocker
 * — it does not branch on it or depend on per-harness capability data (e.g.
 * HARNESS_DEFAULT_CAPABILITIES), so it stays agnostic across pi, claude, and
 * codex.
 */
const HARNESS_VALUES = Object.freeze(["pi", "claude", "codex"]);

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate + normalize the child-launch request. Fails closed (TypeError) on
 * any malformed/empty field, at the trust boundary of this function.
 * @param {object} request
 * @returns {{run:string, roleOrAngle:string, model:string, harness:"pi"|"claude"|"codex"}}
 */
function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("enforceChildLaunchBound requires a request object");
  }
  const { run, roleOrAngle, model, harness } = request;
  if (!isNonEmptyString(run)) throw new TypeError("request.run must be a non-empty string");
  if (!isNonEmptyString(roleOrAngle)) throw new TypeError("request.roleOrAngle must be a non-empty string");
  if (!isNonEmptyString(model)) throw new TypeError("request.model must be a non-empty string");
  if (!HARNESS_VALUES.includes(harness)) {
    throw new TypeError(`request.harness must be one of ${HARNESS_VALUES.join(", ")}, got ${JSON.stringify(harness)}`);
  }
  return { run: run.trim(), roleOrAngle: roleOrAngle.trim(), model: model.trim(), harness };
}

// Note: querySupportedModels may return { supported: [...] }, a bare
// array, or a Set — normalizing all three into one Set here keeps the
// caller-facing contract flexible without adding a second exported shape.
/** @param {{supported?: unknown}|unknown[]|Set<string>} result @returns {Set<string>} */
function toSupportedSet(result) {
  const list = result && typeof result === "object" && !Array.isArray(result) && !(result instanceof Set)
    ? result.supported
    : result;
  if (list instanceof Set) return list;
  if (Array.isArray(list)) return new Set(list);
  return new Set();
}

/**
 * Enforce the bounded, deterministic child-launch fail-fast protocol.
 *
 * Scope: this bounds ONE invocation — one launch attempt plus at most one
 * inventory query for that same call. It holds no state across calls, so
 * cross-call terminality (never re-launching the same `(run, roleOrAngle,
 * model)` after a prior call already returned a blocked verdict) is the
 * caller's/coordinator's contract, not something a persisted token here
 * enforces.
 *
 * Deadline contract: `deadlineMs` is a MEASUREMENT bound, not a per-call
 * timeout. The function times the elapsed wall-clock span of the one launch
 * attempt plus (on failure) the one inventory query, and reports
 * `withinDeadline` fail-closed (`elapsedMs <= deadlineMs`) — it never cancels
 * or races `attemptLaunch`/`querySupportedModels` against the clock. The
 * <=60s guarantee holds only because each injected operation is a single
 * bounded call, never a retry loop, inside this function; enforcing a hard
 * per-operation timeout/cancellation on a slow `attemptLaunch` or
 * `querySupportedModels` implementation is the caller's operation-budget
 * responsibility and is intentionally out of scope for this pure primitive.
 *
 * @param {object} options
 * @param {{run:string, roleOrAngle:string, model:string, harness:"pi"|"claude"|"codex"}} options.request
 * @param {(request:object)=>({ok:true,launch:*}|{ok:false,reason:string})} options.attemptLaunch
 *   Called AT MOST ONCE.
 * @param {(request:object)=>({supported:string[]}|string[]|Set<string>)} options.querySupportedModels
 *   Called AT MOST ONCE, and only after a failed launch.
 * @param {()=>number} [options.now] - injectable clock, default Date.now.
 * @param {number} [options.deadlineMs] - measurement bound in ms, default 60000.
 * @returns {object} `{ ok: true, launch, events, elapsedMs }` on success, or
 *   the durable blocker `{ ok: false, verdict: "blocked", reason, request,
 *   modelSupported, elapsedMs, withinDeadline, events }` on failure.
 */
export function enforceChildLaunchBound({ request, attemptLaunch, querySupportedModels, now = () => Date.now(), deadlineMs = 60000 } = {}) {
  const normalizedRequest = validateRequest(request);
  if (typeof attemptLaunch !== "function") {
    throw new TypeError("enforceChildLaunchBound requires attemptLaunch to be a function");
  }
  if (typeof querySupportedModels !== "function") {
    throw new TypeError("enforceChildLaunchBound requires querySupportedModels to be a function");
  }

  const events = [];
  const start = now();

  // EXACTLY one launch attempt, ever — no retry, no model substitution.
  const launchResult = attemptLaunch(normalizedRequest);
  events.push({ type: "launch_attempt" });

  if (launchResult && launchResult.ok === true) {
    // Success: never query the inventory, never attempt a second launch.
    return { ok: true, launch: launchResult.launch, events, elapsedMs: now() - start };
  }

  // Launch failed: query the harness's supported-model inventory EXACTLY
  // once, only now (never before a launch attempt, never more than once).
  const inventory = querySupportedModels(normalizedRequest);
  events.push({ type: "inventory_query" });
  const modelSupported = toSupportedSet(inventory).has(normalizedRequest.model);

  const launchReason = launchResult && typeof launchResult.reason === "string" ? launchResult.reason : null;
  const reason = launchReason === "unresolvable"
    ? "child_model_unresolvable"
    : !modelSupported
      ? "child_model_unsupported"
      : "child_launch_failed_model_supported";

  const elapsedMs = now() - start;
  // Measurement, not enforcement: a slow adapter still returns the blocker
  // (fail-closed) rather than being cancelled or retried against the clock.
  const withinDeadline = elapsedMs <= deadlineMs;

  return {
    ok: false,
    verdict: "blocked",
    reason,
    request: normalizedRequest,
    modelSupported,
    elapsedMs,
    withinDeadline,
    events,
  };
}
