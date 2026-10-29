import assert from "node:assert/strict";
import { test } from "bun:test";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "../src/loop/pr-gate-coordination.mjs";
import { DISPOSITION, STATE } from "../src/loop/copilot-loop-state.mjs";

// ADR 0208: after the cap round's fixer pass has landed and its delta has cleared, coordination never returns run_draft_gate.
const head = "abc123456789";
const marker = (verdict) => ({ visible: true, headSha: "abc1234", verdict, contractComplete: true });
const draftAt = (overrides = {}) => evaluatePrGateCoordination({
  pr: 10, currentHeadSha: head, prDraft: true, lifecycleState: STATE.PR_DRAFT, loopDisposition: DISPOSITION.ACTION_REQUIRED, ciStatus: "success",
  draftGate: marker("findings_present"), draftGateMarker: marker("findings_present"), unresolvedGateThreadCount: 0, ...overrides,
});

test("a fixed cap round returns mark_ready_for_review, and never run_draft_gate", () => {
  for (const verdict of ["findings_present", "blocked"]) {
    const fixed = draftAt({ draftCapRoundFixed: true, draftGate: marker(verdict), draftGateMarker: marker(verdict) });
    assert.equal(fixed.nextAction, PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW, verdict);
    assert.ok(!fixed.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  }
  assert.equal(draftAt({ draftCapRoundFixed: false }).nextAction, PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE, "without the cap-round-fixed proof draft_gate still runs");
});

test("a fixed cap round still waits on CI and on unresolved gate threads before ready", () => {
  assert.equal(draftAt({ draftCapRoundFixed: true, ciStatus: "failure" }).nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.equal(draftAt({ draftCapRoundFixed: true, ciStatus: "pending" }).nextAction, PR_CHECKPOINT_ACTION.WAIT_FOR_CI);
  for (const count of [2, -1]) {
    const threads = draftAt({ draftCapRoundFixed: true, unresolvedGateThreadCount: count });
    assert.equal(threads.nextAction, PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS, String(count));
    assert.ok(threads.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
  }
});

test("a ready PR with a fixed cap round and a stale blocked draft marker opens pre_approval_gate, never reconcile_draft_gate", () => {
  const ready = (overrides = {}) => evaluatePrGateCoordination({
    pr: 10, currentHeadSha: "fedcba987654", prDraft: false, lifecycleState: STATE.READY_TO_REREQUEST_REVIEW, loopDisposition: DISPOSITION.CLEAN_CONVERGED,
    sameHeadCleanConverged: true, ciStatus: "success", draftGate: marker("blocked"), draftGateMarker: marker("blocked"),
    preApprovalGate: { visible: false }, preApprovalGateMarker: { visible: false }, ...overrides,
  });
  assert.equal(ready({ draftCapRoundFixed: true }).nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
  assert.equal(ready({ draftCapRoundFixed: false }).nextAction, PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE, "without the proof the evidence guard still reconciles");
});

test("a draft PR past the round cap without a fixed cap round reports blocked, never run_draft_gate", () => {
  const refused = draftAt({ draftRoundRefused: true });
  assert.equal(refused.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.ok(refused.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
  assert.match(refused.reason, /legacy unsealed delta record: rerun the pre-push delta for the cap-round baseline/);
  assert.equal(draftAt({ draftRoundRefused: true, draftCapRoundFixed: true }).nextAction, PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW, "a fixed cap round wins");
});
