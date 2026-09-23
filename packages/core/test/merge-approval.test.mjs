import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  isValidGithubLogin,
  resolveMergeClass,
  verifyFreshHumanApproval,
  resolveMergeApprovalDecision,
  resolveCiGreenFromRollup,
  evaluateMergePreconditions,
  evaluateCopilotConvergence,
  COPILOT_CONVERGENCE_STATE,
  COPILOT_ABSENT_REVIEW_DISPOSITION,
  MERGE_CLASS,
} from "../src/loop/merge-approval.mjs";

const HEAD = "3f8a1c9d2b7e4a6f0c5d8e1b3a7f2c9d5e8b1a4c";
const OLD = "0000000000000000000000000000000000000000";

const COPILOT = "copilot-pull-request-reviewer";
const copilotReview = ({ commit = HEAD, body, state = "COMMENTED", submittedAt = "2024-01-10T00:00:00Z" }) => ({ login: COPILOT, state, commit_id: commit, body, submitted_at: submittedAt });

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
    unresolvedChangesRequestedCount: 0,
    currentHeadSha: HEAD,
    reviews: [],
    comments: [],
    standingAuthorized: true,
    stableRelease: false,
    // No current-head Copilot review in the default facts: a sanctioned
    // disposition for this head satisfies copilot_convergence.
    copilotAbsentReviewDisposition: { kind: "copilot_gate_disabled", headSha: HEAD },
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
    [{ sizeOutcome: "escalate", standingAuthorized: true }, "size_budget_human_approval"],
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

test("evaluateMergePreconditions: merge_approval and size_budget_human_approval draw from the same shared resolver — both fail without the comment, both pass with it (AC5)", () => {
  const escalatedNoReview = { sizeOutcome: "escalate", touchesT1: false, standingAuthorized: false, reviews: [] };

  const withoutComment = evaluateMergePreconditions(greenFacts({ ...escalatedNoReview, comments: [] }));
  assert.equal(withoutComment.ok, false);
  assert.ok(withoutComment.failures.some((f) => f.precondition === "merge_approval"));
  assert.ok(withoutComment.failures.some((f) => f.precondition === "size_budget_human_approval"));

  const withComment = evaluateMergePreconditions(greenFacts({
    ...escalatedNoReview,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
  }));
  assert.equal(withComment.ok, true, JSON.stringify(withComment.failures));
  assert.equal(withComment.approvalVia, "comment_marker");
});

test("evaluateMergePreconditions: escalated PR with a fresh operator comment marker passes", () => {
  const res = evaluateMergePreconditions(greenFacts({
    stableRelease: true,
    standingAuthorized: false,
    comments: [{ user: { login: "mfittko" }, body: `approve merge ${HEAD}` }],
    // Size-budget gate is a distinct precondition; give it a human APPROVED review too.
    reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }],
  }));
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.mergeClass, MERGE_CLASS.ESCALATED);
});

test("evaluateMergePreconditions: escalated PR with a head-pinned APPROVED review (no comment) passes via the review branch alone", () => {
  // Proves the review-object branch of verifyFreshHumanApproval is selected and
  // forwarded through the shared resolver to BOTH preconditions independently of
  // the comment-marker path — a regression that ignored a head-pinned APPROVED
  // review would still pass this without this case (AC3 through production).
  const res = evaluateMergePreconditions(greenFacts({
    sizeOutcome: "escalate",
    touchesT1: false,
    standingAuthorized: false,
    comments: [],
    reviews: [{ user: { login: "mfittko" }, state: "APPROVED", commit_id: HEAD }],
  }));
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.approvalVia, "approved_review");
});

// --- Copilot-convergence precondition (#2299) ---

test("evaluateCopilotConvergence: current-head 🟡 Changes recommended blocks (actionable)", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [copilotReview({ body: "### 🟡 Changes recommended\n\nfix the off-by-one." })],
  });
  assert.equal(res.ok, false);
  assert.equal(res.disposition, "changes_recommended");
});

test("evaluateCopilotConvergence: current-head commitId-shaped 🟡 blocks", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [{ login: COPILOT, commitId: HEAD, state: "COMMENTED", body: "### 🟡 Changes recommended" }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.disposition, "changes_recommended");
});

test("evaluateCopilotConvergence: current-head 🔵 Needs a closer look is conductor-overridable (passes)", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [copilotReview({ body: "### 🔵 Needs a closer look\n\ntake another look here." })],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.disposition, "needs_closer_look");
});

test("evaluateCopilotConvergence: current-head 🟢 Approval recommended passes", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [copilotReview({ body: "### 🟢 Approval recommended\n\nlooks good." })],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.disposition, "clean");
});

