/**
 * Pure snapshot composer for the Copilot PR outer-loop run inspection surface.
 *
 * This module provides a read-only, JSON-first inspection snapshot for one
 * explicitly targeted run in the Copilot PR outer-loop family.
 *
 * It composes already-fetched inner-loop facts into the canonical inspection
 * shape without performing any I/O, checkpoint writes, or state mutations.
 *
 * Schema version: 1
 *
 * Always-present output fields:
 *   ok, schemaVersion, target, inspectedAt, activeStateFamily,
 *   outerAction, activeFamilyState, statusClass, needsAttention,
 *   sourceMode, trust, evidence, markers
 *
 * Best-effort output fields:
 *   loopIterations, layers (copilot, reviewer, steering drill-down)
 *
 * Source precedence:
 *   1. Authoritative live detector-backed facts
 *   2. Bounded local checkpoint artifacts
 *   3. Unknown/unavailable markers when neither is sufficient
 */

import { summarizeLoopInterpretation } from "./copilot-loop-state.mjs";
import { isKnownOuterState } from "./conductor-routing.mjs";
import { getAllowedTransitions, lifecyclePhaseForCopilotState, resolveLifecycleState } from "./lifecycle-state.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

/** The workflow family this module inspects. */
export const ACTIVE_STATE_FAMILY = "copilot-pr-outer-loop";

export function deriveRunIdForInspectionTarget({ pr }) {
  return `pr-${pr}`;
}

/** Top-level status class values. */
export const STATUS_CLASS = Object.freeze({
  ACTIVE: "active",
  WAITING: "waiting",
  BLOCKED: "blocked",
  DONE: "done",
  UNKNOWN: "unknown",
});

/** Source mode values reflecting evidence availability. */
export const SOURCE_MODE = Object.freeze({
  /** Both inner-loop detectors returned live facts. */
  LIVE_DETECTOR_BACKED: "live-detector-backed",
  /** Live detection failed for all inner loops; checkpoint-backed drill-down remains available, but the top-level state stays unknown. */
  CHECKPOINT_ONLY: "checkpoint-only",
  /** Degraded mode: mixed live + checkpoint fallback keeps the top-level state unknown; complete caller-supplied current-state inputs can still derive a top-level state. */
  PARTIAL: "partial",
  /** No live facts and no valid checkpoint available. */
  UNAVAILABLE: "unavailable",
});

/** Trust classification for the inspection output. */
export const TRUST = Object.freeze({
  /** All facts come from live authoritative sources. */
  AUTHORITATIVE: "authoritative",
  /** Facts come from a previously persisted checkpoint (advisory only). */
  CHECKPOINT: "checkpoint",
  /** Facts are a mix of live and checkpoint, or only partial live coverage. */
  DEGRADED: "degraded",
  /** No trustworthy evidence available. */
  UNAVAILABLE: "unavailable",
});

// ---------------------------------------------------------------------------
// Status-class mapping
// ---------------------------------------------------------------------------

/**
 * Map an outerAction value to a top-level statusClass.
 *
 * Mapping:
 *   continue_wait              → waiting
 *   reenter_copilot_loop       → active
 *   reenter_reviewer_loop      → active
 *   stop                       → blocked
 *   done                       → done
 *   anything else / undefined  → unknown
 *
 * @param {string | undefined} outerAction
 * @returns {string} one of STATUS_CLASS values
 */
export function mapOuterActionToStatusClass(outerAction) {
  switch (outerAction) {
    case "continue_wait":
      return STATUS_CLASS.WAITING;
    case "reenter_copilot_loop":
    case "reenter_reviewer_loop":
      return STATUS_CLASS.ACTIVE;
    case "stop":
      return STATUS_CLASS.BLOCKED;
    case "done":
      return STATUS_CLASS.DONE;
    default:
      return STATUS_CLASS.UNKNOWN;
  }
}

