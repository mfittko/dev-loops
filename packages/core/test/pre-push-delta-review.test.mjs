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
  threadsToActList,
  validateDeltaResult,
} from "../src/loop/pre-push-delta-review.mjs";
import { consolidateFanin } from "../src/loop/gate-fanin.mjs";
import { sha256Hex } from "../src/loop/review-dispatch-plan.mjs";

function coverageBinding() {
  return { coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: sha256Hex([]).slice(7), handbackBytesDigest: "a".repeat(64),
    origin: { workOrderRef: `fixer:o/r#7:${"a".repeat(40)}:f1-00000000`, workOrderDigest: `sha256:${"b".repeat(64)}`, executionIdentity: "f1-00000000" } };
}

test("membership-only accepts a complete string coverage binding", () => {
  assert.deepEqual(validateDeltaResult({ ...result(), ...coverageBinding() }, { sequence: sequence(), membershipOnly: true }), []);
});

test("membership-only accepts a historical digest-only record", () => {
  assert.deepEqual(validateDeltaResult({ ...result(), siteCoverageDigest: "old" }, { sequence: sequence(), membershipOnly: true }), []);
});

for (const field of ["siteCoverageDigest", "handbackBytesDigest", "origin.workOrderDigest", "origin.executionIdentity", "origin.workOrderRef"]) {
  test(`membership-only rejects singleton-array ${field}`, () => {
    const bound = { ...result(), ...coverageBinding() };
    const target = field.startsWith("origin.") ? bound.origin : bound;
    const key = field.split(".").at(-1);
    target[key] = [target[key]];
    assert.match(validateDeltaResult(bound, { sequence: sequence(), membershipOnly: true }).join(), /coverage binding is missing or malformed/);
  });
}

test("new coverage binding is structural for membership, raw-bound otherwise and cannot exhaust into authority", () => {
  const seq = sequence(), siteCoverage = [];
  const binding = coverageBinding();
  const bound = { ...result(), ...binding };
  assert.deepEqual(validateDeltaResult(bound, { sequence: seq, membershipOnly: true }), []);
  assert.deepEqual(validateDeltaResult({ ...result(), siteCoverageDigest: "old" }, { sequence: seq }), []);
  for (const defect of ["coverageProtocol", "siteCoverageDigest", "handbackBytesDigest", "origin", "all"]) {
    const bad = { ...bound };
    for (const key of defect === "all" ? Object.keys(binding) : [defect]) delete bad[key];
    assert.throws(() => decideDeltaNextStep({ sequence: seq, result: bad, invocation: 3, currentHead: B, siteCoverage, coverageBinding: binding }), /coverage binding/);
    if (defect !== "all") assert.match(validateDeltaResult(bad, { sequence: seq, membershipOnly: true }).join(), /coverage binding/);
  }
  assert.throws(() => decideDeltaNextStep({ sequence: seq, result: bound, invocation: 3, currentHead: B, siteCoverage: [{}] }), /raw coverage/);
  assert.equal(decideDeltaNextStep({ sequence: seq, result: bound, invocation: 3, currentHead: C, siteCoverage, coverageBinding: binding }).nextStep, "push_to_gate");
});

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

test("remediation scope changes the actSetId; legacy lists keep theirs", () => {
  const plain = startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST });
  const scoped = (siteQuery) => startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], siteQuery }, ...ACT_LIST.slice(1)] });
  assert.notEqual(scoped("q1").actSetId, plain.actSetId);
  assert.notEqual(scoped("q1").actSetId, scoped("q2").actSetId);
  assert.equal(startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST }).actSetId, plain.actSetId);
});

