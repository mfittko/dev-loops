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
 * Resolves the RETROSPECTIVE_CHECKPOINT_STATE for a durable checkpoint
 * artifact, scoped to the recorded cycle's recency (issue: a one-time
 * `complete`/`skipped` checkpoint must not satisfy every later qualifying
 * cycle forever).
 *
 * A `complete` or `skipped` artifact is scoped by `hasNewerMergeSinceCheckpoint`:
 * when true, something has merged since the checkpoint's recorded discharge
 * point (or that point could not be verified at all), so the checkpoint
 * cannot cover the newer cycle — it fails closed to MISSING. The caller
 * derives `hasNewerMergeSinceCheckpoint` itself (this module stays
 * pure/I/O-free) by checking local git ancestry between the checkpoint's
 * recorded merge commit and the base branch, so this runs fresh on every
 * evaluation rather than depending on anything having written a fresh
 * `required` record for the new cycle.
 *
 * `required`/`none` are not scoped by this comparison: `required` already
 * maps to MISSING regardless of recency (an outstanding requirement blocks
 * the gate no matter which cycle triggered it), and `none` means no
 * completion has ever been observed.
 *
 * @param {object|null|undefined} artifact - Parsed checkpoint JSON, or
 *   `undefined` when the durable artifact is genuinely ABSENT (no file). Any
 *   other non-plain-object value — including the JSON literal `null` (a file
 *   that IS present but contains malformed content) and a corrupt-but-valid
 *   scalar/array — is treated as present-but-malformed and fails closed to
 *   MISSING; only a genuinely absent artifact resolves to NONE.
 * @param {object} [options]
 * @param {boolean} [options.hasNewerMergeSinceCheckpoint] - True when the
 *   caller has determined (or could not rule out) that something has merged
 *   to the base branch since the checkpoint's recorded discharge point.
 *   Ignored for states other than `complete`/`skipped`. Defaults to `false`
 *   (trust the recorded state) so callers that never verify recency (e.g.
 *   `workflow.requireRetrospective` disabled) see unchanged behavior.
 * @returns {"none"|"complete"|"skipped"|"missing"}
 */
export function resolveCheckpointStateFromArtifact(artifact, { hasNewerMergeSinceCheckpoint = false } = {}) {
  if (artifact === undefined) {
    return RETROSPECTIVE_CHECKPOINT_STATE.NONE;
  }
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
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
  if (rawState === "skipped") {
    return hasNewerMergeSinceCheckpoint ? RETROSPECTIVE_CHECKPOINT_STATE.MISSING : RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED;
  }
  if (rawState === "complete") {
    return hasNewerMergeSinceCheckpoint ? RETROSPECTIVE_CHECKPOINT_STATE.MISSING : RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE;
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
