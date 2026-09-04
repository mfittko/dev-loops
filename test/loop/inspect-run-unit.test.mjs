import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  ACTIVE_STATE_FAMILY,
  composeRunInspectionSnapshot,
  mapOuterActionToStatusClass,
  SCHEMA_VERSION,
  SOURCE_MODE,
  STATUS_CLASS,
  TRUST,
} from "../../packages/core/src/loop/run-inspection.mjs";
import { parseInspectRunCliArgs } from "../../scripts/loop/inspect-run.mjs";
import {
  makeCopilotEvidence,
  makeReviewerEvidence,
} from "./inspect-run-test-helpers.mjs";
test("mapOuterActionToStatusClass: continue_wait → waiting", () => {
  assert.equal(mapOuterActionToStatusClass("continue_wait"), STATUS_CLASS.WAITING);
});

test("mapOuterActionToStatusClass: reenter_copilot_loop → active", () => {
  assert.equal(mapOuterActionToStatusClass("reenter_copilot_loop"), STATUS_CLASS.ACTIVE);
});

test("mapOuterActionToStatusClass: reenter_reviewer_loop → active", () => {
  assert.equal(mapOuterActionToStatusClass("reenter_reviewer_loop"), STATUS_CLASS.ACTIVE);
});

test("mapOuterActionToStatusClass: stop → blocked", () => {
  assert.equal(mapOuterActionToStatusClass("stop"), STATUS_CLASS.BLOCKED);
});

test("mapOuterActionToStatusClass: done → done", () => {
  assert.equal(mapOuterActionToStatusClass("done"), STATUS_CLASS.DONE);
});

test("mapOuterActionToStatusClass: unknown value → unknown", () => {
  assert.equal(mapOuterActionToStatusClass("not_a_real_action"), STATUS_CLASS.UNKNOWN);
  assert.equal(mapOuterActionToStatusClass(undefined), STATUS_CLASS.UNKNOWN);
});

// ---------------------------------------------------------------------------
// Unit tests: composeRunInspectionSnapshot — complete live evidence
// ---------------------------------------------------------------------------

test("composeRunInspectionSnapshot: complete live evidence returns all required fields", () => {
  const copilotEvidence = makeCopilotEvidence("waiting_for_copilot_review");
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAllowedTransitions: ["continue_current_wait", "handoff_to_copilot_loop"],
    outerAction: "continue_wait",
    outerReason: undefined,
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  // Always-present fields
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(snapshot.target, { repo: "owner/repo", pr: 55 });
  assert.equal(snapshot.inspectedAt, "2026-05-18T12:00:00Z");
  assert.equal(snapshot.activeStateFamily, ACTIVE_STATE_FAMILY);
  assert.equal(snapshot.outerState, "continue_current_wait");
  assert.deepEqual(snapshot.allowedTransitions, ["continue_current_wait", "handoff_to_copilot_loop"]);
  assert.equal(snapshot.outerAction, "continue_wait");
  assert.equal(snapshot.activeFamilyState, "continue_wait");
  assert.equal(snapshot.statusClass, STATUS_CLASS.WAITING);
  assert.equal(snapshot.needsAttention, false);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.LIVE_DETECTOR_BACKED);
  assert.equal(snapshot.trust, TRUST.AUTHORITATIVE);

  // Evidence
  assert.ok(typeof snapshot.evidence.summary === "string" && snapshot.evidence.summary.length > 0);
  assert.ok(Array.isArray(snapshot.evidence.authoritative));
  assert.ok(snapshot.evidence.authoritative.length > 0);
  assert.ok(Array.isArray(snapshot.evidence.checkpoint));

  // Markers
  assert.deepEqual(snapshot.markers.missing, []);
  assert.deepEqual(snapshot.markers.stale, []);
  assert.deepEqual(snapshot.markers.conflicts, []);

  // Layers (best-effort)
  assert.deepEqual(snapshot.loopIterations, {
    available: false,
    source: "github_pr_timeline",
    reason: "unavailable",
  });
  assert.equal(snapshot.layers.copilot.currentState, "waiting_for_copilot_review");
  assert.equal(snapshot.layers.copilot.sameHeadCleanConverged, false);
  assert.equal(snapshot.layers.copilot.loopDisposition, "pending");
  assert.equal(snapshot.layers.copilot.terminal, false);
  assert.equal(snapshot.layers.reviewer.currentState, "waiting_for_author_followup");
  assert.equal(snapshot.layers.reviewer.submittedReviewState, "COMMENTED");
  assert.equal(snapshot.layers.reviewer.approvedOnCurrentHead, false);
  assert.equal(snapshot.layers.steering.status, "unavailable");
  assert.equal(snapshot.layers.steering.reason, "no_steering_locator");

  // Lifecycle fields
  assert.equal(snapshot.lifecyclePhase, "feedback_resolution");
  assert.deepEqual(snapshot.lifecycleAllowedTransitions, ["implementation", "pre_approval_gate"]);
});

