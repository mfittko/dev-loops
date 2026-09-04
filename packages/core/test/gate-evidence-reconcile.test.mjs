import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  GATE_EVIDENCE_STATUS_CONTEXT,
  parseRunIdFromTargetUrl,
  resolveGateEvidenceStatusReconcile,
} from "../src/loop/gate-evidence-reconcile.mjs";

describe("gate-evidence-reconcile — parseRunIdFromTargetUrl", () => {
  test("extracts the run id from an Actions-run target_url", () => {
    assert.equal(
      parseRunIdFromTargetUrl("https://github.com/o/r/actions/runs/701"),
      "701",
    );
  });

  test("extracts the run id with a trailing path/query/fragment", () => {
    assert.equal(
      parseRunIdFromTargetUrl("https://github.com/o/r/actions/runs/42/job/7"),
      "42",
    );
    assert.equal(parseRunIdFromTargetUrl("https://github.com/o/r/actions/runs/42?x=1"), "42");
  });

  test("returns null for a non-Actions-run url or missing url", () => {
    assert.equal(parseRunIdFromTargetUrl("https://github.com/o/r/pull/1"), null);
    assert.equal(parseRunIdFromTargetUrl(""), null);
    assert.equal(parseRunIdFromTargetUrl(undefined), null);
    assert.equal(parseRunIdFromTargetUrl(null), null);
  });
});

describe("gate-evidence-reconcile — resolveGateEvidenceStatusReconcile", () => {
  test("re-fires when evidence is satisfied but the status is stuck failure (issue #1935 core race)", () => {
    // The push-before-verdict race: the verdict for the current head IS posted
    // (evidence satisfied), but the required status is still `failure` because
    // the verdict-post re-fire was cancelled/raced. Reconcile re-fires the run
    // that posted the stale status — no manual `gh run rerun` needed.
    const decision = resolveGateEvidenceStatusReconcile({
      evidenceSatisfied: true,
      statusState: "failure",
      runId: "701",
    });
    assert.deepEqual(decision, {
      action: "refire",
      runId: "701",
      reason: "evidence-satisfied-status-stale",
    });
  });

  test("re-fires on a stuck error/pending status too, when evidence is satisfied", () => {
    for (const statusState of ["error", "pending"]) {
      const decision = resolveGateEvidenceStatusReconcile({
        evidenceSatisfied: true,
        statusState,
        runId: "7",
      });
      assert.equal(decision.action, "refire", `statusState=${statusState}`);
      assert.equal(decision.runId, "7");
    }
  });

  test("fail-closed: never re-fires when evidence is genuinely NOT satisfied (AC #3)", () => {
    // A head that truly lacks a clean current-head verdict must keep failing.
    const decision = resolveGateEvidenceStatusReconcile({
      evidenceSatisfied: false,
      statusState: "failure",
      runId: "701",
    });
    assert.deepEqual(decision, {
      action: "none",
      reason: "evidence-not-satisfied-fail-closed",
    });
  });

  test("no-op when the status is already success", () => {
    const decision = resolveGateEvidenceStatusReconcile({
      evidenceSatisfied: true,
      statusState: "success",
      runId: "7",
    });
    assert.deepEqual(decision, { action: "none", reason: "already-success" });
  });

  test("no-op when there is no run id to re-fire (leave it to the native path)", () => {
    const decision = resolveGateEvidenceStatusReconcile({
      evidenceSatisfied: true,
      statusState: "none",
      runId: null,
    });
    assert.deepEqual(decision, { action: "none", reason: "no-run-to-refire" });
  });

  test("missing evidenceSatisfied is treated as not-satisfied (fail-closed default)", () => {
    const decision = resolveGateEvidenceStatusReconcile({ statusState: "failure", runId: "7" });
    assert.equal(decision.action, "none");
    assert.equal(decision.reason, "evidence-not-satisfied-fail-closed");
  });

  test("exports the required commit-status context name", () => {
    assert.equal(GATE_EVIDENCE_STATUS_CONTEXT, "gate-evidence");
  });
});
