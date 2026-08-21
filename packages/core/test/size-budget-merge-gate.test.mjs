import assert from "node:assert/strict";
import test from "node:test";

import {
  countUnresolvedHumanChangesRequested,
  resolveHumanReviewDecision,
  resolveSizeBudgetHumanApprovalRequired,
} from "../src/loop/size-budget-merge-gate.mjs";

// ---------------------------------------------------------------------------
// resolveSizeBudgetHumanApprovalRequired
// ---------------------------------------------------------------------------

test("resolveSizeBudgetHumanApprovalRequired: escalate outcome requires human approval by default", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "escalate", touchesT1: false }),
    true,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: touchesT1 requires human approval even on a pass outcome", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "pass", touchesT1: true }),
    true,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: pass outcome with no T1 slice is NOT required", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "pass", touchesT1: false }),
    false,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: block outcome requires human approval (at least as strict as escalate)", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "block", touchesT1: false }),
    true,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: a Copilot-only approval (reviewDecision null after human-scoping) still requires human approval", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: "escalate",
      touchesT1: false,
      reviewDecision: null, // resolveHumanReviewDecision returns null when only Copilot reviewed
      unresolvedChangesRequestedCount: 0,
    }),
    true,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: an unresolved CHANGES_REQUESTED still requires human approval despite a human APPROVED elsewhere", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: "escalate",
      touchesT1: false,
      reviewDecision: "APPROVED",
      unresolvedChangesRequestedCount: 1,
    }),
    true,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: absent/unreadable size evidence fails closed to required", () => {
  assert.equal(resolveSizeBudgetHumanApprovalRequired({}), true);
  assert.equal(resolveSizeBudgetHumanApprovalRequired(), true);
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "not-a-real-outcome", touchesT1: false }),
    true,
  );
  // touchesT1 missing/non-boolean is also an unreadable signal, even with a
  // valid outcome.
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({ sizeOutcome: "pass", touchesT1: undefined }),
    true,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: human APPROVED + zero unresolved CHANGES_REQUESTED + escalate is NOT required", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: "escalate",
      touchesT1: false,
      reviewDecision: "APPROVED",
      unresolvedChangesRequestedCount: 0,
    }),
    false,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: human APPROVED + zero unresolved CHANGES_REQUESTED + T1 touched is NOT required", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: "pass",
      touchesT1: true,
      reviewDecision: "APPROVED",
      unresolvedChangesRequestedCount: 0,
    }),
    false,
  );
});

test("resolveSizeBudgetHumanApprovalRequired: an unreadable unresolvedChangesRequestedCount fails closed", () => {
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: "escalate",
      touchesT1: false,
      reviewDecision: "APPROVED",
      unresolvedChangesRequestedCount: undefined,
    }),
    true,
  );
  assert.equal(
    resolveSizeBudgetHumanApprovalRequired({
      sizeOutcome: "escalate",
      touchesT1: false,
      reviewDecision: "APPROVED",
      unresolvedChangesRequestedCount: "0",
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// resolveHumanReviewDecision / countUnresolvedHumanChangesRequested
// ---------------------------------------------------------------------------

test("resolveHumanReviewDecision: excludes a Copilot review from the decision", () => {
  const reviews = [{ login: "copilot-pull-request-reviewer[bot]", state: "APPROVED" }];
  assert.equal(resolveHumanReviewDecision(reviews), null);
});

test("resolveHumanReviewDecision: a human APPROVED among an excluded Copilot review is APPROVED", () => {
  const reviews = [
    { login: "copilot-pull-request-reviewer[bot]", state: "APPROVED" },
    { login: "alice", state: "APPROVED" },
  ];
  assert.equal(resolveHumanReviewDecision(reviews), "APPROVED");
});

test("resolveHumanReviewDecision: a human CHANGES_REQUESTED wins over another human's APPROVED", () => {
  const reviews = [
    { login: "alice", state: "APPROVED" },
    { login: "bob", state: "CHANGES_REQUESTED" },
  ];
  assert.equal(resolveHumanReviewDecision(reviews), "CHANGES_REQUESTED");
});

test("resolveHumanReviewDecision: a login's LATEST review supersedes an earlier one from the same login", () => {
  const reviews = [
    { login: "alice", state: "CHANGES_REQUESTED" },
    { login: "alice", state: "APPROVED" },
  ];
  assert.equal(resolveHumanReviewDecision(reviews), "APPROVED");
  assert.equal(countUnresolvedHumanChangesRequested(reviews), 0);
});

test("resolveHumanReviewDecision: no reviews at all is null (not a false APPROVED/CHANGES_REQUESTED)", () => {
  assert.equal(resolveHumanReviewDecision([]), null);
  assert.equal(resolveHumanReviewDecision(undefined), null);
});

test("countUnresolvedHumanChangesRequested: counts distinct human logins whose latest review is CHANGES_REQUESTED, excluding Copilot", () => {
  const reviews = [
    { login: "alice", state: "CHANGES_REQUESTED" },
    { login: "bob", state: "CHANGES_REQUESTED" },
    { login: "copilot-pull-request-reviewer[bot]", state: "CHANGES_REQUESTED" },
    { login: "carol", state: "APPROVED" },
  ];
  assert.equal(countUnresolvedHumanChangesRequested(reviews), 2);
});
