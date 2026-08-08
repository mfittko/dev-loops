import assert from "node:assert/strict";
import test from "node:test";

import {
  RETROSPECTIVE_CHECKPOINT_STATE,
  RETROSPECTIVE_QUALIFYING_GATES,
  evaluateRetrospectiveGate,
  normalizeCheckpointCycleIdentity,
  resolveCheckpointStateFromArtifact,
} from "../src/loop/retrospective-checkpoint.mjs";

import {
  DEV_LOOP_ACTOR,
  DEV_LOOP_AUTHORIZATION,
  DEV_LOOP_GATE,
  DEV_LOOP_PUBLIC_INTENT,
  DEV_LOOP_ROUTE_KIND,
  DEV_LOOP_STATUS,
  DEV_LOOP_TARGET_KIND,
  DEV_LOOP_TARGET_PREFERENCE,
  INTERNAL_DEV_LOOP_STRATEGY,
  evaluatePublicDevLoopRouting,
} from "../src/loop/public-dev-loop-routing.mjs";

// ---------------------------------------------------------------------------
// RETROSPECTIVE_CHECKPOINT_STATE constants
// ---------------------------------------------------------------------------

test("RETROSPECTIVE_CHECKPOINT_STATE exports all four required state values", () => {
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.NONE, "none");
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE, "complete");
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED, "skipped");
  assert.equal(RETROSPECTIVE_CHECKPOINT_STATE.MISSING, "missing");
  assert.equal(Object.keys(RETROSPECTIVE_CHECKPOINT_STATE).length, 4);
});

test("RETROSPECTIVE_CHECKPOINT_STATE is frozen", () => {
  assert.ok(Object.isFrozen(RETROSPECTIVE_CHECKPOINT_STATE));
});

// ---------------------------------------------------------------------------
// RETROSPECTIVE_QUALIFYING_GATES constants
// ---------------------------------------------------------------------------

test("RETROSPECTIVE_QUALIFYING_GATES includes the two required GitHub-first gates", () => {
  assert.ok(RETROSPECTIVE_QUALIFYING_GATES.includes("copilot_pr_followup"));
  assert.ok(RETROSPECTIVE_QUALIFYING_GATES.includes("issue_intake"));
});

test("RETROSPECTIVE_QUALIFYING_GATES is frozen", () => {
  assert.ok(Object.isFrozen(RETROSPECTIVE_QUALIFYING_GATES));
});

test("RETROSPECTIVE_QUALIFYING_GATES aligns with actual DEV_LOOP_GATE values", () => {
  for (const gate of RETROSPECTIVE_QUALIFYING_GATES) {
    assert.ok(
      Object.values(DEV_LOOP_GATE).includes(gate),
      `qualifying gate "${gate}" must be a valid DEV_LOOP_GATE value`,
    );
  }
});

// ---------------------------------------------------------------------------
// evaluateRetrospectiveGate — enforcement
// ---------------------------------------------------------------------------

// Build a minimal valid copilot_pr_followup routing result for gate tests.
function makeCopilotPrFollowupResult() {
  return evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_ON_PR,
    target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
}

// ── Retrospective satisfied: checkpoint COMPLETE ─────────────────────────────

test("evaluateRetrospectiveGate: COMPLETE checkpoint passes through the proposed routing unchanged", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.equal(result.selectedStrategy, INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP);
  assert.deepEqual(result, proposed);
});

// ── Explicit skip with reason ─────────────────────────────────────────────────

test("evaluateRetrospectiveGate: SKIPPED checkpoint passes through the proposed routing unchanged", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP);
  assert.deepEqual(result, proposed);
});

// ── No qualifying completion ──────────────────────────────────────────────────

test("evaluateRetrospectiveGate: NONE checkpoint passes through the proposed routing unchanged", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.NONE,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

// ── Missing retrospective checkpoint: fails closed on start/resume ────────────

test("evaluateRetrospectiveGate: MISSING checkpoint blocks a copilot_pr_followup start/resume and fails closed", () => {
  const proposed = makeCopilotPrFollowupResult();
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, "fail_closed_reconcile");
  assert.equal(result.selectedStrategy, null);
  assert.match(result.nextAction, /retrospective/i);
  assert.match(result.reason, /missing/i);
});

test("evaluateRetrospectiveGate: MISSING checkpoint blocks an issue_intake start and fails closed", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 112 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
  assert.equal(proposed.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, "fail_closed_reconcile");
  assert.match(result.nextAction, /retrospective/i);
});

// ── Pass-through for terminal results ────────────────────────────────────────

test("evaluateRetrospectiveGate: stop result passes through regardless of MISSING checkpoint", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.DONE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.STOP);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

test("evaluateRetrospectiveGate: needs_reconcile result passes through regardless of MISSING checkpoint", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.CONTINUE_CURRENT,
    // Missing currentState — produces needs_reconcile
  });
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

