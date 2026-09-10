/**
 * gate-evidence-reconcile.mjs — deterministic self-heal for a stuck
 * `gate-evidence` required status (issue #1935).
 *
 * The server-side `gate-evidence` check (`.github/workflows/gate-evidence.yml`)
 * re-fires when a gate verdict is posted (ADR 0043). That native re-fire is
 * racy: a verdict-post run can be CANCELLED by `cancel-in-progress` when a
 * superseding event lands, or evaluate before the just-posted verdict is
 * API-visible, leaving the required status stuck at `failure` even though a
 * clean current-head `pre_approval_gate` verdict now exists. Nothing re-fires
 * afterward, so the merge stays `UNSTABLE` until a manual `gh run rerun`
 * (observed on PR #1934; ADR 0057).
 *
 * This pure decision separates the two cases the reconcile must never confuse:
 *  - evidence genuinely satisfied but the status is stuck non-green → re-fire
 *    the concrete run that posted the stale status (automating the manual
 *    rerun; the rerun re-evaluates LIVE evidence, which is now satisfied).
 *  - evidence genuinely NOT satisfied → do nothing. A head that truly lacks a
 *    clean current-head verdict MUST keep failing the check (fail-closed).
 */

/** Required commit-status context posted by the gate-evidence workflow. */
export const GATE_EVIDENCE_STATUS_CONTEXT = "gate-evidence";

/**
 * Extract the Actions run id from a gate-evidence commit-status `target_url`.
 * The workflow points every posted status at its own run:
 *   https://github.com/<owner>/<repo>/actions/runs/<run_id>
 * Returns the numeric run id as a string, or null when the URL is absent or
 * not an Actions-run URL (an unexpected target_url must not be coerced).
 *
 * @param {string} [targetUrl]
 * @returns {string|null}
 */
export function parseRunIdFromTargetUrl(targetUrl) {
  if (typeof targetUrl !== "string") return null;
  const match = targetUrl.match(/\/actions\/runs\/(\d+)(?:[/?#]|$)/);
  return match ? match[1] : null;
}

/**
 * Decide whether a stuck `gate-evidence` status should be re-fired.
 *
 * @param {object} input
 * @param {boolean} input.evidenceSatisfied  detect-checkpoint-evidence reports
 *   `evidenceState === "satisfied"` for the current head (clean draft_gate +
 *   current-head pre_approval_gate verdicts present).
 * @param {string} [input.statusState]  the `gate-evidence` commit-status state
 *   on the current head: `success` | `failure` | `error` | `pending` | `none`
 *   (`none` = no gate-evidence status posted for this head yet).
 * @param {string|null} [input.runId]  the Actions run id that posted the stale
 *   status (from `parseRunIdFromTargetUrl`), or null when unknown.
 * @returns {{ action: "refire"|"none", runId?: string, reason: string }}
 */
export function resolveGateEvidenceStatusReconcile({ evidenceSatisfied, statusState, runId } = {}) {
  // Fail-closed: never re-fire when the verdict evidence is genuinely not
  // satisfied. This preserves the "verdict genuinely missing" case — the head
  // keeps failing closed exactly as before (issue #1935 AC #3).
  if (evidenceSatisfied !== true) {
    return { action: "none", reason: "evidence-not-satisfied-fail-closed" };
  }
  // Already green — nothing to reconcile.
  if (statusState === "success") {
    return { action: "none", reason: "already-success" };
  }
  // Evidence IS satisfied for the current head, but the required status is not
  // success (the push-before-verdict race: a cancelled/stale re-fire). Re-fire
  // the concrete run that posted the stale status. Without a run id there is
  // nothing to re-fire deterministically; leave it to the native path rather
  // than forging a status.
  if (!runId) {
    return { action: "none", reason: "no-run-to-refire" };
  }
  return { action: "refire", runId, reason: "evidence-satisfied-status-stale" };
}
