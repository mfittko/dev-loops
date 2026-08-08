/**
 * Post-run behavioral retrospective checkpoint contract.
 *
 * Defines the enforcement seam for the required post-run behavioral retrospective
 * after qualifying async dev-loop completions in this repository.
 *
 * This module is intentionally pure and side-effect free. Callers are responsible
 * for reading/writing the durable checkpoint artifact and passing the resolved
 * checkpoint state to the enforcement gate.
 *
 * Relationship to formal dev mode:
 * - Formal local dev mode is scoped to local implementation/self-improvement work.
 * - The required post-run behavioral retrospective applies to qualifying async
 *   GitHub-first dev-loop completions, independent of whether that run was in
 *   formal local dev mode.
 * - These are related but distinct requirements.
 */

/**
 * Stable state constants for the post-run behavioral retrospective checkpoint.
 *
 * These represent the state that a caller derives from the durable checkpoint
 * artifact on disk, then passes to the enforcement gate.
 *
 * Mapping from durable artifact to checkpoint state:
 * - No artifact file → NONE (no qualifying completion has occurred)
 * - Artifact file with state "required" → MISSING (completion detected, retrospective pending)
 * - Artifact file with state "complete" → COMPLETE (retrospective recorded)
 * - Artifact file with state "skipped" → SKIPPED (explicitly skipped with reason)
 */
export const RETROSPECTIVE_CHECKPOINT_STATE = Object.freeze({
  /** No qualifying async dev-loop completion has occurred; no retrospective is required. */
  NONE: "none",
  /** The required retrospective has been completed and recorded. */
  COMPLETE: "complete",
  /** The required retrospective was explicitly skipped with a stated reason. */
  SKIPPED: "skipped",
  /** A qualifying async dev-loop completion was detected but no retrospective checkpoint exists. */
  MISSING: "missing",
});

/**
 * The set of internal dev-loop strategy gate names that represent qualifying
 * GitHub-first async completions in this repository.
 *
 * A post-run behavioral retrospective is required before the next dev-loop
 * start/resume when the previous run used one of these gates.
 *
 * Qualifying gates:
 * - copilot_pr_followup: Copilot-owned PR follow-up (primary routed GitHub-first path)
 * - issue_intake: Copilot-first issue intake (GitHub-first issue assignment path)
 */
export const RETROSPECTIVE_QUALIFYING_GATES = Object.freeze([
  "copilot_pr_followup",
  "issue_intake",
]);

/**
 * Normalizes an external retrospective checkpoint-state input to one of the
 * stable RETROSPECTIVE_CHECKPOINT_STATE values. Returns null when the value is
 * absent or unrecognized.
 *
 * @param {unknown} value
 * @returns {"none"|"complete"|"skipped"|"missing"|null}
 */
export function normalizeRetrospectiveCheckpointState(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Object.values(RETROSPECTIVE_CHECKPOINT_STATE).includes(normalized) ? normalized : null;
}

/**
 * Returns true if a routing result represents a qualifying GitHub-first async
 * dev-loop completion that requires a post-run behavioral retrospective before
 * the next start/resume.
 *
 * A qualifying completion is one that:
 * - has a `selectedGate` in RETROSPECTIVE_QUALIFYING_GATES
 * - with `routeKind === "route"` (inspect/status-only results do not qualify)
 */
export function isQualifyingAsyncCompletion(routingResult) {
  if (!routingResult || typeof routingResult !== "object") return false;
  const { routeKind, selectedGate } = routingResult;
  if (routeKind !== "route") {
    return false;
  }
  if (typeof selectedGate !== "string") return false;
  return RETROSPECTIVE_QUALIFYING_GATES.includes(selectedGate);
}

/**
 * Normalizes a dev-loop cycle identity — the minimum facts that pin a
 * checkpoint record to one specific qualifying completion: repo, PR number,
 * and merge commit. Returns null when any field is missing or malformed, so a
 * partial/garbled identity can never be mistaken for a valid one.
 *
 * @param {unknown} identity
 * @returns {{repo: string, prNumber: number, mergeCommit: string}|null}
 */
export function normalizeCheckpointCycleIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    return null;
  }
  const repo = typeof identity.repo === "string" ? identity.repo.trim() : "";
  const prNumber = Number.isInteger(identity.prNumber) && identity.prNumber > 0 ? identity.prNumber : null;
  const mergeCommit = typeof identity.mergeCommit === "string" ? identity.mergeCommit.trim() : "";
  if (repo.length === 0 || prNumber === null || mergeCommit.length === 0) {
    return null;
  }
  return { repo, prNumber, mergeCommit };
}

/**
 * True when two cycle identities refer to the same dev-loop cycle. Either
 * side may be raw/unnormalized; both are normalized before comparison. An
 * invalid (or absent) identity on either side never matches.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function checkpointCycleIdentitiesMatch(a, b) {
  const normalizedA = normalizeCheckpointCycleIdentity(a);
  const normalizedB = normalizeCheckpointCycleIdentity(b);
  if (!normalizedA || !normalizedB) {
    return false;
  }
  return normalizedA.repo.toLowerCase() === normalizedB.repo.toLowerCase()
    && normalizedA.prNumber === normalizedB.prNumber
    && normalizedA.mergeCommit.toLowerCase() === normalizedB.mergeCommit.toLowerCase();
}

/**
 * Resolves the RETROSPECTIVE_CHECKPOINT_STATE for a durable checkpoint
 * artifact, scoped to a specific dev-loop cycle identity (issue: a one-time
 * `complete`/`skipped` checkpoint must not satisfy every later qualifying
 * cycle forever).
 *
 * A `complete` or `skipped` artifact whose recorded `identity` does not match
 * `latestQualifyingIdentity` (when the caller has one to compare against)
 * cannot discharge that newer cycle — it fails closed to MISSING. The caller
 * derives `latestQualifyingIdentity` itself (this module stays pure/I/O-free)
 * by querying the latest qualifying completion at the moment the gate is
 * evaluated, so this comparison runs on every call rather than depending on
 * anything having written a fresh `required` record for the new identity.
 *
 * `required`/`none` are not scoped by this comparison: `required` already
 * maps to MISSING regardless of identity (an outstanding requirement blocks
 * the gate no matter which cycle triggered it), and `none` means no
 * completion has ever been observed.
 *
 * @param {object|null|undefined} artifact - Parsed checkpoint JSON, or
 *   null/undefined when the durable artifact is absent. A non-null value that
 *   is not a plain object (e.g. a corrupt-but-valid-JSON scalar or array) is
 *   treated as a present-but-malformed artifact and fails closed to MISSING —
 *   only a genuinely ABSENT artifact resolves to NONE.
 * @param {object} [options]
 * @param {unknown} [options.latestQualifyingIdentity] - Identity of the most
 *   recently observed qualifying completion this call, or null/absent when
 *   none is known.
 * @returns {"none"|"complete"|"skipped"|"missing"}
 */
export function resolveCheckpointStateFromArtifact(artifact, { latestQualifyingIdentity = null } = {}) {
  if (artifact === null || artifact === undefined) {
    return RETROSPECTIVE_CHECKPOINT_STATE.NONE;
  }
  if (typeof artifact !== "object") {
    // Present but malformed — fail closed, do not treat as "nothing observed".
    return RETROSPECTIVE_CHECKPOINT_STATE.MISSING;
  }
  const rawState = typeof artifact.state === "string" ? artifact.state.trim().toLowerCase() : null;
  if (rawState === "required" || rawState === "missing") {
    return RETROSPECTIVE_CHECKPOINT_STATE.MISSING;
  }
  if (rawState === "none") {
    return RETROSPECTIVE_CHECKPOINT_STATE.NONE;
  }
  const normalizedLatest = normalizeCheckpointCycleIdentity(latestQualifyingIdentity);
  const staleForLatestCycle = normalizedLatest && !checkpointCycleIdentitiesMatch(artifact.identity, normalizedLatest);
  if (rawState === "skipped") {
    return staleForLatestCycle ? RETROSPECTIVE_CHECKPOINT_STATE.MISSING : RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED;
  }
  if (rawState === "complete") {
    return staleForLatestCycle ? RETROSPECTIVE_CHECKPOINT_STATE.MISSING : RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE;
  }
  // Malformed/unrecognized durable state — fail closed.
  return RETROSPECTIVE_CHECKPOINT_STATE.MISSING;
}