function buildReviewerScope(snapshotLike) {
  if (snapshotLike?.reviewerScope === "single_reviewer") {
    return {
      mode: "single_reviewer",
      reviewerLogin: typeof snapshotLike?.reviewerLogin === "string" ? snapshotLike.reviewerLogin : null,
    };
  }

  return {
    mode: "all_reviewers",
    reviewerLogin: null,
  };
}

const LIVE_STEERING_TERMINAL_STATES = new Set([
  "no_pr",
  "done",
  "review_request_unavailable",
  "blocked_needs_user_decision",
]);

function evaluateLiveSteeringAvailability({
  sourceMode,
  trust,
  markers,
  statusClass,
  copilotCurrentState,
}) {
  if (sourceMode !== SOURCE_MODE.LIVE_DETECTOR_BACKED) {
    return { status: "unavailable", reason: "live_steering_unavailable_source_mode" };
  }

  if (trust !== TRUST.AUTHORITATIVE) {
    return { status: "unavailable", reason: "live_steering_unavailable_trust" };
  }

  if (
    markers.missing.length > 0
    || markers.stale.length > 0
    || markers.conflicts.length > 0
  ) {
    return { status: "unavailable", reason: "live_steering_unavailable_markers" };
  }

  if (statusClass === STATUS_CLASS.UNKNOWN || typeof copilotCurrentState !== "string") {
    return { status: "unavailable", reason: "live_steering_unavailable_unknown_state" };
  }

  if (
    statusClass === STATUS_CLASS.DONE
    || statusClass === STATUS_CLASS.BLOCKED
    || LIVE_STEERING_TERMINAL_STATES.has(copilotCurrentState)
  ) {
    return { status: "unavailable", reason: "live_steering_unavailable_terminal_state" };
  }

  return { status: "available", reason: null };
}

// ---------------------------------------------------------------------------
// Snapshot composer
// ---------------------------------------------------------------------------

/**
 * Compose a read-only run inspection snapshot for one explicitly targeted run
 * in the Copilot PR outer-loop family.
 *
 * This function is pure: it performs no I/O and does not mutate any files or
 * checkpoints. All evidence must be gathered by the caller before invoking it.
 *
 * @param {object} params
 * @param {{ repo: string, pr: number }} params.target
 *   Explicit target identity.
 * @param {string} params.inspectedAt
 *   ISO 8601 timestamp of when the inspection was initiated.
 * @param {string | undefined} [params.outerState]
 *   Authoritative outer-loop state derived by the caller from a complete
 *   current-state picture, or undefined when the outer state cannot be determined.
 * @param {string[] | undefined} [params.outerAllowedTransitions]
 *   Authoritative allowed next outer states when `outerState` is available.
 * @param {string | undefined} params.outerAction
 *   Backward-compatible outer-loop action projection derived by the caller from
 *   the authoritative outer interpretation, or undefined when the outer action
 *   cannot be determined.
 * @param {string | undefined} [params.outerReason]
 *   Optional stop reason string from the authoritative outer-loop interpretation
 *   (for example `interpretOuterLoopState(...).stopReason`, such as
 *   "copilot_blocked").
 * @param {{ snapshot: object, interpretation: { state: string, allowedTransitions: string[], nextAction: string } } | null} params.copilotEvidence
 *   Live copilot inner-loop facts. null when live detection was unavailable.
 * @param {{ snapshot: object, interpretation: { state: string, allowedTransitions: string[], nextAction: string } } | null} params.reviewerEvidence
 *   Live reviewer inner-loop facts. null when live detection was unavailable.
 * @param {object | null} params.existingCheckpoint
 *   Previously persisted outer-loop checkpoint (read-only). null when not found.
 * @param {string | null} [params.checkpointEvidencePath]
 *   Concrete checkpoint file path used by the caller when a checkpoint was found.
 * @param {{ copilot: "ok"|"failed", reviewer: "ok"|"failed" }} params.liveAvailability
 *   Tracks whether each detector/interpreter path succeeded ("ok") or failed ("failed").
 * @param {{ copilot?: "live"|"input", reviewer?: "live"|"input" }} [params.evidenceSourceKinds]
 *   Indicates whether successful evidence came from live detection or caller-supplied snapshot input.
 * @param {boolean} [params.explicitTargetMissing]
 *   True when the explicit target was not found by one or more detector inputs.
 * @param {string | null} [params.steeringLocatorPath]
 *   Path to the steering state file, when explicitly provided by the caller.
 *   null means no locator was given.
 * @param {object | null} [params.steeringEvidence]
 *   Loaded and normalized steering state, or null when file not found.
 * @param {boolean} [params.steeringLoadFailed]
 *   true when a steering locator was provided but loading the file failed.
 * @param {string | null} [params.steeringUnavailableReason]
 *   Optional explicit unavailable reason when a steering file was supplied but
 *   cannot be trusted for this inspected target.
 * @param {object | null} [params.steeringReadback]
 *   Precomputed steering readback summary for the inspection surface.
 * @param {object} [params.loopIterations]
 *   Best-effort Copilot remote-loop iteration summary. This is intended for
 *   GitHub-backed PR loops where durable review/timeline facts are available.
 * @returns {object} inspection snapshot with always-present and best-effort fields
 */