test("siblingRemediations of a clustered act item reach the delta input", () => {
  const sib = [{ fingerprint: "fp2", siteQuery: "q2" }];
  const withSib = startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], siteQuery: "q1", siblingRemediations: sib }, ...ACT_LIST.slice(1)] });
  assert.deepEqual(withSib.actItems[0].siblingRemediations, sib);
  const resib = (siteQuery) => startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], siteQuery: "q1", siblingRemediations: [{ fingerprint: "fp2", siteQuery }] }, ...ACT_LIST.slice(1)] });
  assert.notEqual(resib("q2").actSetId, resib("q3").actSetId);
  assert.notEqual(resib("q2").actSetId, startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], siteQuery: "q1" }, ...ACT_LIST.slice(1)] }).actSetId);
});

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

  test("a committed, unpushed thread-route fix with zero act items triggers delta mode", () => {
    // PR 2647 shape: act list [], one unresolved Copilot thread, fix committed and unpushed.
    assert.equal(resolveDeltaTrigger({ actItemCount: 0, threadItemCount: 1, fixCommitted: true, fixPushed: false }), "delta");
    assert.equal(resolveDeltaTrigger({ actItemCount: 0, threadItemCount: 0, fixCommitted: true, fixPushed: false }), "none");
    assert.equal(resolveDeltaTrigger({ threadItemCount: 1, fixCommitted: true, fixPushed: true }), "none");
  });

  test("threadsToActList maps each unresolved thread to one act item keyed by its threadId", () => {
    const payload = { ok: true, repo: "o/r", pr: 7, threads: [{ threadId: "T1", body: " fix it ", isResolved: false, path: "a.mjs", line: 3 }, { threadId: "T2", isResolved: false }] };
    const items = startDeltaSequence({ reviewBaselineHead: A, actList: threadsToActList(payload, { repo: "o/r", pr: 7 }) }).actItems;
    assert.deepEqual(items.map((item) => [item.ref, item.summary, item.file ?? null]), [["T1", "fix it", "a.mjs"], ["T2", "", null]]);
    const reversed = { ...payload, threads: [...payload.threads].reverse() };
    assert.equal(
      startDeltaSequence({ reviewBaselineHead: A, actList: threadsToActList(reversed, { repo: "o/r", pr: 7 }) }).actSetId,
      startDeltaSequence({ reviewBaselineHead: A, actList: threadsToActList(payload, { repo: "o/r", pr: 7 }) }).actSetId,
    );
    assert.throws(() => threadsToActList(payload, { repo: "o/r", pr: 8 }), /not successful list-review-threads/);
    assert.throws(() => threadsToActList({ ...payload, threads: [{ ...payload.threads[0], isResolved: true }] }, { repo: "o/r", pr: 7 }), /not successful list-review-threads/);
  });

  test("thread-route actSetId ignores body excerpts and order; a different thread set changes it", () => {
    const mk = (threads) => startDeltaSequence({ reviewBaselineHead: A, actList: threadsToActList({ ok: true, repo: "o/r", pr: 7, threads }, { repo: "o/r", pr: 7 }) }).actSetId;
    const t = (threadId, body) => ({ threadId, body, isResolved: false, path: "a.mjs", line: 3 });
    assert.equal(mk([t("T1", "long body one"), t("T2", "long body two")]), mk([t("T2", "x"), t("T1", "y")]));
    assert.notEqual(mk([t("T1", "a"), t("T2", "b")]), mk([t("T1", "a"), t("T3", "b")]));
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
    assert.deepEqual(imports.sort(), ["./fixer-disposition.mjs", "./gate-fanin.mjs", "./review-dispatch-plan.mjs", "node:crypto"]);
  });
});

import { unaddressedStaleSurfaceHits, staleSurfaceTruncatedHit, STALE_SURFACE_TRUNCATED_SITE } from "../src/loop/pre-push-delta-review.mjs";
import { collectStaleSurfaceHits } from "../src/loop/stale-surface-hits.mjs";

