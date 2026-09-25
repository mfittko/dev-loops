import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "bun:test";

import {
  DELTA_CHECKLIST,
  DELTA_MAX_INVOCATIONS,
  buildDeltaInput,
  decideDeltaNextStep,
  deriveDeltaOutcome,
  isDeltaResultFresh,
  resolveDeltaTrigger,
  startDeltaSequence,
  validateDeltaResult,
} from "../src/loop/pre-push-delta-review.mjs";
import { consolidateFanin } from "../src/loop/gate-fanin.mjs";

const A = "aaaaaaa1111111";
const B = "bbbbbbb2222222";
const C = "ccccccc3333333";

// Shape of a `judge-pass --out` act list entry: an enriched finding. The
// sibling-verdict fields below must never reach the delta input.
const ACT_LIST = [
  {
    severity: "medium",
    angle: "correctness",
    summary: "fail-closed check skips an empty list",
    file: "scripts/loop/x.mjs",
    line: 12,
    disposition: "fix",
    judgeDisposition: "act",
    judgeRationale: "in scope of AC 3",
    overallVerdict: "findings_present",
    reviewerVerdict: "clean",
    diff: "@@ -1 +1 @@\n-old\n+new",
  },
  {
    severity: "low",
    angle: "error-handling",
    summary: "missing errno branch for ENOTDIR",
    judgeDisposition: "act",
    judgeRationale: "names a real failure path",
  },
];

function sequence() {
  return startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST });
}

function result(overrides = {}) {
  return {
    reviewBaselineHead: A,
    candidateHead: B,
    actSetId: sequence().actSetId,
    actionableItems: [
      { ref: "act-1", status: "resolved", evidence: ["x.mjs:12 now rejects []"] },
      { ref: "act-2", status: "resolved", evidence: ["x.mjs:30 handles ENOTDIR"] },
    ],
    newFindings: [],
    widenedReads: [],
    outcome: "locally_clear",
    ...overrides,
  };
}

describe("delta trigger", () => {
  test("a committed, unpushed Phase 4 fix for a judge act list triggers delta mode", () => {
    assert.equal(resolveDeltaTrigger({ actItemCount: 2, fixCommitted: true, fixPushed: false }), "delta");
  });

  test("a push with no act-list fix gets no delta review", () => {
    assert.equal(resolveDeltaTrigger({ actItemCount: 0, fixCommitted: true, fixPushed: false }), "none");
    assert.equal(resolveDeltaTrigger({}), "none");
    // Not committed yet, or already pushed: no delta review either.
    assert.equal(resolveDeltaTrigger({ actItemCount: 2, fixCommitted: false }), "none");
    assert.equal(resolveDeltaTrigger({ actItemCount: 2, fixCommitted: true, fixPushed: true }), "none");
  });

  test("an entry the judge did not mark act cannot open a sequence", () => {
    assert.throws(() => startDeltaSequence({ reviewBaselineHead: A, actList: [{ judgeDisposition: "defer", summary: "x" }] }), /expected "act"/);
    assert.throws(() => startDeltaSequence({ reviewBaselineHead: A, actList: [] }), /non-empty judge act list/);
  });
});

describe("pinned baseline", () => {
  test("round one reviews A..B; a second fix C is reviewed as A..C with the same act-set identity", () => {
    const seq = sequence();
    const round1 = buildDeltaInput({ sequence: seq, candidateHead: B });
    assert.equal(round1.diffRange, `${A}..${B}`);
    const round2 = buildDeltaInput({ sequence: seq, candidateHead: C });
    assert.equal(round2.diffRange, `${A}..${C}`);
    assert.equal(round2.reviewBaselineHead, A);
    assert.equal(round2.actSetId, round1.actSetId);
  });

  test("a new gate round opens a new sequence with its own baseline", () => {
    const next = startDeltaSequence({ reviewBaselineHead: C, actList: ACT_LIST.slice(1) });
    assert.equal(buildDeltaInput({ sequence: next, candidateHead: "d" }).diffRange, `${C}..d`);
    assert.notEqual(next.actSetId, sequence().actSetId);
  });
});