test("composeRunInspectionSnapshot: live evidence + done → statusClass done, needsAttention false", () => {
  const copilotEvidence = makeCopilotEvidence("done");
  copilotEvidence.snapshot.prMerged = true;
  const reviewerEvidence = makeReviewerEvidence("waiting_for_review_request");

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "done_terminal",
    outerAllowedTransitions: [],
    outerAction: "done",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.statusClass, STATUS_CLASS.DONE);
  assert.equal(snapshot.needsAttention, false);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.LIVE_DETECTOR_BACKED);
  assert.equal(snapshot.trust, TRUST.AUTHORITATIVE);
});

test("composeRunInspectionSnapshot: explicitTargetMissing uses hasLinkedPr false in lifecycle fallback", () => {
  // Use a copilot state not in any COPILOT_INNER_STATE_MAP entry to force fallback
  const copilotEvidence = makeCopilotEvidence("some_unknown_state");
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  // Without explicitTargetMissing: fallback hasLinkedPr true → implementation
  const snapOk = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAction: "continue_wait",
    explicitTargetMissing: false,
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });
  assert.equal(snapOk.lifecyclePhase, "implementation");

  // With explicitTargetMissing: fallback hasLinkedPr false → issue_intake
  const snapMissing = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAction: "continue_wait",
    explicitTargetMissing: true,
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });
  assert.equal(snapMissing.lifecyclePhase, "issue_intake");
  assert.deepEqual(snapMissing.lifecycleAllowedTransitions, ["refinement", "implementation"]);
});

test("composeRunInspectionSnapshot: clean-converged Copilot state carries same-head convergence flags", () => {
  const copilotEvidence = makeCopilotEvidence("ready_to_rerequest_review", { sameHeadCleanConverged: true });
  copilotEvidence.snapshot.copilotReviewPresent = true;
  copilotEvidence.snapshot.copilotReviewOnCurrentHead = true;
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAllowedTransitions: ["continue_current_wait", "handoff_to_copilot_loop"],
    outerAction: "continue_wait",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.layers.copilot.currentState, "ready_to_rerequest_review");
  assert.equal(snapshot.layers.copilot.sameHeadCleanConverged, true);
  assert.equal(snapshot.layers.copilot.loopDisposition, "clean_converged");
  assert.equal(snapshot.layers.copilot.terminal, true);
});

test("composeRunInspectionSnapshot: approved reviewer verdict on current head is surfaced in reviewer layer", () => {
  const copilotEvidence = makeCopilotEvidence("ready_to_rerequest_review", { sameHeadCleanConverged: true });
  copilotEvidence.snapshot.copilotReviewPresent = true;
  copilotEvidence.snapshot.copilotReviewOnCurrentHead = true;
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup", { submittedReviewState: "APPROVED" });

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAllowedTransitions: ["continue_current_wait", "handoff_to_copilot_loop"],
    outerAction: "continue_wait",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.layers.reviewer.currentState, "waiting_for_author_followup");
  assert.equal(snapshot.layers.reviewer.submittedReviewState, "APPROVED");
  assert.equal(snapshot.layers.reviewer.approvedOnCurrentHead, true);
});

test("composeRunInspectionSnapshot: approved reviewer verdict without a submitted review does not count as current-head approval", () => {
  const copilotEvidence = makeCopilotEvidence("ready_to_rerequest_review", { sameHeadCleanConverged: true });
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup", {
    submittedReviewState: "APPROVED",
    submittedReviewPresent: false,
  });

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAllowedTransitions: ["continue_current_wait", "handoff_to_copilot_loop"],
    outerAction: "continue_wait",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.layers.reviewer.submittedReviewState, "APPROVED");
  assert.equal(snapshot.layers.reviewer.approvedOnCurrentHead, false);
});