test("surfaceHints is the union of the act item angles and the reviewed round angles", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList: [{ ...ACT_LIST[0], angle: "contract-surface" }] });
  const input = buildDeltaInput({ sequence, candidateHead: B, roundAngles: ["correctness", "determinism", "coverage", "contract-surface"] });
  assert.deepEqual(input.surfaceHints, ["contract-surface", "correctness", "determinism", "coverage"]);
  assert.deepEqual(buildDeltaInput({ sequence, candidateHead: B }).surfaceHints, ["contract-surface"]);
  assert.deepEqual(buildDeltaInput({ sequence, candidateHead: B }).staleSurfaceHits, []);
});

const RULE_DIFF = [
  "diff --git a/skills/docs/gate-contract.md b/skills/docs/gate-contract.md",
  "--- a/skills/docs/gate-contract.md",
  "+++ b/skills/docs/gate-contract.md",
  "@@ -3,1 +3,0 @@",
  "-The reviewer MUST keep every verdict body short. Another kept sentence stays here.",
  "+Another kept sentence stays here.",
  "diff --git a/packages/x/lib.mjs b/packages/x/lib.mjs",
  "--- a/packages/x/lib.mjs",
  "+++ b/packages/x/lib.mjs",
  "@@ -1,1 +1,1 @@",
  "-export function oldHelperName(a) {",
  "+export function newHelperName(a) {",
].join("\n");

test("collectStaleSurfaceHits reports a removed sentence pinned elsewhere and a renamed identifier still used", () => {
  const grep = (needle, { word }) => {
    if (needle === "The reviewer MUST keep every verdict body short.") return [{ file: "test/contracts/style.test.mjs", line: 23 }];
    if (needle === "oldHelperName" && word) return [{ file: "scripts/use.mjs", line: 4 }];
    return [];
  };
  const hits = collectStaleSurfaceHits({ diffText: RULE_DIFF, grep });
  assert.deepEqual(hits.map((h) => [h.kind, h.needle, h.site]), [
    ["sentence", "The reviewer MUST keep every verdict body short.", "test/contracts/style.test.mjs:23"],
    ["identifier", "oldHelperName", "scripts/use.mjs:4"],
  ]);
  // An identifier that survives in its own file is not removed.
  const survives = (needle) => (needle === "oldHelperName" ? [{ file: "packages/x/lib.mjs", line: 9 }, { file: "scripts/use.mjs", line: 4 }] : []);
  assert.deepEqual(collectStaleSurfaceHits({ diffText: RULE_DIFF, grep: survives }), []);
});

test("an unaddressed stale-surface hit refuses locally_clear; a new finding or a recorded skip reason addresses it", () => {
  const sequence = startDeltaSequence({ reviewBaselineHead: A, actList: [ACT_LIST[1]] });
  const hit = { kind: "sentence", needle: "n", file: "test/contracts/style.test.mjs", line: 23, site: "test/contracts/style.test.mjs:23" };
  const result = { reviewBaselineHead: A, candidateHead: B, actSetId: sequence.actSetId, actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }], newFindings: [], widenedReads: [], outcome: "locally_clear" };
  const errors = (r, extra = {}) => validateDeltaResult(r, { sequence, staleSurfaceHits: [hit], ...extra });
  assert.match(errors(result).join("\n"), /stale-surface/);
  assert.deepEqual(errors({ ...result, newFindings: [{ severity: "low", summary: "pin stale", evidence: ["test/contracts/style.test.mjs:23 still pins it"] }] }), []);
  const siteCoverage = [{ fingerprint: "act-1", returnedSites: [], sites: [{ site: "test/contracts/style.test.mjs:23", status: "skipped", reason: "kept" }] }];
  assert.deepEqual(unaddressedStaleSurfaceHits([hit], { newFindings: [], siteCoverage }), []);
  // A result without hits input stays valid (backward compatible).
  assert.deepEqual(validateDeltaResult(result, { sequence }), []);
});

test("resolved requires no new defect from the remedy: contract names it", () => {
  assert.match(fs.readFileSync(new URL("../../../skills/docs/pre-pr-review-contract.md", import.meta.url), "utf8"), /applied remedy introduces no new finding of severity medium or higher/);
});