describe("delta input", () => {
  test("carries heads, act refs with dispositions, spec identity, surface hints and the checklist", () => {
    const input = buildDeltaInput({ sequence: sequence(), candidateHead: B, specIdentity: "issue-2423@abc" });
    assert.equal(input.reviewBaselineHead, A);
    assert.equal(input.candidateHead, B);
    assert.deepEqual(input.actItems.map((i) => [i.ref, i.judgeDisposition]), [["act-1", "act"], ["act-2", "act"]]);
    assert.equal(input.actItems[0].judgeRationale, "in scope of AC 3");
    assert.equal(input.specIdentity, "issue-2423@abc");
    assert.deepEqual(input.surfaceHints, ["correctness", "error-handling"]);
    assert.deepEqual(input.checklist, [...DELTA_CHECKLIST]);
  });

  test("carries the result shape with widenedReads entries as { path, reason } objects", () => {
    const { resultShape } = buildDeltaInput({ sequence: sequence(), candidateHead: B });
    assert.equal(resultShape.reviewBaselineHead, A);
    assert.equal(resultShape.candidateHead, B);
    assert.equal(resultShape.actSetId, sequence().actSetId);
    assert.deepEqual(Object.keys(resultShape.widenedReads[0]).sort(), ["path", "reason"]);
    assert.deepEqual(Object.keys(resultShape.actionableItems[0]).sort(), ["evidence", "ref", "status"]);
  });

  test("carries no sibling verdict text and no inlined diff bytes", () => {
    const text = JSON.stringify(buildDeltaInput({ sequence: sequence(), candidateHead: B }));
    for (const banned of ["overallVerdict", "reviewerVerdict", "findings_present", "\"clean\"", "@@ -1", "+new"]) {
      assert.ok(!text.includes(banned), `delta input must not carry ${banned}`);
    }
  });
});

describe("result schema", () => {
  test("a well-formed result validates", () => {
    assert.deepEqual(validateDeltaResult(result(), { sequence: sequence() }), []);
  });

  test("widenedReads[] is required and a dependency widening is recorded", () => {
    const missing = result();
    delete missing.widenedReads;
    assert.match(validateDeltaResult(missing, { sequence: sequence() }).join("\n"), /widenedReads\[\] is required/);
    const widened = result({ widenedReads: [{ path: "packages/core/src/loop/gate-fanin.mjs", reason: "the fix calls normalizeSeverity" }] });
    assert.deepEqual(validateDeltaResult(widened, { sequence: sequence() }), []);
    const bare = result({ widenedReads: [{ path: "x.mjs" }] });
    assert.match(validateDeltaResult(bare, { sequence: sequence() }).join("\n"), /needs a path and a reason/);
  });

  test("rejects a missing status, an unknown status, and missing evidence", () => {
    const missing = result({ actionableItems: [{ ref: "act-1", evidence: ["e"] }, { ref: "act-2", status: "resolved", evidence: ["e"] }] });
    assert.match(validateDeltaResult(missing, { sequence: sequence() }).join("\n"), /status is missing/);
    const unknown = result({ actionableItems: [{ ref: "act-1", status: "fixed", evidence: ["e"] }, { ref: "act-2", status: "resolved", evidence: ["e"] }] });
    assert.match(validateDeltaResult(unknown, { sequence: sequence() }).join("\n"), /"fixed" is unknown/);
    const noEvidence = result({ actionableItems: [{ ref: "act-1", status: "resolved", evidence: [] }, { ref: "act-2", status: "resolved", evidence: ["e"] }] });
    assert.match(validateDeltaResult(noEvidence, { sequence: sequence() }).join("\n"), /evidence\[\] must be non-empty/);
  });

  test("rejects an act item left without a status", () => {
    const partial = result({ actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }] });
    assert.match(validateDeltaResult(partial, { sequence: sequence() }).join("\n"), /act item act-2 has no status/);
  });

  test("rejects locally_clear with not_resolved or cannot_verify", () => {
    for (const status of ["not_resolved", "cannot_verify"]) {
      const bad = result({ actionableItems: [{ ref: "act-1", status, evidence: ["e"] }, { ref: "act-2", status: "resolved", evidence: ["e"] }] });
      assert.match(validateDeltaResult(bad, { sequence: sequence() }).join("\n"), /locally_clear requires/, status);
    }
  });

  test("rejects a result bound to another baseline", () => {
    assert.match(validateDeltaResult(result({ reviewBaselineHead: B }), { sequence: sequence() }).join("\n"), /pinned baseline/);
  });

  test("rejects a result bound to another act set: the id covers angle, severity, file, line and summary", () => {
    const moved = startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], line: 13 }, ACT_LIST[1]] });
    assert.notEqual(moved.actSetId, sequence().actSetId);
    assert.match(validateDeltaResult(result(), { sequence: moved }).join("\n"), /actSetId .* does not match/);
  });

  test("rejects blank evidence strings and a new finding without evidence", () => {
    const blank = result({ actionableItems: [{ ref: "act-1", status: "resolved", evidence: [" "] }, { ref: "act-2", status: "resolved", evidence: ["e"] }] });
    assert.match(validateDeltaResult(blank, { sequence: sequence() }).join("\n"), /actionableItems\[0\]\.evidence\[\] must be non-empty strings/);
    const noEvidence = result({ newFindings: [{ severity: "low", summary: "s" }] });
    assert.match(validateDeltaResult(noEvidence, { sequence: sequence() }).join("\n"), /newFindings\[0\]\.evidence\[\] must be non-empty strings/);
  });

  test("rejects duplicate refs in the act list and in the result", () => {
    assert.throws(() => startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], ref: "x" }, { ...ACT_LIST[1], ref: "x" }] }), /duplicate ref "x"/);
    const dup = result({ actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }, { ref: "act-1", status: "resolved", evidence: ["e"] }] });
    assert.match(validateDeltaResult(dup, { sequence: sequence() }).join("\n"), /"act-1" is a duplicate/);
  });

  test("suffixes a repeated ledger fingerprint instead of rejecting the act list", () => {
    const { actItems } = startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], fingerprint: "f" }, { ...ACT_LIST[1], fingerprint: "f" }] });
    assert.deepEqual(actItems.map(({ ref }) => ref), ["f", "f#2"]);
  });
});

