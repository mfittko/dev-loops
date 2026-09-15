import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY } from "../src/loop/timeout-policy.mjs";
import {
  PROHIBITED_COORDINATOR_OBSERVER_OPERATIONS,
  WATCH_KINDS,
  assertNoOverlappingObserver,
  resolveWatchOwnership,
} from "../src/loop/watcher-exclusivity.mjs";

const BOUNDARY = { target: "owner/repo#17", head: "abc123", waitKind: "copilot_review" };
const NOW = 1_000_000_000;
const STALE_AFTER_MS = 1_800_000;
const FRESH_OWNER = {
  runId: "run-1",
  head: "abc123",
  waitKind: "copilot_review",
  updatedAt: new Date(NOW - 1000).toISOString(),
};

function withEvidence(owner, transition) {
  return { boundary: BOUNDARY, evidence: { owner, transition }, now: NOW, staleAfterMs: STALE_AFTER_MS };
}

describe("resolveWatchOwnership fail-closed validation", () => {
  test("rejects a missing boundary", () => {
    assert.throws(() => resolveWatchOwnership({ evidence: { owner: null }, now: NOW, staleAfterMs: STALE_AFTER_MS }), TypeError);
  });

  test("rejects an empty boundary.target", () => {
    assert.throws(
      () => resolveWatchOwnership({ boundary: { ...BOUNDARY, target: "" }, evidence: { owner: null }, now: NOW, staleAfterMs: STALE_AFTER_MS }),
      /boundary\.target/,
    );
  });

  test("rejects a missing boundary.head", () => {
    assert.throws(
      () => resolveWatchOwnership({ boundary: { ...BOUNDARY, head: undefined }, evidence: { owner: null }, now: NOW, staleAfterMs: STALE_AFTER_MS }),
      /boundary\.head/,
    );
  });

  test("rejects a boundary.waitKind not in WATCH_KINDS", () => {
    assert.throws(
      () => resolveWatchOwnership({ boundary: { ...BOUNDARY, waitKind: "poll" }, evidence: { owner: null }, now: NOW, staleAfterMs: STALE_AFTER_MS }),
      /boundary\.waitKind/,
    );
  });

  test("rejects a non-integer now", () => {
    assert.throws(() => resolveWatchOwnership({ boundary: BOUNDARY, evidence: { owner: null }, now: 1.5, staleAfterMs: STALE_AFTER_MS }), /now/);
  });

  test("rejects a negative now", () => {
    assert.throws(() => resolveWatchOwnership({ boundary: BOUNDARY, evidence: { owner: null }, now: -1, staleAfterMs: STALE_AFTER_MS }), /now/);
  });

  test("rejects a non-positive staleAfterMs", () => {
    assert.throws(() => resolveWatchOwnership({ boundary: BOUNDARY, evidence: { owner: null }, now: NOW, staleAfterMs: 0 }), /staleAfterMs/);
  });

  test("rejects a malformed evidence owner missing runId", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence({ ...FRESH_OWNER, runId: "" })),
      /evidence\.owner\.runId/,
    );
  });

  test("rejects a malformed evidence owner missing head", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence({ ...FRESH_OWNER, head: "" })),
      /evidence\.owner\.head/,
    );
  });

  test("rejects a malformed evidence owner with a bad waitKind", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence({ ...FRESH_OWNER, waitKind: "poll" })),
      /evidence\.owner\.waitKind/,
    );
  });

  test("rejects a malformed evidence owner with an unparseable updatedAt", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence({ ...FRESH_OWNER, updatedAt: "not-a-date" })),
      /evidence\.owner\.updatedAt/,
    );
  });

  test("rejects a malformed transition missing status", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "abc123", waitKind: "copilot_review", status: "" })),
      /evidence\.transition\.status/,
    );
  });

  test("rejects a malformed transition with a bad waitKind", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "abc123", waitKind: "poll", status: "changed" })),
      /evidence\.transition\.waitKind/,
    );
  });
});