test("composeRunInspectionSnapshot: live evidence + stop → statusClass blocked, needsAttention true", () => {
  const copilotEvidence = makeCopilotEvidence("blocked_needs_user_decision");
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "stop_needs_human",
    outerAllowedTransitions: [],
    outerAction: "stop",
    outerReason: "copilot_blocked",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.statusClass, STATUS_CLASS.BLOCKED);
  assert.equal(snapshot.needsAttention, true);
  assert.ok(snapshot.evidence.summary.includes("blocked"));
});

test("composeRunInspectionSnapshot: live evidence + reenter_copilot_loop → active", () => {
  const copilotEvidence = makeCopilotEvidence("unresolved_feedback_present");
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "handoff_to_copilot_loop",
    outerAllowedTransitions: ["continue_current_wait", "handoff_to_copilot_loop"],
    outerAction: "reenter_copilot_loop",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.statusClass, STATUS_CLASS.ACTIVE);
  assert.equal(snapshot.needsAttention, false);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.LIVE_DETECTOR_BACKED);
});

test("composeRunInspectionSnapshot: evidence summary preserves stay_with_current_live_owner", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "stay_with_current_live_owner",
    outerAllowedTransitions: ["continue_current_wait"],
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("ready_to_rerequest_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_review_request"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.match(snapshot.evidence.summary, /live owner already controls this run/i);
  assert.doesNotMatch(snapshot.evidence.summary, /outerAction: continue_wait/i);
});


test("composeRunInspectionSnapshot: evidence summary preserves needs_reconcile", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "needs_reconcile",
    outerAllowedTransitions: [],
    outerAction: "stop",
    outerReason: "ownership_conflict",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_review_request"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.match(snapshot.evidence.summary, /must reconcile before continuing/i);
  assert.doesNotMatch(snapshot.evidence.summary, /blocked\/stop state/i);
});

test("composeRunInspectionSnapshot: invalid outerState normalizes to unknown and hides allowedTransitions", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "not_a_real_outer_state",
    outerAllowedTransitions: ["continue_current_wait", "handoff_to_copilot_loop"],
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.outerState, "unknown");
  assert.equal("allowedTransitions" in snapshot, false);
  assert.equal(snapshot.outerAction, "continue_wait");
  assert.equal(snapshot.statusClass, STATUS_CLASS.WAITING);
  assert.match(snapshot.evidence.summary, /only the compatibility outerAction could be determined/i);
});

// ---------------------------------------------------------------------------
// Unit tests: checkpoint-only fixture
// ---------------------------------------------------------------------------

test("composeRunInspectionSnapshot: checkpoint-only stays advisory and leaves top-level state unknown", () => {
  const existingCheckpoint = {
    pr: 55,
    repo: "owner/repo",
    outerAction: "continue_wait",
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_author_followup",
    reason: null,
    timestamp: "2026-05-17T10:00:00Z",
    waitCycles: 3,
  };

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: undefined,
    copilotEvidence: null,
    reviewerEvidence: null,
    existingCheckpoint,
    checkpointEvidencePath: "tmp/copilot-loop/owner/repo/pr-55/outer-loop-state.json",
    liveAvailability: { copilot: "failed", reviewer: "failed" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.CHECKPOINT_ONLY);
  assert.equal(snapshot.trust, TRUST.CHECKPOINT);
  assert.equal(snapshot.needsAttention, true);
  assert.equal(snapshot.outerAction, "unknown");
  assert.equal(snapshot.activeFamilyState, "unknown");
  assert.equal(snapshot.statusClass, STATUS_CLASS.UNKNOWN);
  assert.match(snapshot.evidence.summary, /advisory/i);
  assert.match(snapshot.evidence.summary, /could not be determined|could not be confirmed/i);

  // Checkpoint layer is populated
  assert.equal(snapshot.layers.copilot.currentState, "waiting_for_copilot_review");
  assert.equal(snapshot.layers.copilot.source, "checkpoint");
  assert.equal(snapshot.layers.reviewer.currentState, "waiting_for_author_followup");
  assert.equal(snapshot.layers.reviewer.source, "checkpoint");

  // Missing markers present because live detection failed
  assert.ok(snapshot.markers.missing.length > 0);

  // Checkpoint listed in evidence.checkpoint
  assert.ok(snapshot.evidence.checkpoint.length > 0);
  assert.equal(snapshot.evidence.checkpoint[0], "tmp/copilot-loop/owner/repo/pr-55/outer-loop-state.json");
});