describe("exit rule", () => {
  const items = (second) => [
    { ref: "act-1", status: "resolved", evidence: ["e"] },
    { ref: "act-2", status: second, evidence: ["e"] },
  ];
  const cases = [
    ["unresolved low original item", { actionableItems: items("not_resolved"), newFindings: [] }, "needs_fix"],
    ["cannot_verify", { actionableItems: items("cannot_verify"), newFindings: [] }, "needs_fix"],
    ["a new medium finding", { actionableItems: items("resolved"), newFindings: [{ severity: "medium", summary: "s", evidence: ["e"] }] }, "needs_fix"],
    ["a new question finding", { actionableItems: items("resolved"), newFindings: [{ severity: "question", summary: "s", evidence: ["e"] }] }, "needs_fix"],
    ["only a new low finding", { actionableItems: items("resolved"), newFindings: [{ severity: "low", summary: "s", evidence: ["e"] }] }, "locally_clear"],
  ];
  for (const [name, overrides, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      const r = result({ ...overrides, outcome: deriveDeltaOutcome(overrides) });
      assert.equal(r.outcome, expected);
      assert.deepEqual(validateDeltaResult(r, { sequence: sequence() }), []);
      const decision = decideDeltaNextStep({ sequence: sequence(), result: r, invocation: 1, currentHead: B });
      assert.equal(decision.outcome, expected);
      assert.equal(decision.nextStep, expected === "locally_clear" ? "push" : "fix_and_rereview");
    });
  }
});