test("evaluateRetrospectiveGate: inspect result passes through regardless of MISSING checkpoint", () => {
  const proposed = evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.INSPECT_STATE,
    currentState: {
      target: { kind: DEV_LOOP_TARGET_KIND.PR, pr: 88 },
      ownership: DEV_LOOP_ACTOR.COPILOT,
      nextActor: DEV_LOOP_ACTOR.COPILOT,
      status: DEV_LOOP_STATUS.ACTIVE,
      authorization: DEV_LOOP_AUTHORIZATION.AUTHORIZED,
    },
  });
  assert.equal(proposed.routeKind, DEV_LOOP_ROUTE_KIND.INSPECT);

  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
    proposedRouting: proposed,
  });

  assert.deepEqual(result, proposed);
});

// ── Unrecognized checkpoint state ─────────────────────────────────────────────

test("evaluateRetrospectiveGate: unrecognized checkpoint state fails closed", () => {
  const proposed = makeCopilotPrFollowupResult();
  const result = evaluateRetrospectiveGate({
    checkpointState: "unknown_state",
    proposedRouting: proposed,
  });

  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE);
  assert.equal(result.selectedGate, "fail_closed_reconcile");
  assert.match(result.reason, /unrecognized/i);
});

// ── Missing or invalid proposedRouting ────────────────────────────────────────

test("evaluateRetrospectiveGate: null proposedRouting returns a fail-closed reconcile result", () => {
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.NONE,
    proposedRouting: null,
  });

  assert.equal(result.routeKind, "needs_reconcile");
  assert.equal(result.selectedGate, "fail_closed_reconcile");
});

test("evaluateRetrospectiveGate: fail-closed reconcile result keeps stable routing-shape defaults", () => {
  const result = evaluateRetrospectiveGate({
    checkpointState: RETROSPECTIVE_CHECKPOINT_STATE.NONE,
    proposedRouting: null,
  });

  assert.equal(result.executionMode, "bounded_handoff");
  assert.equal(result.waitSemantics, "default");
  assert.equal(result.issueAssignmentSeam, "not_applicable");
});

test("evaluateRetrospectiveGate: called with no arguments returns a fail-closed reconcile result", () => {
  const result = evaluateRetrospectiveGate();
  assert.equal(result.routeKind, "needs_reconcile");
});

// ---------------------------------------------------------------------------
// normalizeCheckpointCycleIdentity — cycle identity normalization
// ---------------------------------------------------------------------------

const VALID_IDENTITY = { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: "abc123" };

test("normalizeCheckpointCycleIdentity: accepts a well-formed identity", () => {
  assert.deepEqual(normalizeCheckpointCycleIdentity(VALID_IDENTITY), VALID_IDENTITY);
});

test("normalizeCheckpointCycleIdentity: trims repo and mergeCommit", () => {
  const result = normalizeCheckpointCycleIdentity({ repo: " mfittko/dev-loops ", prNumber: 1613, mergeCommit: " abc123 " });
  assert.deepEqual(result, VALID_IDENTITY);
});

test("normalizeCheckpointCycleIdentity: returns null for a missing repo", () => {
  assert.equal(normalizeCheckpointCycleIdentity({ prNumber: 1613, mergeCommit: "abc123" }), null);
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "", prNumber: 1613, mergeCommit: "abc123" }), null);
});

test("normalizeCheckpointCycleIdentity: returns null for a non-positive-integer prNumber", () => {
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "a/b", prNumber: 0, mergeCommit: "abc123" }), null);
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "a/b", prNumber: -1, mergeCommit: "abc123" }), null);
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "a/b", prNumber: 1.5, mergeCommit: "abc123" }), null);
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "a/b", prNumber: "1613", mergeCommit: "abc123" }), null);
});

test("normalizeCheckpointCycleIdentity: returns null for a missing mergeCommit", () => {
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "a/b", prNumber: 1613, mergeCommit: "" }), null);
  assert.equal(normalizeCheckpointCycleIdentity({ repo: "a/b", prNumber: 1613 }), null);
});

test("normalizeCheckpointCycleIdentity: returns null for null/undefined/non-object input", () => {
  assert.equal(normalizeCheckpointCycleIdentity(null), null);
  assert.equal(normalizeCheckpointCycleIdentity(undefined), null);
  assert.equal(normalizeCheckpointCycleIdentity("mfittko/dev-loops#1613"), null);
});

// ---------------------------------------------------------------------------
// resolveCheckpointStateFromArtifact — durable artifact -> scoped state
// ---------------------------------------------------------------------------

test("resolveCheckpointStateFromArtifact: a genuinely absent artifact (undefined) resolves to NONE", () => {
  assert.equal(resolveCheckpointStateFromArtifact(undefined), RETROSPECTIVE_CHECKPOINT_STATE.NONE);
});

