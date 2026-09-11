import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  isValidGithubLogin,
  resolveMergeClass,
  verifyFreshHumanApproval,
  resolveMergeApprovalDecision,
  resolveCiGreenFromRollup,
  evaluateMergePreconditions,
  MERGE_CLASS,
} from "../src/loop/merge-approval.mjs";

const HEAD = "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const OLD = "0000000000000000000000000000000000000000";

test("isValidGithubLogin rejects boolean, empty, free text; accepts real logins", () => {
  assert.equal(isValidGithubLogin("mfittko"), true);
  assert.equal(isValidGithubLogin("a-b-c"), true);
  assert.equal(isValidGithubLogin("copilot-swe-agent"), true);
  assert.equal(isValidGithubLogin(true), false);
  assert.equal(isValidGithubLogin(""), false);
  assert.equal(isValidGithubLogin("   "), false);
  assert.equal(isValidGithubLogin("has space"), false);
  assert.equal(isValidGithubLogin("-leading"), false);
  assert.equal(isValidGithubLogin("trailing-"), false);
  assert.equal(isValidGithubLogin("a".repeat(40)), false);
  assert.equal(isValidGithubLogin(undefined), false);
});

test("resolveMergeClass: escalate/block/T1/stable-release are escalated; pass is drain", () => {
  assert.equal(resolveMergeClass({ sizeOutcome: "pass", touchesT1: false }), MERGE_CLASS.DRAIN);
  assert.equal(resolveMergeClass({ sizeOutcome: "escalate" }), MERGE_CLASS.ESCALATED);
  assert.equal(resolveMergeClass({ sizeOutcome: "block" }), MERGE_CLASS.ESCALATED);
  assert.equal(resolveMergeClass({ sizeOutcome: "pass", touchesT1: true }), MERGE_CLASS.ESCALATED);
  assert.equal(resolveMergeClass({ sizeOutcome: "pass", stableRelease: true }), MERGE_CLASS.ESCALATED);
});

test("verifyFreshHumanApproval: accepts a head-pinned APPROVED review by the named human", () => {
  const res = verifyFreshHumanApproval({
    approvedBy: "alice",
    currentHeadSha: HEAD,
    reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }],
  });
  assert.equal(res.satisfied, true);
  assert.equal(res.via, "approved_review");
});

test("verifyFreshHumanApproval: accepts a head-pinned operator comment marker", () => {
  const res = verifyFreshHumanApproval({
    approvedBy: "mfittko",
    currentHeadSha: HEAD,
    reviews: [],
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
  });
  assert.equal(res.satisfied, true);
  assert.equal(res.via, "comment_marker");
});

test("verifyFreshHumanApproval: refuses stale approval on an earlier commit", () => {
  const res = verifyFreshHumanApproval({
    approvedBy: "alice",
    currentHeadSha: HEAD,
    reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: OLD }],
  });
  assert.equal(res.satisfied, false);
});

test("verifyFreshHumanApproval: refuses agent/bot-authored approval", () => {
  const review = verifyFreshHumanApproval({
    approvedBy: "copilot-pull-request-reviewer",
    currentHeadSha: HEAD,
    reviews: [{ user: { login: "copilot-pull-request-reviewer" }, state: "APPROVED", commit_id: HEAD }],
  });
  assert.equal(review.satisfied, false);
  const comment = verifyFreshHumanApproval({
    approvedBy: "mfittko",
    currentHeadSha: HEAD,
    comments: [{ user: { login: "Copilot" }, body: `approve merge ${HEAD}` }],
  });
  assert.equal(comment.satisfied, false);
});