describe("three-review bound", () => {
  test("three non-clear reviews end bounded_out with the normal push and gate path next, no fourth dispatch", () => {
    const seq = sequence();
    const heads = [B, C, "ddddddd4444444"];
    const dispatched = [];
    let decision;
    for (let invocation = 1; invocation <= DELTA_MAX_INVOCATIONS + 5; invocation++) {
      dispatched.push(invocation);
      const head = heads[invocation - 1];
      const r = result({
        candidateHead: head,
        actionableItems: [{ ref: "act-1", status: "not_resolved", evidence: ["still skips []"] }, { ref: "act-2", status: "resolved", evidence: ["e"] }],
        outcome: "needs_fix",
      });
      decision = decideDeltaNextStep({ sequence: seq, result: r, invocation, currentHead: head });
      if (decision.nextStep !== "fix_and_rereview") break;
    }
    assert.deepEqual(dispatched, [1, 2, 3]);
    assert.equal(decision.outcome, "bounded_out");
    assert.equal(decision.nextStep, "push_to_gate");
    assert.equal(decision.locallyClear, false);
    assert.throws(() => decideDeltaNextStep({ sequence: seq, result: result(), invocation: 4, currentHead: B }), /1\.\.3/);
  });

  test("a fresh, valid locally_clear result at the third review pushes, not bounded_out", () => {
    const decision = decideDeltaNextStep({ sequence: sequence(), result: result(), invocation: DELTA_MAX_INVOCATIONS, currentHead: B });
    assert.equal(decision.outcome, "locally_clear");
    assert.equal(decision.nextStep, "push");
  });

  test("the bound takes precedence over freshness: a stale result at the third review ends bounded_out", () => {
    const decision = decideDeltaNextStep({ sequence: sequence(), result: result(), invocation: DELTA_MAX_INVOCATIONS, currentHead: C });
    assert.equal(decision.fresh, false);
    assert.equal(decision.outcome, "bounded_out");
    assert.equal(decision.nextStep, "push_to_gate");
    assert.equal(decision.locallyClear, false);
  });
});

describe("invalid locally_clear", () => {
  const cases = [
    ["cannot_verify item", { actionableItems: [{ ref: "act-1", status: "cannot_verify", evidence: ["e"] }, { ref: "act-2", status: "resolved", evidence: ["e"] }] }],
    ["unknown new-finding severity", { newFindings: [{ severity: "critical", summary: "s", evidence: ["e"] }] }],
    ["wrong actSetId", { actSetId: "0000000000000000" }],
  ];
  for (const [name, overrides] of cases) {
    test(`a fresh result claiming locally_clear with a ${name} does not push`, () => {
      const decision = decideDeltaNextStep({ sequence: sequence(), result: result(overrides), invocation: 1, currentHead: B });
      assert.equal(decision.fresh, true);
      assert.ok(decision.errors.length > 0);
      assert.equal(decision.locallyClear, false);
      assert.notEqual(decision.nextStep, "push");
    });
  }
});

describe("ledger act refs", () => {
  test("a real judge-pass act entry is referenced by its ledger fingerprint, independent of order", () => {
    const withFingerprints = [{ ...ACT_LIST[0], fingerprint: "b1a52cfd23cd9144" }, { ...ACT_LIST[1], fingerprint: "364d03ab5babb8f5" }];
    const seq = startDeltaSequence({ reviewBaselineHead: A, actList: withFingerprints });
    assert.deepEqual(seq.actItems.map((i) => i.ref), ["b1a52cfd23cd9144", "364d03ab5babb8f5"]);
    const reversed = startDeltaSequence({ reviewBaselineHead: A, actList: [...withFingerprints].reverse() });
    assert.deepEqual(reversed.actItems.map((i) => i.ref), ["364d03ab5babb8f5", "b1a52cfd23cd9144"]);
    assert.equal(startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...withFingerprints[0], ref: "r1" }] }).actItems[0].ref, "r1");
  });
});

describe("freshness", () => {
  test("a new head committed after locally_clear makes the stale result unable to authorize the push", () => {
    const r = result();
    assert.equal(decideDeltaNextStep({ sequence: sequence(), result: r, invocation: 1, currentHead: B }).nextStep, "push");
    assert.equal(isDeltaResultFresh(r, C), false);
    const stale = decideDeltaNextStep({ sequence: sequence(), result: r, invocation: 1, currentHead: C });
    assert.equal(stale.locallyClear, false);
    assert.notEqual(stale.nextStep, "push");
    assert.equal(stale.nextStep, "rereview_current_head");
  });
});

describe("pre-push results never become gate evidence", () => {
  test("fan-in does not accept a delta result as an angle result", () => {
    const fanin = consolidateFanin({ angleResults: [result({ candidateHead: A })] });
    assert.equal(fanin.verdict, "blocked");
    assert.equal(fanin.malformed.length, 1);
    assert.equal(fanin.findings.length, 0);
  });

  test("the delta module performs no I/O: no gate artifact, comment or thread can be written", () => {
    const source = fs.readFileSync(new URL("../src/loop/pre-push-delta-review.mjs", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./gate-fanin.mjs", "node:crypto"]);
  });
});