test("resolveCheckpointStateFromArtifact: a present artifact that is the JSON literal null fails closed to MISSING, not NONE", () => {
  // A file that exists on disk but contains the text "null" is present, just
  // malformed — it must not be indistinguishable from a genuinely absent file.
  assert.equal(resolveCheckpointStateFromArtifact(null), RETROSPECTIVE_CHECKPOINT_STATE.MISSING);
});

test("resolveCheckpointStateFromArtifact: a present-but-non-object artifact fails closed to MISSING (not NONE)", () => {
  assert.equal(resolveCheckpointStateFromArtifact("not an object"), RETROSPECTIVE_CHECKPOINT_STATE.MISSING);
  assert.equal(resolveCheckpointStateFromArtifact(42), RETROSPECTIVE_CHECKPOINT_STATE.MISSING);
  assert.equal(resolveCheckpointStateFromArtifact(["state", "complete"]), RETROSPECTIVE_CHECKPOINT_STATE.MISSING);
});

test("resolveCheckpointStateFromArtifact: state 'required' resolves to MISSING regardless of hasNewerMergeSinceCheckpoint", () => {
  const artifact = { state: "required", triggeredAt: "2026-08-08T00:00:00.000Z" };
  assert.equal(
    resolveCheckpointStateFromArtifact(artifact, { hasNewerMergeSinceCheckpoint: false }),
    RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  );
});

test("resolveCheckpointStateFromArtifact: skipped with no newer merge resolves to SKIPPED", () => {
  const artifact = { state: "skipped", skippedAt: "2026-08-08T00:00:00.000Z", reason: "trivial", identity: VALID_IDENTITY };
  assert.equal(
    resolveCheckpointStateFromArtifact(artifact, { hasNewerMergeSinceCheckpoint: false }),
    RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED,
  );
});

test("resolveCheckpointStateFromArtifact: skipped defaults to trusted (hasNewerMergeSinceCheckpoint omitted)", () => {
  const artifact = { state: "skipped", skippedAt: "2026-08-08T00:00:00.000Z", reason: "trivial", identity: VALID_IDENTITY };
  assert.equal(resolveCheckpointStateFromArtifact(artifact), RETROSPECTIVE_CHECKPOINT_STATE.SKIPPED);
});

test("resolveCheckpointStateFromArtifact: stale-skipped (newer merge observed) resolves to MISSING — skipped is cycle-scoped like complete", () => {
  const staleArtifact = { state: "skipped", skippedAt: "2026-08-06T01:00:38.000Z", reason: "trivial docs change", identity: VALID_IDENTITY };
  assert.equal(
    resolveCheckpointStateFromArtifact(staleArtifact, { hasNewerMergeSinceCheckpoint: true }),
    RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  );
});

test("resolveCheckpointStateFromArtifact: matching-complete (no newer merge) resolves to COMPLETE", () => {
  const artifact = { state: "complete", completedAt: "2026-08-08T00:00:00.000Z", notes: "ok", identity: VALID_IDENTITY };
  assert.equal(
    resolveCheckpointStateFromArtifact(artifact, { hasNewerMergeSinceCheckpoint: false }),
    RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE,
  );
});

test("resolveCheckpointStateFromArtifact: complete defaults to trusted (hasNewerMergeSinceCheckpoint omitted)", () => {
  // The caller never verified recency this call (e.g. requireRetrospective
  // disabled) — nothing to compare against, so the recorded completion stands.
  const artifact = { state: "complete", completedAt: "2026-08-08T00:00:00.000Z", notes: "ok", identity: VALID_IDENTITY };
  assert.equal(resolveCheckpointStateFromArtifact(artifact), RETROSPECTIVE_CHECKPOINT_STATE.COMPLETE);
});

test("resolveCheckpointStateFromArtifact: stale-complete (newer merge observed) resolves to MISSING — fail-closed backstop", () => {
  const staleArtifact = { state: "complete", completedAt: "2026-08-06T01:00:38.000Z", notes: "old cycle", identity: VALID_IDENTITY };
  assert.equal(
    resolveCheckpointStateFromArtifact(staleArtifact, { hasNewerMergeSinceCheckpoint: true }),
    RETROSPECTIVE_CHECKPOINT_STATE.MISSING,
  );
});

test("resolveCheckpointStateFromArtifact: state 'none' resolves to NONE", () => {
  assert.equal(resolveCheckpointStateFromArtifact({ state: "none" }), RETROSPECTIVE_CHECKPOINT_STATE.NONE);
});

test("resolveCheckpointStateFromArtifact: an unrecognized state fails closed to MISSING", () => {
  assert.equal(resolveCheckpointStateFromArtifact({ state: "bogus_unknown_state" }), RETROSPECTIVE_CHECKPOINT_STATE.MISSING);
});