import { collectStaleSurface } from "../src/loop/stale-surface-hits.mjs";

const hunk = (file, body, { del = false } = {}) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ ${del ? "/dev/null" : `b/${file}`}`,
  "@@ -1,2 +1,0 @@",
  ...body,
].join("\n");

test("parseDiff attributes a deleted file to its old path and keeps a removed `-- item` line", () => {
  const asked = [];
  const grep = (needle) => { asked.push(needle); return [{ file: "test/pins.test.mjs", line: 3 }]; };
  const deleted = hunk("skills/docs/old.md", ["-The retired contract sentence stays pinned elsewhere."], { del: true });
  assert.deepEqual(collectStaleSurfaceHits({ diffText: deleted, grep }).map((h) => h.needle), ["The retired contract sentence stays pinned elsewhere."]);
  asked.length = 0;
  const dashed = hunk("skills/docs/list.md", ["--- item one of the removed markdown list is long enough."]);
  collectStaleSurfaceHits({ diffText: dashed, grep });
  assert.deepEqual(asked, ["-- item one of the removed markdown list is long enough."]);
});

test("a Markdown line naming a removed identifier does not suppress its stale hits", () => {
  const changelog = ["diff --git a/changes/x.md b/changes/x.md", "--- a/changes/x.md", "+++ b/changes/x.md", "@@ -0,0 +1 @@", "+- Rename oldHelperName to newHelperName"].join("\n");
  const grep = (needle, { word }) => (needle === "oldHelperName" && word ? [{ file: "scripts/use.mjs", line: 4 }] : []);
  const hits = collectStaleSurfaceHits({ diffText: `${RULE_DIFF}\n${changelog}`, grep });
  assert.deepEqual(hits.filter((h) => h.kind === "identifier").map((h) => h.site), ["scripts/use.mjs:4"]);
  // Moved to another code file: still not reported.
  const moved = [RULE_DIFF, "diff --git a/packages/x/other.mjs b/packages/x/other.mjs", "--- a/packages/x/other.mjs", "+++ b/packages/x/other.mjs", "@@ -0,0 +1 @@", "+export function oldHelperName(a) {"].join("\n");
  assert.deepEqual(collectStaleSurfaceHits({ diffText: moved, grep }).filter((h) => h.kind === "identifier"), []);
  // An added caller of the old name is no re-declaration: the stale hit stays.
  const caller = [RULE_DIFF, "diff --git a/packages/x/other.mjs b/packages/x/other.mjs", "--- a/packages/x/other.mjs", "+++ b/packages/x/other.mjs", "@@ -0,0 +1 @@", "+  oldHelperName(a);"].join("\n");
  assert.deepEqual(collectStaleSurfaceHits({ diffText: caller, grep }).filter((h) => h.kind === "identifier").map((h) => h.site), ["scripts/use.mjs:4"]);
});

test("identifiers need a declaration shape, ignore comments and strings, skip common names and honor moves across files", () => {
  const code = (lines) => hunk("packages/x/lib.mjs", lines.map((l) => `-${l}`));
  const grepAt = (n) => () => Array.from({ length: n }, (_, i) => ({ file: `f${i}.mjs`, line: 1 }));
  const needles = (diffText, n = 1) => collectStaleSurfaceHits({ diffText, grep: grepAt(n) }).map((h) => h.needle);
  assert.deepEqual(needles(code(["export function oldHelper(a) {"])), ["oldHelper"]);
  // A call, a comment and a string mention are no declaration.
  assert.deepEqual(needles(code(["  callSomething(plainCallee);", "  // oldCommented removed", '  const msg = "mentionsQuoted";'])), []);
  assert.deepEqual(needles(code(["export function tooCommonName(a) {"]), 6), []);
  assert.equal(collectStaleSurface({ diffText: code(["export function tooCommonName(a) {"]), grep: grepAt(6) }).truncated, true);
  const moved = [code(["export function movedHelper(a) {"]), hunk("packages/x/other.mjs", ["+export function movedHelper(a) {"]).replace("@@ -1,2 +1,0 @@", "@@ -0,0 +1 @@")].join("\n");
  assert.deepEqual(needles(moved), []);
});

test("collectStaleSurface flags truncation and lists test and doc hits before source hits", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ file: i === 24 ? "test/pin.test.mjs" : `src/f${i}.mjs`, line: i + 1 }));
  const out = collectStaleSurface({ diffText: hunk("skills/docs/a.md", ["-The removed sentence is long enough to count here."]), grep: () => many });
  assert.equal(out.truncated, true);
  assert.equal(out.hits.length, 20);
  assert.equal(out.hits[0].file, "test/pin.test.mjs");
  assert.equal(collectStaleSurface({ diffText: hunk("skills/docs/a.md", ["-The removed sentence is long enough to count here."]), grep: () => many.slice(0, 2) }).truncated, false);
});

test("a skipped site addresses a stale-surface hit only with a non-empty reason", () => {
  const hit = { kind: "sentence", needle: "n", file: "a/b.mjs", line: 1, site: "a/b.mjs:1" };
  const coverage = (reason) => [{ fingerprint: "f", returnedSites: [], sites: [{ site: "a/b.mjs:1", status: "skipped", ...(reason === undefined ? {} : { reason }) }] }];
  assert.equal(unaddressedStaleSurfaceHits([hit], { siteCoverage: coverage("kept") }).length, 0);
  assert.equal(unaddressedStaleSurfaceHits([hit], { siteCoverage: coverage("  ") }).length, 1);
  assert.equal(unaddressedStaleSurfaceHits([hit], { siteCoverage: coverage() }).length, 1);
});

test("a hit file is addressed only as a whole path token, never as a path suffix or substring", () => {
  const hit = (file) => ({ kind: "sentence", needle: "n", file, line: 1, site: `${file}:1` });
  const byFinding = (summary) => unaddressedStaleSurfaceHits([hit("skills/dev-loop/SKILL.md")], { newFindings: [{ summary, evidence: [] }] }).length;
  assert.equal(byFinding("stale line at skills/dev-loop/SKILL.md:12"), 0);
  assert.equal(byFinding("see `skills/dev-loop/SKILL.md` for the pin"), 0);
  assert.equal(byFinding("stale line at .claude/skills/dev-loop/SKILL.md:12"), 1);
  const readme = (summary) => unaddressedStaleSurfaceHits([hit("README.md")], { newFindings: [{ summary, evidence: [] }] }).length;
  assert.equal(readme("`README.md` still pins the sentence"), 0);
  assert.equal(readme("stale line in README.md"), 0);
  assert.equal(readme("stale line in docs/README.md"), 1);
  assert.equal(readme("naming skills/dev-loop/README.md here"), 1);
  const skipped = (site) => unaddressedStaleSurfaceHits([hit("README.md")], { siteCoverage: [{ fingerprint: "f", returnedSites: [], sites: [{ site, status: "skipped", reason: "kept" }] }] }).length;
  assert.equal(skipped("README.md"), 0);
  assert.equal(skipped("README.md:1"), 0);
  assert.equal(skipped("docs/README.md:1"), 1);
});

test("a skipped site with a line suffix addresses only a hit on that line", () => {
  const hit = { kind: "sentence", needle: "n", file: "skills/docs/x.md", line: 200, site: "skills/docs/x.md:200" };
  const open = (site, reason = "kept") => unaddressedStaleSurfaceHits([hit], { siteCoverage: [{ fingerprint: "f", returnedSites: [], sites: [{ site, status: "skipped", reason }] }] }).length;
  assert.equal(open("skills/docs/x.md"), 0);
  assert.equal(open("skills/docs/x.md:200"), 0);
  assert.equal(open("skills/docs/x.md:190-210"), 0);
  assert.equal(open("skills/docs/x.md:10"), 1);
  assert.equal(open("skills/docs/x.md:10-20"), 1);
  assert.equal(open("skills/docs/x.md:200", ""), 1);
  const truncated = staleSurfaceTruncatedHit();
  assert.equal(unaddressedStaleSurfaceHits([truncated], { siteCoverage: [{ fingerprint: "f", returnedSites: [], sites: [{ site: STALE_SURFACE_TRUNCATED_SITE, status: "skipped", reason: "kept" }] }] }).length, 0);
});

test("a re-wrapped Markdown paragraph is no removal, and dropped too-common identifiers are named", () => {
  const grep = () => [{ file: "test/pin.test.mjs", line: 3 }];
  const rewrap = [
    "diff --git a/skills/docs/a.md b/skills/docs/a.md", "--- a/skills/docs/a.md", "+++ b/skills/docs/a.md", "@@ -1,2 +1,2 @@",
    "-The retained sentence is long enough to count and", "-wraps over two lines.", "+The retained sentence is long enough", "+to count and wraps over two lines.",
  ].join("\n");
  assert.deepEqual(collectStaleSurface({ diffText: rewrap, grep }).hits, []);
  const many = Array.from({ length: 6 }, (_, i) => ({ file: `f${i}.mjs`, line: 1 }));
  const out = collectStaleSurface({ diffText: hunk("packages/x/lib.mjs", ["-export function tooCommonName(a) {"]), grep: () => many });
  assert.deepEqual(out.truncatedNeedles, [{ kind: "identifier", needle: "tooCommonName", fileCount: 6 }]);
});

test("removed unpunctuated bullets, headings and table rows are separate needles", () => {
  const needles = (body) => { const asked = []; collectStaleSurface({ diffText: hunk("skills/docs/a.md", body), grep: (n) => { asked.push(n); return []; } }); return asked; };
  assert.deepEqual(needles(["-- Lows and nits never block the push", "-- The reviewer reads every changed hunk"]).length, 2);
  assert.deepEqual(needles(["-- Lows and nits never block the push"]), ["Lows and nits never block the push"]);
  assert.deepEqual(needles(["-## The reviewer reads every changed hunk"]), ["The reviewer reads every changed hunk"]);
  assert.deepEqual(needles(["-| Lows and nits never block | The reviewer reads every changed hunk |"]), ["Lows and nits never block", "The reviewer reads every changed hunk"]);
  assert.deepEqual(needles(["-- Lows and nits never block the push", "-- The reviewer reads every changed hunk"]), ["Lows and nits never block the push", "The reviewer reads every changed hunk"]);
});

test("parseDiff reads a TAB-suffixed spaced path and fails closed on an unparseable header or orphan hunk line", () => {
  const grep = () => [{ file: "test/pin.test.mjs", line: 3 }];
  const sentence = "The spaced path sentence is long enough to count.";
  const spaced = ["diff --git a/docs/my guide.md b/docs/my guide.md", "--- a/docs/my guide.md\t", "+++ b/docs/my guide.md\t", "@@ -1 +0,0 @@", `-${sentence}`].join("\n");
  assert.deepEqual(collectStaleSurfaceHits({ diffText: spaced, grep }).map((h) => h.needle), [sentence]);
  const quoted = ["diff --git a/x b/x", '--- "a/caf\\303\\251.md"', '+++ "b/caf\\303\\251.md"', "@@ -1 +0,0 @@", `-${sentence}`].join("\n");
  assert.throws(() => collectStaleSurfaceHits({ diffText: quoted, grep }), /could not be parsed/);
  const orphan = ["diff --git a/x b/x", "@@ -1 +0,0 @@", `-${sentence}`].join("\n");
  assert.throws(() => collectStaleSurfaceHits({ diffText: orphan, grep }), /no parsed file header/);
});