test("composeRunInspectionSnapshot: no live and no checkpoint → unavailable, unknown statusClass", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: undefined,
    copilotEvidence: null,
    reviewerEvidence: null,
    existingCheckpoint: null,
    liveAvailability: { copilot: "failed", reviewer: "failed" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.UNAVAILABLE);
  assert.equal(snapshot.trust, TRUST.UNAVAILABLE);
  assert.equal(snapshot.statusClass, STATUS_CLASS.UNKNOWN);
  assert.equal(snapshot.needsAttention, true);
  assert.equal(snapshot.outerAction, "unknown");
  assert.equal(snapshot.activeFamilyState, "unknown");
});

// ---------------------------------------------------------------------------
// Unit tests: stale checkpoint vs fresher live fact
// ---------------------------------------------------------------------------

test("composeRunInspectionSnapshot: live wins over stale checkpoint; conflict marker added", () => {
  const copilotEvidence = makeCopilotEvidence("ready_to_rerequest_review");
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  // Checkpoint says continue_wait but live says reenter_copilot_loop
  const existingCheckpoint = {
    pr: 55,
    repo: "owner/repo",
    outerAction: "continue_wait",           // stale: was waiting
    copilotState: "waiting_for_copilot_review", // stale
    reviewerState: "waiting_for_author_followup",
    reason: null,
    timestamp: "2026-05-17T10:00:00Z",
    waitCycles: 1,
  };

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "reenter_copilot_loop",   // live-derived
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  // Live wins
  assert.equal(snapshot.outerAction, "reenter_copilot_loop");
  assert.equal(snapshot.statusClass, STATUS_CLASS.ACTIVE);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.LIVE_DETECTOR_BACKED);
  assert.equal(snapshot.trust, TRUST.AUTHORITATIVE);

  // Conflicts are recorded
  assert.ok(snapshot.markers.conflicts.length > 0);
  assert.ok(snapshot.markers.conflicts.some((c) => c.includes("continue_wait")));
  assert.ok(snapshot.markers.conflicts.some((c) => c.includes("reenter_copilot_loop")));

  // needsAttention because of conflict
  assert.equal(snapshot.needsAttention, true);

  // Summary mentions conflict
  assert.ok(snapshot.evidence.summary.includes("conflict") || snapshot.evidence.summary.includes("Checkpoint state conflicts"));
});

test("composeRunInspectionSnapshot: live copilot state matches checkpoint — no conflict", () => {
  const copilotEvidence = makeCopilotEvidence("waiting_for_copilot_review");
  const reviewerEvidence = makeReviewerEvidence("waiting_for_author_followup");

  const existingCheckpoint = {
    pr: 55,
    repo: "owner/repo",
    outerAction: "continue_wait",
    copilotState: "waiting_for_copilot_review",   // same as live
    reviewerState: "waiting_for_author_followup", // same as live
    reason: null,
    timestamp: "2026-05-17T10:00:00Z",
    waitCycles: 1,
  };

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "continue_wait",
    copilotEvidence,
    reviewerEvidence,
    existingCheckpoint,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.deepEqual(snapshot.markers.conflicts, []);
  assert.equal(snapshot.needsAttention, false);
  assert.equal(snapshot.sourceMode, SOURCE_MODE.LIVE_DETECTOR_BACKED);
});

// ---------------------------------------------------------------------------
// Unit tests: partial live evidence
// ---------------------------------------------------------------------------