describe("resolveWatchOwnership owned_waiting", () => {
  test("fresh owner matching head+kind, no transition, is owned_waiting", () => {
    const verdict = resolveWatchOwnership(withEvidence(FRESH_OWNER, null));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, "owned_waiting");
    assert.equal(verdict.advancePhaseAuthorized, false);
    assert.equal(verdict.probeAuthorized, false);
    assert.equal(verdict.secondObserverAuthorized, false);
    assert.equal(verdict.waitTimeoutPolicy, EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY);
  });
});

describe("resolveWatchOwnership transition_ready", () => {
  for (const status of ["changed", "completed"]) {
    test(`fresh owner + matching transition status "${status}" authorizes phase advance`, () => {
      const verdict = resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "abc123", waitKind: "copilot_review", status }));
      assert.equal(verdict.ok, true);
      assert.equal(verdict.status, "transition_ready");
      assert.equal(verdict.advancePhaseAuthorized, true);
      assert.equal(verdict.secondObserverAuthorized, false);
    });
  }

  for (const status of ["timeout", "idle", "pending"]) {
    test(`fresh owner + matching transition status "${status}" stays owned_waiting (no advance)`, () => {
      const verdict = resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "abc123", waitKind: "copilot_review", status }));
      assert.equal(verdict.ok, true);
      assert.equal(verdict.status, "owned_waiting");
      assert.equal(verdict.advancePhaseAuthorized, false);
      assert.equal(verdict.secondObserverAuthorized, false);
    });
  }
});

describe("resolveWatchOwnership blocked branches", () => {
  test("no active owner blocks", () => {
    const verdict = resolveWatchOwnership(withEvidence(null, null));
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "no_active_owner");
    assert.equal(verdict.secondObserverAuthorized, false);
    assert.equal(verdict.advancePhaseAuthorized, false);
    assert.equal(verdict.waitTimeoutPolicy, EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY);
  });

  test("owner head mismatch blocks", () => {
    const verdict = resolveWatchOwnership(withEvidence({ ...FRESH_OWNER, head: "differenthead" }, null));
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "owner_head_mismatch");
    assert.equal(verdict.secondObserverAuthorized, false);
  });

  test("owner waitKind mismatch blocks", () => {
    const verdict = resolveWatchOwnership(withEvidence({ ...FRESH_OWNER, waitKind: "ci" }, null));
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "owner_wait_kind_mismatch");
    assert.equal(verdict.secondObserverAuthorized, false);
  });

  test("stale owner lease blocks", () => {
    const staleOwner = { ...FRESH_OWNER, updatedAt: new Date(NOW - STALE_AFTER_MS - 1).toISOString() };
    const verdict = resolveWatchOwnership(withEvidence(staleOwner, null));
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "owner_lease_stale");
    assert.equal(verdict.secondObserverAuthorized, false);
  });

  test("a future owner updatedAt is not stale", () => {
    const futureOwner = { ...FRESH_OWNER, updatedAt: new Date(NOW + 1000).toISOString() };
    const verdict = resolveWatchOwnership(withEvidence(futureOwner, null));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, "owned_waiting");
  });

  test("malformed transition (head mismatch) with a fresh matching owner blocks", () => {
    const verdict = resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "differenthead", waitKind: "copilot_review", status: "changed" }));
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "stale_or_malformed_transition");
    assert.equal(verdict.secondObserverAuthorized, false);
  });

  test("malformed transition (unknown status) with a fresh matching owner blocks", () => {
    const verdict = resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "abc123", waitKind: "copilot_review", status: "mystery" }));
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "stale_or_malformed_transition");
    assert.equal(verdict.secondObserverAuthorized, false);
  });

  test("transition wait-kind mismatch with a fresh matching owner blocks stale_or_malformed_transition", () => {
    const copilotReviewBoundary = { target: "owner/repo#17", head: "abc123", waitKind: "copilot_review" };
    const verdict = resolveWatchOwnership({
      boundary: copilotReviewBoundary,
      evidence: { owner: FRESH_OWNER, transition: { head: "abc123", waitKind: "ci", status: "changed" } },
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });
    assert.equal(verdict.verdict, "blocked");
    assert.equal(verdict.reason, "stale_or_malformed_transition");
    assert.equal(verdict.secondObserverAuthorized, false);
  });
});