/**
 * Enforcement gate for the required post-run behavioral retrospective.
 *
 * Evaluates whether a proposed dev-loop routing result should proceed or be
 * blocked due to a missing retrospective checkpoint from the previous qualifying
 * async completion.
 *
 * Pass-through cases (proposed routing is returned unchanged):
 * - checkpoint state is NONE (no qualifying completion has happened; no requirement exists)
 * - checkpoint state is COMPLETE (retrospective was recorded; requirement satisfied)
 * - checkpoint state is SKIPPED (explicitly skipped with reason; requirement satisfied)
 * - proposed routing is already a stop or needs_reconcile result
 * - proposed routing is an inspect-only result
 *
 * Fail-closed case:
 * - checkpoint state is MISSING: returns a needs_reconcile result that blocks start/resume
 * - unrecognized checkpoint state: returns a needs_reconcile result
 *
 * @param {object} input
 * @param {string} input.checkpointState - One of the RETROSPECTIVE_CHECKPOINT_STATE values
 * @param {object} input.proposedRouting - The routing result from evaluatePublicDevLoopRouting
 * @returns {object} The original or replacement routing result
 */
export function evaluateRetrospectiveGate({ checkpointState, proposedRouting } = {}) {
  if (!proposedRouting || typeof proposedRouting !== "object") {
    return {
      publicEntrypoint: "dev-loop",
      routeKind: "needs_reconcile",
      selectedGate: "fail_closed_reconcile",
      selectedStrategy: null,
      executionMode: "bounded_handoff",
      waitSemantics: "default",
      canonicalState: null,
      issueAssignmentSeam: "not_applicable",
      nextAction: "Reconcile the retrospective checkpoint state before routing.",
      reason: "Missing or invalid proposed routing result for retrospective gate evaluation.",
    };
  }

  // Already a terminal/inspect result — pass through regardless of checkpoint state.
  if (
    proposedRouting.routeKind === "stop" ||
    proposedRouting.routeKind === "needs_reconcile" ||
    proposedRouting.routeKind === "inspect"
  ) {
    return proposedRouting;
  }

  // No qualifying completion, or retrospective satisfied — pass through.
  if (
    checkpointState === RETROSPECTIVE_CHECKPOINT_STATE.NONE ||
    checkpointState === RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE ||
    checkpointState === RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED
  ) {
    return proposedRouting;
  }

  // Missing retrospective checkpoint — fail closed.
  if (checkpointState === RETROSPECTIVE_CHECKPOINT_STATE.MISSING) {
    return {
      ...proposedRouting,
      routeKind: "needs_reconcile",
      selectedGate: "fail_closed_reconcile",
      selectedStrategy: null,
      waitSemantics: proposedRouting.waitSemantics ?? "default",
      issueAssignmentSeam: proposedRouting.issueAssignmentSeam ?? "not_applicable",
      nextAction:
        "Complete or explicitly skip the required post-run behavioral retrospective before starting or resuming the next dev-loop run.",
      reason:
        "The previous qualifying async dev-loop completion is missing its required behavioral retrospective checkpoint.",
    };
  }

  // Unrecognized checkpoint state — fail closed.
  return {
    ...proposedRouting,
    routeKind: "needs_reconcile",
    selectedGate: "fail_closed_reconcile",
    selectedStrategy: null,
    waitSemantics: proposedRouting.waitSemantics ?? "default",
    issueAssignmentSeam: proposedRouting.issueAssignmentSeam ?? "not_applicable",
    nextAction: "Reconcile the retrospective checkpoint state before routing.",
    reason: `Unrecognized retrospective checkpoint state: "${String(checkpointState)}".`,
  };
}