test("composeRunInspectionSnapshot: mixed live + checkpoint stays advisory and leaves top-level state unknown", () => {
  const copilotEvidence = makeCopilotEvidence("waiting_for_copilot_review");

  const existingCheckpoint = {
    pr: 55,
    repo: "owner/repo",
    outerAction: "continue_wait",
    copilotState: "waiting_for_copilot_review",
    reviewerState: "waiting_for_author_followup",
    reason: null,
    timestamp: "2026-05-17T10:00:00Z",
    waitCycles: 1,
  };

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: undefined,
    copilotEvidence,
    reviewerEvidence: null,
    existingCheckpoint,
    liveAvailability: { copilot: "ok", reviewer: "failed" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.sourceMode, SOURCE_MODE.PARTIAL);
  assert.equal(snapshot.trust, TRUST.DEGRADED);
  assert.equal(snapshot.needsAttention, true);
  assert.equal(snapshot.outerAction, "unknown");
  assert.equal(snapshot.activeFamilyState, "unknown");
  assert.equal(snapshot.statusClass, STATUS_CLASS.UNKNOWN);
  assert.match(snapshot.evidence.summary, /insufficient|advisory/i);
  assert.ok(snapshot.markers.missing.length > 0 || snapshot.markers.stale.length > 0);

  // Copilot layer from live
  assert.equal(snapshot.layers.copilot.currentState, "waiting_for_copilot_review");
  assert.equal(snapshot.layers.copilot.source, undefined); // live source has no "source" field

  // Reviewer layer from checkpoint
  assert.equal(snapshot.layers.reviewer.currentState, "waiting_for_author_followup");
  assert.equal(snapshot.layers.reviewer.source, "checkpoint");
});

// ---------------------------------------------------------------------------
// Unit tests: steering layer
// ---------------------------------------------------------------------------

test("composeRunInspectionSnapshot: no steering locator → steering unavailable, no_steering_locator", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.layers.steering.status, "unavailable");
  assert.equal(snapshot.layers.steering.reason, "no_steering_locator");
  assert.equal(snapshot.layers.steering.locatorPath, undefined);
});

test("composeRunInspectionSnapshot: steering locator given but file missing → no_steering_file", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: "/tmp/nonexistent/steering.json",
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  assert.equal(snapshot.layers.steering.status, "unavailable");
  assert.equal(snapshot.layers.steering.reason, "no_steering_file");
  assert.equal(snapshot.layers.steering.locatorPath, undefined);
});

test("composeRunInspectionSnapshot: steering locator given and file loads → available", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: "/tmp/run-1-steering.json",
    steeringEvidence: {
      runId: "run-1",
      schemaVersion: 1,
      effectiveStack: [],
      queuedEvents: [],
    },
    steeringLoadFailed: false,
    steeringReadback: {
      latestAcknowledgement: null,
      effectiveConstraints: { hardConstraints: [], preferences: [], clarifications: [], stopAtNextSafeGate: false, unknownConstraints: [] },
      pendingSummary: { queuedCount: 0, queuedKinds: [], stopAtNextSafeGateQueued: false },
      stopAtNextSafeGate: { effective: false, queued: false, terminal: false, safePointCategory: "immediate" },
    },
  });

  assert.equal(snapshot.layers.steering.status, "available");
  assert.equal(snapshot.layers.steering.liveSteering.status, "available");
  assert.equal(snapshot.layers.steering.liveSteering.reason, null);
  assert.equal(snapshot.layers.steering.locatorPath, undefined);
  assert.equal(snapshot.layers.steering.latestAcknowledgement, null);
  assert.equal(snapshot.layers.steering.pendingSummary.queuedCount, 0);
  assert.equal(snapshot.layers.steering.stopAtNextSafeGate.effective, false);
  assert.equal("state" in snapshot.layers.steering, false);
});

test("composeRunInspectionSnapshot: steering file exists but snapshot-mode evidence does not advertise live steering", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    evidenceSourceKinds: { copilot: "input", reviewer: "input" },
    steeringLocatorPath: "/tmp/run-1-steering.json",
    steeringEvidence: {
      runId: "run-1",
      schemaVersion: 1,
      effectiveStack: [],
      queuedEvents: [],
    },
    steeringLoadFailed: false,
    steeringReadback: {
      latestAcknowledgement: null,
      effectiveConstraints: { hardConstraints: [], preferences: [], clarifications: [], stopAtNextSafeGate: false, unknownConstraints: [] },
      pendingSummary: { queuedCount: 0, queuedKinds: [], stopAtNextSafeGateQueued: false },
      stopAtNextSafeGate: { effective: false, queued: false, terminal: false, safePointCategory: "immediate" },
    },
  });

  assert.equal(snapshot.layers.steering.status, "unavailable");
  assert.equal(snapshot.layers.steering.reason, "live_steering_unavailable_source_mode");
  assert.equal(snapshot.layers.steering.liveSteering.status, "unavailable");
  assert.equal(snapshot.layers.steering.liveSteering.reason, "live_steering_unavailable_source_mode");
  assert.equal("latestAcknowledgement" in snapshot.layers.steering, false);
});