describe("resolveWatchOwnership fail-closed type guards", () => {
  test("rejects a non-object evidence (string)", () => {
    assert.throws(
      () => resolveWatchOwnership({ boundary: BOUNDARY, evidence: "nope", now: NOW, staleAfterMs: STALE_AFTER_MS }),
      TypeError,
    );
  });

  test("rejects a non-object evidence (number)", () => {
    assert.throws(
      () => resolveWatchOwnership({ boundary: BOUNDARY, evidence: 42, now: NOW, staleAfterMs: STALE_AFTER_MS }),
      TypeError,
    );
  });

  test("rejects a non-object, non-null evidence.owner", () => {
    assert.throws(
      () => resolveWatchOwnership({ boundary: BOUNDARY, evidence: { owner: "run-1" }, now: NOW, staleAfterMs: STALE_AFTER_MS }),
      /evidence\.owner must be null or an object/,
    );
  });

  test("rejects a non-object, non-null evidence.transition", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence(FRESH_OWNER, "changed")),
      /evidence\.transition must be null or an object/,
    );
  });

  test("rejects an empty transition.head", () => {
    assert.throws(
      () => resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "", waitKind: "copilot_review", status: "changed" })),
      /evidence\.transition\.head/,
    );
  });
});

describe("resolveWatchOwnership invariant: never a second observer", () => {
  test("secondObserverAuthorized is false across owned_waiting, transition_ready, and blocked", () => {
    const ownedWaiting = resolveWatchOwnership(withEvidence(FRESH_OWNER, null));
    const transitionReady = resolveWatchOwnership(withEvidence(FRESH_OWNER, { head: "abc123", waitKind: "copilot_review", status: "changed" }));
    const blocked = resolveWatchOwnership(withEvidence(null, null));
    assert.equal(ownedWaiting.secondObserverAuthorized, false);
    assert.equal(transitionReady.secondObserverAuthorized, false);
    assert.equal(blocked.secondObserverAuthorized, false);
  });
});

describe("resolveWatchOwnership returned objects are frozen", () => {
  test("blocked verdict boundary is frozen", () => {
    const verdict = resolveWatchOwnership(withEvidence(null, null));
    assert.equal(Object.isFrozen(verdict), true);
    assert.equal(Object.isFrozen(verdict.boundary), true);
  });

  test("owned_waiting verdict owner is frozen", () => {
    const verdict = resolveWatchOwnership(withEvidence(FRESH_OWNER, null));
    assert.equal(Object.isFrozen(verdict), true);
    assert.equal(Object.isFrozen(verdict.owner), true);
  });
});

describe("WATCH_KINDS", () => {
  test("names the three recognized wait kinds", () => {
    assert.deepEqual(WATCH_KINDS, ["copilot_review", "ci", "workflow_run"]);
  });
});

describe("assertNoOverlappingObserver", () => {
  for (const kind of PROHIBITED_COORDINATOR_OBSERVER_OPERATIONS) {
    test(`throws for prohibited kind "${kind}"`, () => {
      assert.throws(() => assertNoOverlappingObserver({ kind }), /coordinator observer operation prohibited under watcher exclusivity/);
    });
  }

  test("throws unknown_coordinator_observer_operation for an unrecognized kind", () => {
    assert.throws(() => assertNoOverlappingObserver({ kind: "read_lease_only" }), /unknown_coordinator_observer_operation: read_lease_only/);
  });

  test("throws TypeError for a missing operation.kind", () => {
    assert.throws(() => assertNoOverlappingObserver({}), TypeError);
  });

  test("throws TypeError for an empty operation.kind", () => {
    assert.throws(() => assertNoOverlappingObserver({ kind: "" }), TypeError);
  });
});