test("evaluateCopilotConvergence: a stale 🟡 at an EARLIER head is not a current-head verdict (state 3, passes only via a sanctioned disposition)", () => {
  const reviews = [copilotReview({ commit: OLD, body: "### 🟡 Changes recommended\n\nold finding." })];
  const bare = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews });
  assert.equal(bare.ok, false, JSON.stringify(bare));
  assert.equal(bare.state, COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW);
  const disposed = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews, absentReviewDisposition: { kind: "round_cap_clean_fallback", headSha: HEAD } });
  assert.equal(disposed.ok, true, JSON.stringify(disposed));
  assert.equal(disposed.disposition, "round_cap_clean_fallback");
});

test("evaluateCopilotConvergence: the three states produce distinct decisions", () => {
  const clean = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [copilotReview({ body: "### 🟢 Approval recommended" })] });
  const findings = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [copilotReview({ body: "### 🟡 Changes recommended" })] });
  const absent = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [] });
  assert.deepEqual([clean.state, clean.ok], [COPILOT_CONVERGENCE_STATE.CURRENT_HEAD_CLEAN, true]);
  assert.deepEqual([findings.state, findings.ok], [COPILOT_CONVERGENCE_STATE.CURRENT_HEAD_FINDINGS, false]);
  assert.deepEqual([absent.state, absent.ok], [COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW, false]);
});

test("evaluateCopilotConvergence: state 3 with no recorded disposition refuses and names the missing review", () => {
  const res = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [] });
  assert.equal(res.ok, false);
  assert.equal(res.disposition, null);
  assert.match(res.reason, /no current-head Copilot review/);
  for (const kind of Object.values(COPILOT_ABSENT_REVIEW_DISPOSITION)) assert.ok(res.reason.includes(kind), res.reason);
});

for (const kind of Object.values(COPILOT_ABSENT_REVIEW_DISPOSITION)) {
  test(`evaluateCopilotConvergence: state 3 passes via ${kind} only when recorded for the current head`, () => {
    const current = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [], absentReviewDisposition: { kind, headSha: HEAD } });
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.equal(current.state, COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW);
    assert.equal(current.disposition, kind);
    const older = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [], absentReviewDisposition: { kind, headSha: OLD } });
    assert.equal(older.ok, false, JSON.stringify(older));
  });
}

test("evaluateCopilotConvergence: an unsanctioned disposition kind never satisfies state 3", () => {
  const res = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [], absentReviewDisposition: { kind: "whatever", headSha: HEAD } });
  assert.equal(res.ok, false);
});

test("evaluateCopilotConvergence: a head advance after a clean review returns to state 3", () => {
  const reviews = [copilotReview({ body: "### 🟢 Approval recommended" })];
  assert.equal(evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews }).state, COPILOT_CONVERGENCE_STATE.CURRENT_HEAD_CLEAN);
  const NEXT = "1111111111111111111111111111111111111111";
  const advanced = evaluateCopilotConvergence({ currentHeadSha: NEXT, reviews });
  assert.equal(advanced.state, COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW);
  assert.equal(advanced.ok, false);
});

test("evaluateCopilotConvergence: a later same-head 🟢 supersedes an earlier same-head 🟡", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [
      copilotReview({ body: "### 🟡 Changes recommended\n\nearlier finding.", submittedAt: "2024-01-10T00:00:00Z" }),
      copilotReview({ body: "### 🟢 Approval recommended\n\nnow clean.", submittedAt: "2024-01-10T01:00:00Z" }),
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.disposition, "clean");
});

test("evaluateCopilotConvergence: an equal-timestamp same-head tie folds toward the blocking 🟡 (fail-closed, order-independent)", () => {
  const tie = "2024-01-10T00:00:00Z";
  // Both array orders must block: selection must not depend on array order.
  for (const reviews of [
    [copilotReview({ body: "### 🟡 Changes recommended\n\nx", submittedAt: tie }), copilotReview({ body: "### 🟢 Approval recommended", submittedAt: tie })],
    [copilotReview({ body: "### 🟢 Approval recommended", submittedAt: tie }), copilotReview({ body: "### 🟡 Changes recommended\n\nx", submittedAt: tie })],
  ]) {
    const res = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.disposition, "changes_recommended");
  }
});

test("evaluateCopilotConvergence: an invalid-timestamp 🟡 is not superseded by a valid-timestamp 🟢 (raw-string compare mirrors the loop; no fail-open)", () => {
  // The loop's summarizeCopilotReviews compares the RAW submittedAt string, so an
  // unparseable submittedAt is kept as-is, not coerced to null. Parsing here would
  // make the malformed 🟡 drop out and let the valid 🟢 supersede — a fail-open.
  // Both array orders must block, matching the loop.
  for (const reviews of [
    [copilotReview({ body: "### 🟡 Changes recommended\n\nx", submittedAt: "not-a-timestamp" }), copilotReview({ body: "### 🟢 Approval recommended", submittedAt: "2024-01-10T00:00:00Z" })],
    [copilotReview({ body: "### 🟢 Approval recommended", submittedAt: "2024-01-10T00:00:00Z" }), copilotReview({ body: "### 🟡 Changes recommended\n\nx", submittedAt: "not-a-timestamp" })],
  ]) {
    const res = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.disposition, "changes_recommended");
  }
});