test("composeRunInspectionSnapshot: live authoritative terminal state does not advertise live steering", () => {
  const copilotEvidence = makeCopilotEvidence("done");
  copilotEvidence.snapshot.prMerged = true;

  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "done_terminal",
    outerAllowedTransitions: [],
    outerAction: "done",
    copilotEvidence,
    reviewerEvidence: makeReviewerEvidence("waiting_for_review_request"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: "/tmp/run-1-steering.json",
    steeringEvidence: {
      runId: "pr-55",
      schemaVersion: 1,
      effectiveStack: [],
      queuedEvents: [],
    },
    steeringLoadFailed: false,
    steeringReadback: {
      latestAcknowledgement: null,
      effectiveConstraints: { hardConstraints: [], preferences: [], clarifications: [], stopAtNextSafeGate: false, unknownConstraints: [] },
      pendingSummary: { queuedCount: 0, queuedKinds: [], stopAtNextSafeGateQueued: false },
      stopAtNextSafeGate: { effective: false, queued: false, terminal: true, safePointCategory: "terminal" },
    },
  });

  assert.equal(snapshot.statusClass, STATUS_CLASS.DONE);
  assert.equal(snapshot.layers.steering.status, "unavailable");
  assert.equal(snapshot.layers.steering.reason, "live_steering_unavailable_terminal_state");
  assert.equal(snapshot.layers.steering.liveSteering.status, "unavailable");
  assert.equal(snapshot.layers.steering.liveSteering.reason, "live_steering_unavailable_terminal_state");
  assert.equal("latestAcknowledgement" in snapshot.layers.steering, false);
});

test("composeRunInspectionSnapshot: steering load failed → load_failed reason", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: "/tmp/bad-steering.json",
    steeringEvidence: null,
    steeringLoadFailed: true,
  });

  assert.equal(snapshot.layers.steering.status, "unavailable");
  assert.equal(snapshot.layers.steering.reason, "load_failed");
  assert.equal(snapshot.layers.steering.locatorPath, undefined);
});

// ---------------------------------------------------------------------------
// Unit tests: schema contract
// ---------------------------------------------------------------------------

test("composeRunInspectionSnapshot: output has stable required top-level fields", () => {
  const snapshot = composeRunInspectionSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    inspectedAt: "2026-05-18T12:00:00Z",
    outerState: "continue_current_wait",
    outerAllowedTransitions: ["continue_current_wait"],
    outerAction: "continue_wait",
    copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
    reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
    existingCheckpoint: null,
    liveAvailability: { copilot: "ok", reviewer: "ok" },
    steeringLocatorPath: null,
    steeringEvidence: null,
    steeringLoadFailed: false,
  });

  const requiredFields = [
    "ok", "schemaVersion", "target", "inspectedAt",
    "activeStateFamily", "outerState", "outerAction", "activeFamilyState",
    "statusClass", "needsAttention", "sourceMode", "trust",
    "evidence", "markers", "loopIterations",
  ];

  for (const field of requiredFields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(snapshot, field),
      `Missing required field: ${field}`,
    );
  }

  assert.ok(typeof snapshot.evidence.summary === "string");
  assert.ok(Array.isArray(snapshot.evidence.authoritative));
  assert.ok(Array.isArray(snapshot.evidence.checkpoint));
  assert.ok(Array.isArray(snapshot.markers.missing));
  assert.ok(Array.isArray(snapshot.markers.stale));
  assert.ok(Array.isArray(snapshot.markers.conflicts));
});

test("composeRunInspectionSnapshot: outerAction always equals activeFamilyState", () => {
  for (const outerAction of ["continue_wait", "done", "stop", "reenter_copilot_loop", "reenter_reviewer_loop"]) {
    const snapshot = composeRunInspectionSnapshot({
      target: { repo: "owner/repo", pr: 55 },
      inspectedAt: "2026-05-18T12:00:00Z",
      outerAction,
      copilotEvidence: makeCopilotEvidence("waiting_for_copilot_review"),
      reviewerEvidence: makeReviewerEvidence("waiting_for_author_followup"),
      existingCheckpoint: null,
      liveAvailability: { copilot: "ok", reviewer: "ok" },
      steeringLocatorPath: null,
      steeringEvidence: null,
      steeringLoadFailed: false,
    });

    assert.equal(
      snapshot.outerAction,
      snapshot.activeFamilyState,
      `outerAction and activeFamilyState must match for outerAction=${outerAction}`,
    );
  }
});