test("verifyFreshHumanApproval: a superseded approval (later COMMENTED/CHANGES_REQUESTED by the same login) never satisfies", () => {
  // Reviews arrive oldest-first; the login's LATEST state is authoritative.
  const superseded = verifyFreshHumanApproval({
    approvedBy: "alice",
    currentHeadSha: HEAD,
    reviews: [
      { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD },
      { user: { login: "alice" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
    ],
  });
  assert.equal(superseded.satisfied, false);
  const dismissedToComment = verifyFreshHumanApproval({
    approvedBy: "alice",
    currentHeadSha: HEAD,
    reviews: [
      { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD },
      { user: { login: "alice" }, state: "COMMENTED", commit_id: HEAD },
    ],
  });
  assert.equal(dismissedToComment.satisfied, false);
  // A later re-APPROVED by the same login DOES satisfy (latest wins).
  const reApproved = verifyFreshHumanApproval({
    approvedBy: "alice",
    currentHeadSha: HEAD,
    reviews: [
      { user: { login: "alice" }, state: "CHANGES_REQUESTED", commit_id: HEAD },
      { user: { login: "alice" }, state: "APPROVED", commit_id: HEAD },
    ],
  });
  assert.equal(reApproved.satisfied, true);
});

test("verifyFreshHumanApproval: refuses a wrong-login approval", () => {
  const res = verifyFreshHumanApproval({
    approvedBy: "alice",
    currentHeadSha: HEAD,
    reviews: [{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD }],
    comments: [{ user: { login: "bob" }, body: `approve merge ${HEAD}` }],
  });
  assert.equal(res.satisfied, false);
});

test("verifyFreshHumanApproval: a negating operator comment never reads as approval", () => {
  for (const body of [`disapprove merge ${HEAD}`, `not approve merge ${HEAD}`, `please do not approve merge ${HEAD}`]) {
    const res = verifyFreshHumanApproval({ approvedBy: "mfittko", currentHeadSha: HEAD, comments: [{ user: { login: "mfittko" }, body }] });
    assert.equal(res.satisfied, false, `must reject: ${body}`);
  }
  // A genuine marker opening its own line (after a list/quote prefix) is accepted.
  for (const body of [`approve merge ${HEAD}`, `- approve merge ${HEAD}`, `> approve merge ${HEAD}`, `context\napprove merge ${HEAD}`]) {
    const res = verifyFreshHumanApproval({ approvedBy: "mfittko", currentHeadSha: HEAD, comments: [{ user: { login: "mfittko" }, body }] });
    assert.equal(res.satisfied, true, `must accept: ${JSON.stringify(body)}`);
  }
});

test("verifyFreshHumanApproval: a GitHub App [bot] author never satisfies", () => {
  const review = verifyFreshHumanApproval({ approvedBy: "github-actions", currentHeadSha: HEAD, reviews: [{ user: { login: "github-actions[bot]" }, state: "APPROVED", commit_id: HEAD }] });
  assert.equal(review.satisfied, false);
  const comment = verifyFreshHumanApproval({ approvedBy: "dependabot", currentHeadSha: HEAD, comments: [{ user: { login: "dependabot[bot]" }, body: `approve merge ${HEAD}` }] });
  assert.equal(comment.satisfied, false);
});

test("verifyFreshHumanApproval: a Bot-type author with a bracket-free login never satisfies", () => {
  // A bot account whose login has no [bot] suffix is still excluded by user.type === "Bot".
  const review = verifyFreshHumanApproval({ approvedBy: "some-bot", currentHeadSha: HEAD, reviews: [{ login: "some-bot", type: "Bot", state: "APPROVED", commit_id: HEAD }] });
  assert.equal(review.satisfied, false);
  const comment = verifyFreshHumanApproval({ approvedBy: "some-bot", currentHeadSha: HEAD, comments: [{ login: "some-bot", type: "Bot", body: `approve merge ${HEAD}` }] });
  assert.equal(comment.satisfied, false);
  // The same login as a genuine User does satisfy.
  const human = verifyFreshHumanApproval({ approvedBy: "some-bot", currentHeadSha: HEAD, reviews: [{ login: "some-bot", type: "User", state: "APPROVED", commit_id: HEAD }] });
  assert.equal(human.satisfied, true);
});

test("resolveCiGreenFromRollup: a malformed check entry fails closed", () => {
  assert.equal(resolveCiGreenFromRollup([{}]).green, false);
  assert.equal(resolveCiGreenFromRollup([{ foo: "bar" }]).green, false);
});

test("resolveMergeApprovalDecision: standing authorization allows a drain merge", () => {
  const res = resolveMergeApprovalDecision({ mergeClass: MERGE_CLASS.DRAIN, standingAuthorized: true, freshApproval: { satisfied: false } });
  assert.equal(res.authorized, true);
  assert.equal(res.via, "standing_authorization");
});

test("resolveMergeApprovalDecision: standing authorization does NOT satisfy an escalated merge", () => {
  const res = resolveMergeApprovalDecision({ mergeClass: MERGE_CLASS.ESCALATED, standingAuthorized: true, freshApproval: { satisfied: false, reason: "no approval" } });
  assert.equal(res.authorized, false);
  const withFresh = resolveMergeApprovalDecision({ mergeClass: MERGE_CLASS.ESCALATED, standingAuthorized: false, freshApproval: { satisfied: true, via: "approved_review" } });
  assert.equal(withFresh.authorized, true);
});

test("resolveCiGreenFromRollup: green only on a real all-success rollup (fails closed otherwise)", () => {
  assert.equal(resolveCiGreenFromRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }]).green, true);
  assert.equal(resolveCiGreenFromRollup([{ status: "COMPLETED", conclusion: "FAILURE" }]).green, false);
  assert.equal(resolveCiGreenFromRollup([{ status: "IN_PROGRESS", conclusion: null }]).green, false);
  assert.equal(resolveCiGreenFromRollup([{ state: "SUCCESS" }]).green, true);
  assert.equal(resolveCiGreenFromRollup([{ state: "PENDING" }]).green, false);
  // Fail closed: no-CI ("none"), malformed entries, and a null rollup are not green.
  assert.equal(resolveCiGreenFromRollup([]).green, false);
  assert.equal(resolveCiGreenFromRollup([{}]).green, false);
  assert.equal(resolveCiGreenFromRollup(null).green, false);
  // A loop-derived gate-evidence check is EXCLUDED, so a failing gate-evidence does not block real green CI.
  assert.equal(resolveCiGreenFromRollup([{ name: "gate-evidence", status: "COMPLETED", conclusion: "FAILURE" }, { name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]).green, true);
});