test("evaluateCopilotConvergence: a trailing PENDING draft never clears a submitted current-head 🟡", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [
      copilotReview({ body: "### 🟡 Changes recommended\n\nx", submittedAt: "2024-01-10T00:00:00Z" }),
      copilotReview({ body: "", state: "PENDING", submittedAt: null }),
    ],
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.disposition, "changes_recommended");
});

test("evaluateCopilotConvergence: a present current-head headerless review classifies NONE and passes", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [copilotReview({ body: "" })],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.disposition, "none");
});

test("evaluateCopilotConvergence: an unrecognized current-head disposition fails closed", () => {
  const res = evaluateCopilotConvergence({
    currentHeadSha: HEAD,
    reviews: [copilotReview({ body: "### 🟣 Deferred to a domain expert\n\nfuture header." })],
  });
  assert.equal(res.ok, false);
  assert.equal(res.disposition, "unrecognized");
});

test("evaluateCopilotConvergence: an unknown head fails closed (cannot pin a disposition)", () => {
  for (const currentHeadSha of [null, "", "   ", undefined]) {
    const res = evaluateCopilotConvergence({ currentHeadSha, reviews: [copilotReview({ body: "### 🟢 Approval recommended" })] });
    assert.equal(res.ok, false, `head=${JSON.stringify(currentHeadSha)} should fail closed`);
  }
});

test("evaluateCopilotConvergence: a human review never counts as a current-head Copilot review", () => {
  const res = evaluateCopilotConvergence({ currentHeadSha: HEAD, reviews: [{ user: { login: "alice" }, state: "APPROVED", commit_id: HEAD }] });
  assert.equal(res.state, COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW);
  assert.equal(res.ok, false);
});

test("evaluateMergePreconditions: no current-head Copilot review and no disposition refuses via copilot_convergence", () => {
  const res = evaluateMergePreconditions(greenFacts({ copilotAbsentReviewDisposition: null }));
  assert.equal(res.ok, false);
  assert.deepEqual(res.failures.map((f) => f.precondition), ["copilot_convergence"]);
  assert.equal(res.copilotConvergenceState, COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW);
});

test("evaluateMergePreconditions: records the convergence state and the disposition that satisfied it", () => {
  const absent = evaluateMergePreconditions(greenFacts({ copilotAbsentReviewDisposition: { kind: "docs_only_suppression", headSha: HEAD } }));
  assert.equal(absent.ok, true, JSON.stringify(absent.failures));
  assert.equal(absent.copilotConvergenceState, COPILOT_CONVERGENCE_STATE.NO_CURRENT_HEAD_REVIEW);
  assert.equal(absent.copilotDisposition, "docs_only_suppression");
  const clean = evaluateMergePreconditions(greenFacts({ reviews: [copilotReview({ body: "### 🟢 Approval recommended" })] }));
  assert.equal(clean.copilotConvergenceState, COPILOT_CONVERGENCE_STATE.CURRENT_HEAD_CLEAN);
  assert.equal(clean.copilotDisposition, "clean");
});

test("evaluateMergePreconditions: a current-head Copilot 🟡 refuses via the named copilot_convergence precondition", () => {
  const res = evaluateMergePreconditions(greenFacts({
    reviews: [copilotReview({ body: "### 🟡 Changes recommended\n\nfix this." })],
  }));
  assert.equal(res.ok, false);
  assert.ok(res.failures.some((f) => f.precondition === "copilot_convergence"), JSON.stringify(res.failures));
});

test("evaluateMergePreconditions: a current-head Copilot 🔵 does not block (conductor-overridable)", () => {
  const res = evaluateMergePreconditions(greenFacts({
    reviews: [copilotReview({ body: "### 🔵 Needs a closer look\n\nhave a look." })],
  }));
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  // The disposition is recorded on the verdict so an overridden 🔵 merge is auditable.
  assert.equal(res.copilotDisposition, "needs_closer_look");
});

test("evaluateMergePreconditions: a current-head Copilot 🟢 passes the copilot_convergence precondition", () => {
  const res = evaluateMergePreconditions(greenFacts({
    reviews: [copilotReview({ body: "### 🟢 Approval recommended\n\ngood." })],
  }));
  assert.equal(res.ok, true, JSON.stringify(res.failures));
});