// ---------------------------------------------------------------------------
// CLI argument parsing unit tests
// ---------------------------------------------------------------------------

test("parseInspectRunCliArgs: parses required flags", () => {
  const opts = parseInspectRunCliArgs(["--repo", "owner/repo", "--pr", "55"]);
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.pr, 55);
  assert.equal(opts.steeringStateFile, undefined);
  assert.equal(opts.copilotInputPath, undefined);
  assert.equal(opts.reviewerInputPath, undefined);
  assert.equal(opts.reviewerLogin, undefined);
});

test("parseInspectRunCliArgs: parses all optional flags", () => {
  const opts = parseInspectRunCliArgs([
    "--repo", "owner/repo",
    "--pr", "55",
    "--steering-state-file", "/tmp/steering.json",
    "--copilot-input", "/tmp/copilot.json",
    "--reviewer-input", "/tmp/reviewer.json",
  ]);
  assert.equal(opts.steeringStateFile, "/tmp/steering.json");
  assert.equal(opts.copilotInputPath, "/tmp/copilot.json");
  assert.equal(opts.reviewerInputPath, "/tmp/reviewer.json");
});

test.skip("parseInspectRunCliArgs: parses reviewer-login for live reviewer detection", () => {
  const opts = parseInspectRunCliArgs([
    "--repo", "owner/repo",
    "--pr", "55",
    "--reviewer-login", "pi-reviewer",
  ]);
  assert.equal(opts.reviewerLogin, "pi-reviewer");
});

test.skip("parseInspectRunCliArgs: rejects blank reviewer-login", () => {
  assert.throws(
    () => parseInspectRunCliArgs([
      "--repo", "owner/repo",
      "--pr", "55",
      "--reviewer-login", "   ",
    ]),
    (err) => err.message.includes("--reviewer-login") && err.message.includes("empty"),
  );
});

test("parseInspectRunCliArgs: --help returns help flag", () => {
  const opts = parseInspectRunCliArgs(["--help"]);
  assert.equal(opts.help, true);
});

test("parseInspectRunCliArgs: missing --repo throws", () => {
  assert.throws(
    () => parseInspectRunCliArgs(["--pr", "55"]),
    (err) => err.message.includes("--repo") || err.message.includes("both"),
  );
});

test("parseInspectRunCliArgs: missing --pr throws", () => {
  assert.throws(
    () => parseInspectRunCliArgs(["--repo", "owner/repo"]),
    (err) => err.message.includes("--pr") || err.message.includes("both"),
  );
});

test("parseInspectRunCliArgs: invalid --pr (non-numeric) throws", () => {
  assert.throws(
    () => parseInspectRunCliArgs(["--repo", "owner/repo", "--pr", "abc"]),
    (err) => err.message.includes("--pr"),
  );
});

test("parseInspectRunCliArgs: invalid --pr (zero) throws", () => {
  assert.throws(
    () => parseInspectRunCliArgs(["--repo", "owner/repo", "--pr", "0"]),
    (err) => err.message.includes("--pr"),
  );
});

test("parseInspectRunCliArgs: unknown flag throws", () => {
  assert.throws(
    () => parseInspectRunCliArgs(["--repo", "owner/repo", "--pr", "55", "--unknown-flag"]),
    (err) => err.message.includes("Unknown argument"),
  );
});

test.skip("parseInspectRunCliArgs: rejects reviewer-input combined with reviewer-login", () => {
  assert.throws(
    () => parseInspectRunCliArgs([
      "--repo", "owner/repo",
      "--pr", "55",
      "--reviewer-input", "/tmp/reviewer.json",
      "--reviewer-login", "pi-reviewer",
    ]),
    (err) => err.message.includes("--reviewer-input") && err.message.includes("--reviewer-login"),
  );
});

test("parseInspectRunCliArgs: invalid repo slug throws", () => {
  assert.throws(
    () => parseInspectRunCliArgs(["--repo", "notavalidslug", "--pr", "55"]),
    (err) => err instanceof Error,
  );
});