export function composeRunInspectionSnapshot({
  target,
  inspectedAt,
  outerState,
  outerAllowedTransitions,
  outerAction,
  outerReason,
  copilotEvidence,
  reviewerEvidence,
  existingCheckpoint,
  checkpointEvidencePath = null,
  liveAvailability,
  evidenceSourceKinds = { copilot: "live", reviewer: "live" },
  explicitTargetMissing = false,
  steeringLocatorPath = null,
  steeringEvidence = null,
  steeringLoadFailed = false,
  steeringUnavailableReason = null,
  steeringReadback = null,
  loopIterations = {
    available: false,
    source: "github_pr_timeline",
    reason: "unavailable",
  },
}) {
  const { repo, pr } = target;
  const runId = deriveRunIdForInspectionTarget(target);
  const markers = { missing: [], stale: [], conflicts: [] };

  const copilotLiveOk = liveAvailability.copilot === "ok";
  const reviewerLiveOk = liveAvailability.reviewer === "ok";
  const copilotLiveFailed = liveAvailability.copilot === "failed";
  const reviewerLiveFailed = liveAvailability.reviewer === "failed";
  const bothLiveOk = copilotLiveOk && reviewerLiveOk;
  const copilotSourceKind = evidenceSourceKinds.copilot ?? "live";
  const reviewerSourceKind = evidenceSourceKinds.reviewer ?? "live";
  const bothSourceKindsLive = copilotSourceKind === "live" && reviewerSourceKind === "live";
  const inputSnapshotMode = bothLiveOk && !bothSourceKindsLive;

  const evidenceAuthoritative = [];
  const evidenceCheckpoint = [];

  // -------------------------------------------------------------------------
  // Determine source mode and trust
  // -------------------------------------------------------------------------

  let sourceMode;
  let trust;

  if (explicitTargetMissing) {
    sourceMode = SOURCE_MODE.UNAVAILABLE;
    trust = TRUST.UNAVAILABLE;
    markers.missing.push("explicit target PR was not found");
  } else if (bothLiveOk && bothSourceKindsLive) {
    sourceMode = SOURCE_MODE.LIVE_DETECTOR_BACKED;
    trust = TRUST.AUTHORITATIVE;
    evidenceAuthoritative.push("live Copilot loop detector", "live reviewer loop detector");
  } else if (inputSnapshotMode) {
    sourceMode = SOURCE_MODE.PARTIAL;
    trust = TRUST.DEGRADED;
  } else if (!copilotLiveOk && !reviewerLiveOk) {
    if (existingCheckpoint !== null && typeof existingCheckpoint?.outerAction === "string") {
      sourceMode = SOURCE_MODE.CHECKPOINT_ONLY;
      trust = TRUST.CHECKPOINT;
    } else {
      sourceMode = SOURCE_MODE.UNAVAILABLE;
      trust = TRUST.UNAVAILABLE;
    }
    if (copilotLiveFailed) {
      markers.missing.push("live Copilot loop state (detection failed)");
    }
    if (reviewerLiveFailed) {
      markers.missing.push("live reviewer loop state (detection failed)");
    }
  } else {
    // Partial: one live ok, one failed
    sourceMode = SOURCE_MODE.PARTIAL;
    trust = TRUST.DEGRADED;
    if (copilotLiveOk) {
      evidenceAuthoritative.push("live Copilot loop detector");
    } else {
      if (copilotLiveFailed) {
        markers.missing.push("live Copilot loop state (detection failed)");
      }
      if (existingCheckpoint?.copilotState !== undefined) {
        markers.stale.push("copilot loop state (checkpoint-derived; live detection failed)");
      }
    }
    if (reviewerLiveOk) {
      evidenceAuthoritative.push("live reviewer loop detector");
    } else {
      if (reviewerLiveFailed) {
        markers.missing.push("live reviewer loop state (detection failed)");
      }
      if (existingCheckpoint?.reviewerState !== undefined) {
        markers.stale.push("reviewer loop state (checkpoint-derived; live detection failed)");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Checkpoint evidence and conflict detection
  // -------------------------------------------------------------------------

  if (existingCheckpoint !== null) {
    if (checkpointEvidencePath !== null) {
      evidenceCheckpoint.push(checkpointEvidencePath);
    }

    if (bothLiveOk && outerAction !== undefined) {
      // Check for conflicts between live-derived action and checkpoint
      const ckptOuterAction = existingCheckpoint.outerAction;
      if (typeof ckptOuterAction === "string" && ckptOuterAction !== outerAction) {
        markers.conflicts.push(
          `checkpoint outerAction '${ckptOuterAction}' differs from live-derived '${outerAction}'`,
        );
      }

      const ckptCopilotState = existingCheckpoint.copilotState;
      if (
        copilotEvidence !== null
        && typeof ckptCopilotState === "string"
        && ckptCopilotState !== copilotEvidence.interpretation.state
      ) {
        markers.conflicts.push(
          `checkpoint copilotState '${ckptCopilotState}' differs from live '${copilotEvidence.interpretation.state}'`,
        );
      }

      const ckptReviewerState = existingCheckpoint.reviewerState;
      if (
        reviewerEvidence !== null
        && typeof ckptReviewerState === "string"
        && ckptReviewerState !== reviewerEvidence.interpretation.state
      ) {
        markers.conflicts.push(
          `checkpoint reviewerState '${ckptReviewerState}' differs from live '${reviewerEvidence.interpretation.state}'`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Top-level outer-state / outerAction surfacing eligibility
  // -------------------------------------------------------------------------

  // Top-level outer fields are only surfaced when the caller derived them from
  // a complete current evidence set. Checkpoint-backed or mixed fallback remains
  // available only as advisory drill-down evidence in this chunk.
  const effectiveOuterState = isKnownOuterState(outerState) ? outerState : undefined;
  const effectiveOuterAllowedTransitions = effectiveOuterState !== undefined && Array.isArray(outerAllowedTransitions)
    ? [...outerAllowedTransitions]
    : undefined;
  const effectiveOuterAction = outerAction;
  const effectiveOuterReason = outerReason;

  // -------------------------------------------------------------------------
  // Determine statusClass
  // -------------------------------------------------------------------------

  let statusClass;
  if (sourceMode === SOURCE_MODE.UNAVAILABLE || effectiveOuterAction === undefined) {
    statusClass = STATUS_CLASS.UNKNOWN;
  } else {
    statusClass = mapOuterActionToStatusClass(effectiveOuterAction);
  }

  // -------------------------------------------------------------------------
  // Determine needsAttention
  // -------------------------------------------------------------------------

  const needsAttention =
    effectiveOuterAction === "stop"
    || markers.conflicts.length > 0
    || markers.missing.length > 0
    || sourceMode === SOURCE_MODE.CHECKPOINT_ONLY
    || sourceMode === SOURCE_MODE.UNAVAILABLE
    || (sourceMode === SOURCE_MODE.PARTIAL && !inputSnapshotMode);

  // -------------------------------------------------------------------------
  // Build evidence summary
  // -------------------------------------------------------------------------

  let evidenceSummary;
  if (explicitTargetMissing) {
    evidenceSummary = "The explicit target PR was not found; no current run state could be determined.";
  } else if (sourceMode === SOURCE_MODE.LIVE_DETECTOR_BACKED) {
    if (effectiveOuterState === "stay_with_current_live_owner") {
      evidenceSummary = "Live detectors agree a live owner already controls this run, so the orchestrator should not issue a new handoff yet.";
    } else if (effectiveOuterState === "needs_reconcile") {
      evidenceSummary = "Live detectors found ambiguous or conflicting state, so the orchestrator must reconcile before continuing.";
    } else if (effectiveOuterState === "stop_needs_human") {
      evidenceSummary = `Live detectors indicate a blocked outer state that needs human intervention${effectiveOuterReason !== undefined ? ` (reason: ${effectiveOuterReason})` : ""}.`;
    } else if (effectiveOuterState === "done_terminal") {
      evidenceSummary = "Live detectors agree the PR is complete.";
    } else if (effectiveOuterState === "continue_current_wait") {
      evidenceSummary = "Live detectors agree the orchestrator is in its durable wait state.";
    } else if (effectiveOuterState === "handoff_to_copilot_loop") {
      evidenceSummary = "Live detectors indicate the next meaningful work belongs to the Copilot loop.";
    } else if (effectiveOuterState === "handoff_to_reviewer_loop") {
      evidenceSummary = "Live detectors indicate the next meaningful work belongs to the reviewer loop.";
    } else if (effectiveOuterAction !== undefined) {
      evidenceSummary = `Live detectors returned results, but only the compatibility outerAction could be determined (outerAction: ${effectiveOuterAction}).`;
    } else {
      evidenceSummary = "Live detectors returned results but outer state could not be determined.";
    }
    if (markers.conflicts.length > 0) {
      evidenceSummary += " Checkpoint state conflicts with live facts.";
    }
  } else if (sourceMode === SOURCE_MODE.CHECKPOINT_ONLY) {
    evidenceSummary =
      "No live detector facts are available. Checkpoint state is shown as advisory drill-down only, and the current top-level run state could not be confirmed.";
  } else if (sourceMode === SOURCE_MODE.PARTIAL) {
    evidenceSummary = inputSnapshotMode
      ? "One or more caller-supplied snapshot inputs were used. The result reflects the complete current-state picture provided to inspection, but remains degraded because it was not fully live-detector-backed."
      : "Only partial live evidence is available. Any checkpoint-backed state is advisory only, so the current top-level run state could not be confirmed.";
  } else {
    evidenceSummary = "No evidence available to determine current run state.";
  }

  // -------------------------------------------------------------------------
  // Build layers (best-effort drill-down)
  // -------------------------------------------------------------------------

  const layers = {};

  if (copilotLiveOk && copilotEvidence !== null) {
    const copilotSummary = summarizeLoopInterpretation(copilotEvidence.interpretation);
    layers.copilot = {
      currentState: copilotEvidence.interpretation.state,
      allowedTransitions: copilotEvidence.interpretation.allowedTransitions,
      sameHeadCleanConverged: copilotEvidence.interpretation.sameHeadCleanConverged === true,
      loopDisposition: copilotSummary.loopDisposition,
      terminal: copilotSummary.terminal,
    };
  } else if (typeof existingCheckpoint?.copilotState === "string") {
    layers.copilot = {
      currentState: existingCheckpoint.copilotState,
      source: "checkpoint",
    };
  }

  if (reviewerLiveOk && reviewerEvidence !== null) {
    const reviewerSubmittedReviewState = reviewerEvidence.snapshot.submittedReviewState ?? null;
    const reviewerApprovedOnCurrentHead = reviewerEvidence.snapshot.submittedReviewPresent === true
      && reviewerSubmittedReviewState === "APPROVED"
      && reviewerEvidence.snapshot.prHeadSha !== null
      && reviewerEvidence.snapshot.submittedReviewCommitSha !== null
      && reviewerEvidence.snapshot.prHeadSha === reviewerEvidence.snapshot.submittedReviewCommitSha;

    layers.reviewer = {
      currentState: reviewerEvidence.interpretation.state,
      allowedTransitions: reviewerEvidence.interpretation.allowedTransitions,
      scope: buildReviewerScope(reviewerEvidence.snapshot),
      submittedReviewState: reviewerSubmittedReviewState,
      approvedOnCurrentHead: reviewerApprovedOnCurrentHead,
    };
  } else if (typeof existingCheckpoint?.reviewerState === "string") {
    layers.reviewer = {
      currentState: existingCheckpoint.reviewerState,
      source: "checkpoint",
      scope: buildReviewerScope(existingCheckpoint),
    };
  }

  // Steering layer (best-effort; only when an explicit locator is provided)
  if (steeringLocatorPath === null || steeringLocatorPath === undefined) {
    layers.steering = {
      status: "unavailable",
      reason: "no_steering_locator",
    };
  } else if (steeringLoadFailed) {
    layers.steering = {
      status: "unavailable",
      reason: "load_failed",
    };
  } else if (steeringUnavailableReason !== null) {
    layers.steering = {
      status: "unavailable",
      reason: steeringUnavailableReason,
    };
  } else if (steeringEvidence === null) {
    layers.steering = {
      status: "unavailable",
      reason: "no_steering_file",
    };
  } else {
    const liveSteering = evaluateLiveSteeringAvailability({
      sourceMode,
      trust,
      markers,
      statusClass,
      copilotCurrentState: layers.copilot?.currentState,
    });

    if (liveSteering.status === "available") {
      layers.steering = {
        status: "available",
        ...(steeringReadback ?? {}),
        liveSteering,
      };
    } else {
      layers.steering = {
        status: "unavailable",
        reason: liveSteering.reason,
        liveSteering,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle phase resolution (best-effort from available PR facts)
  // -------------------------------------------------------------------------

  let lifecyclePhase = null;
  let lifecycleAllowedTransitions = null;

  if (copilotLiveOk && copilotEvidence !== null) {
    const copilotState = copilotEvidence.interpretation.state;
    const mappedPhase = lifecyclePhaseForCopilotState(copilotState);
    if (mappedPhase) {
      lifecyclePhase = mappedPhase;
      lifecycleAllowedTransitions = getAllowedTransitions(mappedPhase);
    }
  }

  if (lifecyclePhase === null) {
    // Fallback: derive from available PR facts
    const loopIter = loopIterations ?? {};
    const hasUnresolvedThreads = typeof loopIter.unresolvedReviewThreads === "number"
      && loopIter.unresolvedReviewThreads > 0;
    const copilotState = copilotLiveOk && copilotEvidence !== null
      ? copilotEvidence.interpretation.state
      : null;
    const prIsDraft = copilotState === "pr_draft";

    const resolved = resolveLifecycleState({
      hasLinkedPr: !explicitTargetMissing,
      prIsDraft,
      hasUnresolvedThreads,
    });
    lifecyclePhase = resolved.state;
    lifecycleAllowedTransitions = resolved.allowedTransitions;
  }

  // -------------------------------------------------------------------------
  // Assemble final snapshot
  // -------------------------------------------------------------------------

  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    target: { repo, pr },
    runId,
    inspectedAt,
    activeStateFamily: ACTIVE_STATE_FAMILY,
    outerState: effectiveOuterState ?? "unknown",
    ...(effectiveOuterAllowedTransitions !== undefined ? { allowedTransitions: effectiveOuterAllowedTransitions } : {}),
    outerAction: effectiveOuterAction ?? "unknown",
    activeFamilyState: effectiveOuterAction ?? "unknown",
    statusClass,
    needsAttention,
    sourceMode,
    trust,
    evidence: {
      summary: evidenceSummary,
      authoritative: evidenceAuthoritative,
      checkpoint: evidenceCheckpoint,
    },
    markers,
    loopIterations,
    layers,
    lifecyclePhase,
    lifecycleAllowedTransitions,
  };
}
