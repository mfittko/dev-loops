import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { composeBodyOnlyConvergedDraftGate } from "../src/loop/fixer-disposition.mjs";

const A = "a".repeat(40);

describe("composeBodyOnlyConvergedDraftGate", () => {
  const bodyItem = (severity, n, extra = {}) => ({ severity, angle: "pr-description", summary: `${severity} body finding ${n}`, judgeDisposition: "act", judgeFix: "edit the body", ...extra });
  const bodyOnly = (roundActItems, extra = {}) => composeBodyOnlyConvergedDraftGate({
    gate: "draft_gate", headSha: A, round: 3, cap: 3, roundActItems, roundFindings: roundActItems,
    converged: { fixerCommit: A, actList: roundActItems }, reviewedBodySha: "old", liveBodySha: "new", ownCommits: 0, ...extra,
  });

  test("a non-locatable medium list with a changed body and no own commit composes", () => {
    const items = [bodyItem("medium", 1)];
    assert.equal(bodyOnly(items).fixerCommit, A);
  });

  test("a pr_body item that names a file composes; the same item without remedyKind is body_item_locatable", () => {
    const withFile = { files: ["docs/x.md"] };
    assert.equal(bodyOnly([bodyItem("medium", 1, { ...withFile, remedyKind: "pr_body" })]).fixerCommit, A);
    assert.throws(() => bodyOnly([bodyItem("medium", 1, withFile)]), /body_item_locatable/);
    assert.throws(() => bodyOnly([bodyItem("medium", 1, { ...withFile, angle: "review-thread", remedyKind: "pr_body" })]), /body_item_locatable/);
    // A review-thread item with no file is never a PR-body item: the refusal names the thread.
    assert.throws(() => bodyOnly([bodyItem("medium", 1, { angle: "review-thread" })]), /body_item_locatable: .*is a review-thread item/);
  });

  test("refuses a question, a fail-open item and a security angle, suffixed or prefixed", () => {
    assert.throws(() => bodyOnly([bodyItem("question", 1)]), /blocked_item/);
    assert.throws(() => bodyOnly([bodyItem("medium", 1, { failOpen: true })]), /blocked_item/);
    for (const angle of ["security", "security-delta-at-abc", "renderer-security", "renderer-security-delta-at-abc"]) {
      assert.throws(() => bodyOnly([bodyItem("medium", 1, { angle })]), /blocked_item/);
    }
  });

  test("accepts medium, low, nit and a capitalized medium, and refuses any other severity as blocked_item", () => {
    for (const severity of ["medium", "low", "nit", "Medium"]) assert.equal(bodyOnly([bodyItem(severity, 1)]).fixerCommit, A, severity);
    for (const severity of ["high", "question", "critical", "", "unknown"]) {
      assert.throws(() => bodyOnly([bodyItem(severity, 1)]), /^Error: blocked_item/, JSON.stringify(severity));
    }
    const noSeverity = bodyItem("medium", 1);
    delete noSeverity.severity;
    assert.throws(() => bodyOnly([noSeverity]), /^Error: blocked_item/);
  });

  test("a non-array actList refuses with the actList message, not a TypeError", () => {
    const items = [bodyItem("medium", 1)];
    for (const actList of ["medium body finding 1", { 0: items[0] }]) {
      assert.throws(() => bodyOnly(items, { converged: { fixerCommit: A, actList } }), /^Error: converged\.actList must be/);
    }
  });

  test("refuses a cap-round blocker among the non-act findings", () => {
    const items = [bodyItem("medium", 1)];
    const deferredHigh = { severity: "high", summary: "deferred high", judgeDisposition: "defer" };
    assert.throws(() => bodyOnly(items, { roundFindings: [...items, deferredHigh] }), /blocked_item/);
  });

  test("composes at every round: below the cap, at the cap and at cap 0; the other checks still apply below the cap", () => {
    const items = [bodyItem("medium", 1)];
    assert.equal(bodyOnly(items, { round: 1, cap: 4 }).fixerCommit, A);
    assert.equal(bodyOnly(items, { round: 2, cap: 4 }).fixerCommit, A);
    assert.equal(bodyOnly(items, { cap: 0 }).fixerCommit, A);
    assert.throws(() => bodyOnly(items, { round: 2, cap: 4, liveBodySha: "old" }), /body_unchanged/);
    assert.throws(() => bodyOnly(items, { gate: "pre_approval_gate" }), /draft_gate only/);
  });

  test("the body_read_unrecorded recovery names the next draft_gate round at every round", () => {
    const items = [bodyItem("medium", 1)];
    for (const [round, cap] of [[2, 4], [4, 4]]) {
      assert.throws(() => bodyOnly(items, { round, cap, reviewedBodySha: null }), (err) => /next draft_gate round/.test(err.message));
    }
  });

  test("refuses an actList mismatch", () => {
    const items = [bodyItem("medium", 1)];
    assert.throws(() => bodyOnly(items, { converged: { fixerCommit: A, actList: [bodyItem("medium", 2)] } }), /actList/);
  });

  test("refuses a delta result and the unchanged, unrecorded and own-commit facts", () => {
    const items = [bodyItem("medium", 1)];
    assert.throws(() => bodyOnly(items, { converged: { fixerCommit: A, actList: items, deltaResult: {} } }), /takes no converged.deltaResult/);
    assert.throws(() => bodyOnly(items, { liveBodySha: "old" }), /body_unchanged/);
    assert.throws(() => bodyOnly(items, { reviewedBodySha: null }), /body_read_unrecorded/);
    assert.throws(() => bodyOnly(items, { ownCommits: 1 }), /own_commit_in_range/);
  });

  test("no body-only refusal text names reviewer-only or a delta review", () => {
    const items = [bodyItem("medium", 1)];
    const refusals = [
      () => bodyOnly([bodyItem("medium", 1, { angle: "review-thread" })]),
      () => bodyOnly([bodyItem("medium", 1, { files: ["docs/x.md"] })]),
      () => bodyOnly(items, { reviewedBodySha: null }),
      () => bodyOnly(items, { round: 4, cap: 4, reviewedBodySha: null }),
      () => bodyOnly(items, { ownCommits: 1 }),
      () => bodyOnly(items, { converged: { fixerCommit: A, actList: items, deltaResult: {} } }),
    ];
    for (const run of refusals) assert.throws(run, (err) => !/reviewer-only|delta review/i.test(err.message));
  });
});