function greenFacts(overrides = {}) {
  return {
    humanApprovedBy: "mfittko",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    ciGreen: { green: true },
    title: "feat: add sanctioned merge wrapper",
    gateEvidence: { ok: true, failures: [] },
    sizeOutcome: "pass",
    touchesT1: false,
    humanReviewDecision: null,
    unresolvedChangesRequestedCount: 0,
    currentHeadSha: HEAD,
    reviews: [],
    comments: [],
    standingAuthorized: true,
    stableRelease: false,
    ...overrides,
  };
}

test("evaluateMergePreconditions: a fully-satisfied drain merge passes", () => {
  const res = evaluateMergePreconditions(greenFacts());
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.mergeClass, MERGE_CLASS.DRAIN);
  assert.equal(res.approvalVia, "standing_authorization");
});

test("evaluateMergePreconditions: each missing precondition is named individually", () => {
  const cases = [
    [{ humanApprovedBy: "" }, "human_approver"],
    [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, "mergeable"],
    [{ ciGreen: { green: false, reason: "x" } }, "ci_green"],
    [{ ciGreen: false }, "ci_green"], // a non-object ciGreen fails closed
    [{ ciGreen: null }, "ci_green"],
    [{ touchesT1: null }, "size_budget_human_approval"], // a missing T1 signal fails closed at the size gate
    [{ title: "WIP: add wrapper" }, "title_markers"],
    [{ title: null }, "title_markers"],
    [{ title: "   " }, "title_markers"],
    [{ gateEvidence: { ok: false, failures: ["missing visible clean draft_gate comment"] } }, "gate_evidence"],
    [{ sizeOutcome: "escalate", humanReviewDecision: null, standingAuthorized: true }, "size_budget_human_approval"],
    [{ standingAuthorized: false }, "merge_approval"],
  ];
  for (const [override, expected] of cases) {
    const res = evaluateMergePreconditions(greenFacts(override));
    assert.equal(res.ok, false, `${expected} should fail`);
    assert.ok(res.failures.some((f) => f.precondition === expected), `expected failing precondition ${expected}, got ${JSON.stringify(res.failures)}`);
  }
});

test("evaluateMergePreconditions: escalated PR with only standing auth is refused", () => {
  const res = evaluateMergePreconditions(greenFacts({ stableRelease: true, standingAuthorized: true }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.precondition === "merge_approval"));
});

test("evaluateMergePreconditions: escalated PR with a fresh operator comment marker passes", () => {
  const res = evaluateMergePreconditions(greenFacts({
    stableRelease: true,
    standingAuthorized: false,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
    // Size-budget gate is a distinct precondition; give it a human APPROVED review too.
    humanReviewDecision: "APPROVED",
    reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }],
  }));
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.mergeClass, MERGE_CLASS.ESCALATED);
});
