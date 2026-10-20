import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { composeConvergedDraftGate, startDeltaSequence } from "../src/loop/pre-push-delta-review.mjs";
import { sha256Hex } from "../src/loop/review-dispatch-plan.mjs";

const A = "a".repeat(40);
const FIX = "b".repeat(40);

const act = (severity, n) => ({ severity, angle: "correctness", summary: `${severity} finding ${n}`, judgeDisposition: "act", file: `f${n}.mjs`, line: n });

// Builds a converged input for an act list: the fixer commit, the judge-pass act list and a clean delta result.
function converged(actList, overrides = {}) {
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList });
  const deltaResult = {
    reviewBaselineHead: A,
    candidateHead: FIX,
    actSetId: sequence.actSetId,
    actionableItems: sequence.actItems.map((item) => ({ ref: item.ref, status: "resolved", evidence: ["fixed"] })),
    newFindings: [],
    widenedReads: [],
    outcome: "locally_clear",
  };
  return { fixerCommit: FIX, actList, deltaResult, ...overrides };
}

const compose = (roundActItems, input = converged(roundActItems), extra = {}) => composeConvergedDraftGate({ gate: "draft_gate", headSha: A, roundActItems, converged: input, ...extra });

describe("composeConvergedDraftGate", () => {
  test("an all-low/nit act list with a clean fresh delta composes converged with no round count or cap input", () => {
    for (const items of [[act("low", 1)], [act("nit", 1)], [act("low", 1), act("nit", 2), act("low", 3)]]) {
      const input = converged(items);
      const marker = compose(items, input);
      assert.deepEqual(marker, { fixerCommit: FIX, deltaDigest: sha256Hex(input.deltaResult) });
      assert.match(marker.deltaDigest, /^sha256:[a-f0-9]{64}$/);
    }
  });

  for (const severity of ["medium", "high", "question"]) {
    test(`a ${severity}-only act list requires a full round`, () => {
      const items = [act(severity, 1)];
      assert.throws(() => compose(items), /needs a full round/);
    });
  }

  test("a mixed act list (one medium, two low) requires a full round", () => {
    const items = [act("medium", 1), act("low", 2), act("low", 3)];
    assert.throws(() => compose(items), /needs a full round/);
  });

  test("an unknown or missing severity requires a full round", () => {
    for (const severity of ["LOW", "critical", undefined, null]) {
      assert.throws(() => compose([act("low", 1), { ...act("low", 2), severity }]), /needs a full round/);
    }
  });

  test("an empty or missing act list fails closed", () => {
    assert.throws(() => compose([], converged([act("low", 1)])), /needs a full round/);
    assert.throws(() => compose(undefined, converged([act("low", 1)])), /needs a full round/);
  });

  test("a gate other than draft_gate fails closed", () => {
    const items = [act("low", 1)];
    for (const gate of ["pre_approval_gate", "review", undefined]) assert.throws(() => compose(items, converged(items), { gate }), /draft_gate only/);
  });

  test("a malformed head or fixer commit fails closed", () => {
    const items = [act("low", 1)];
    assert.throws(() => compose(items, converged(items), { headSha: "abc1234" }), /full reviewed head sha/);
    assert.throws(() => compose(items, converged(items, { fixerCommit: "bbbbbbb" })), /fixerCommit/);
    assert.throws(() => compose(items, converged(items, { fixerCommit: A })), /fixerCommit/);
    assert.throws(() => compose(items, null), /fixerCommit/);
  });

  test("an actList that differs from the posted act items fails closed", () => {
    const posted = [act("low", 1), act("nit", 2)];
    assert.throws(() => compose(posted, converged([act("low", 1)])), /same items/);
    assert.throws(() => compose(posted, converged([act("low", 1), act("medium", 2)])), /low\/nit/);
    assert.throws(() => compose(posted, converged([act("low", 1), act("nit", 3)])), /same items/);
  });

  test("a crafted summary containing the key separator does not equal two separate items", () => {
    const crafted = [{ ...act("low", 1), summary: "x\nlow|y" }];
    const split = [{ ...act("low", 1), summary: "x" }, { ...act("low", 2), summary: "y" }];
    assert.throws(() => compose(crafted, converged(split)), /same items/);
    assert.throws(() => compose(split, converged(crafted)), /same items/);
  });

  test("a stale delta result (candidateHead is not the fixer commit) fails closed", () => {
    const items = [act("low", 1)];
    const input = converged(items);
    input.deltaResult.candidateHead = "c".repeat(40);
    assert.throws(() => compose(items, input), /stale/);
  });

  test("a delta result that is not locally_clear fails closed", () => {
    const items = [act("low", 1)];
    for (const outcome of ["needs_fix", "bounded_out", "bogus", undefined]) {
      const input = converged(items);
      input.deltaResult.outcome = outcome;
      assert.throws(() => compose(items, input), /deltaResult/);
    }
    const unresolved = converged(items);
    unresolved.deltaResult.actionableItems[0].status = "not_resolved";
    assert.throws(() => compose(items, unresolved), /deltaResult is invalid/);
  });

  test("a delta result for another baseline or act set fails closed", () => {
    const items = [act("low", 1)];
    const wrongBaseline = converged(items);
    wrongBaseline.deltaResult.reviewBaselineHead = "d".repeat(40);
    assert.throws(() => compose(items, wrongBaseline), /deltaResult is invalid/);
    const wrongActSet = converged(items);
    wrongActSet.deltaResult.actSetId = "0000000000000000";
    assert.throws(() => compose(items, wrongActSet), /deltaResult is invalid/);
    assert.throws(() => compose(items, converged(items, { deltaResult: null })), /deltaResult is invalid/);
  });
});
