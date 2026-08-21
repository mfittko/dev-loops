import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSizeBudget,
  matchesGlob,
  parseNumstatZ,
  resolveFileTier,
} from "../../scripts/loop/check-size-budget.mjs";

// ---------------------------------------------------------------------------
// Fixtures — small, realistic diff/name-status/numstat inputs. A MIXED diff
// (code + test files present) needs real hunk content so the shared
// classifier (analyzeDiff) doesn't fall back to "ambiguous"; a single-
// category diff needs none (T0-only inference already resolves it).
// ---------------------------------------------------------------------------

const MIXED_DIFF = `diff --git a/src/foo.mjs b/src/foo.mjs
index aaa..bbb 100644
--- a/src/foo.mjs
+++ b/src/foo.mjs
@@ -1,2 +1,5 @@
 function foo() {
+  doWork();
+  doMoreWork();
+  doEvenMoreWork();
   return 1;
 }
diff --git a/test/foo.test.mjs b/test/foo.test.mjs
index ccc..ddd 100644
--- a/test/foo.test.mjs
+++ b/test/foo.test.mjs
@@ -1,1 +1,3 @@
 test("foo", () => {
+  assert.equal(foo(), 1);
+  assert.ok(true);
 });
`;
const MIXED_NAME_STATUS = "M\tsrc/foo.mjs\nM\ttest/foo.test.mjs\n";

function numstatZ(entries) {
  return entries.map(([added, deleted, path]) => `${added}\t${deleted}\t${path}`).join("\0") + "\0";
}

// ---------------------------------------------------------------------------
// matchesGlob / resolveFileTier
// ---------------------------------------------------------------------------

test("matchesGlob: literal path matches exactly, nothing else", () => {
  assert.equal(matchesGlob("config/routes.rb", "config/routes.rb"), true);
  assert.equal(matchesGlob("config/routes2.rb", "config/routes.rb"), false);
});

test("matchesGlob: single '*' matches within one path segment only", () => {
  assert.equal(matchesGlob("app/models/subscription_plan.rb", "app/models/subscription*"), true);
  assert.equal(matchesGlob("app/models/nested/subscription_plan.rb", "app/models/subscription*"), false);
});

test("matchesGlob: '**' matches across path segments", () => {
  assert.equal(matchesGlob("app/frontends/web/index.js", "app/frontends/**"), true);
  assert.equal(matchesGlob("app/frontends/index.js", "app/frontends/**"), true);
});

test("resolveFileTier: t1 pattern wins over t3, unmatched falls to default", () => {
  const tiers = {
    t1: { patterns: ["src/billing/*"] },
    t3: { patterns: ["src/scaffold/*"] },
  };
  assert.equal(resolveFileTier("src/billing/charge.mjs", tiers), "t1");
  assert.equal(resolveFileTier("src/scaffold/widget.mjs", tiers), "t3");
  assert.equal(resolveFileTier("src/other/thing.mjs", tiers), "default");
});

test("resolveFileTier: no tiers configured -> every file is default", () => {
  assert.equal(resolveFileTier("src/billing/charge.mjs", {}), "default");
  assert.equal(resolveFileTier("src/billing/charge.mjs", undefined), "default");
});

// ---------------------------------------------------------------------------
// parseNumstatZ
// ---------------------------------------------------------------------------

test("parseNumstatZ: plain files", () => {
  const out = parseNumstatZ(numstatZ([[12, 3, "src/foo.mjs"], [10, 0, "test/foo.test.mjs"]]));
  assert.deepEqual(out, [
    { path: "src/foo.mjs", added: 12, deleted: 3 },
    { path: "test/foo.test.mjs", added: 10, deleted: 0 },
  ]);
});

test("parseNumstatZ: rename record resolves to the NEW path", () => {
  const out = parseNumstatZ("0\t0\t\0old.txt\0new.txt\0");
  assert.deepEqual(out, [{ path: "new.txt", added: 0, deleted: 0 }]);
});

test("parseNumstatZ: binary file ('-' counts) contributes zero LOC", () => {
  const out = parseNumstatZ("-\t-\tbin.dat\0");
  assert.deepEqual(out, [{ path: "bin.dat", added: 0, deleted: 0 }]);
});

test("parseNumstatZ: empty input -> no files", () => {
  assert.deepEqual(parseNumstatZ(""), []);
});

// ---------------------------------------------------------------------------
// computeSizeBudget — outcomes
// ---------------------------------------------------------------------------

const SIZE_CONFIG = {
  testDiscount: 0.25,
  absoluteHardLoc: 2000,
  tiers: {
    default: { softLoc: 400, waiverLoc: 1500 },
    t1: { patterns: ["src/billing/*"], sliceHardLoc: 400 },
  },
};

test("pass: small mixed change stays under softLoc", () => {
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[3, 0, "src/foo.mjs"], [2, 0, "test/foo.test.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "pass");
  assert.equal(result.ok, true);
  // 3 code + 0.25*2 test = 3.5 -> rounds to 4
  assert.equal(result.wholeLogicLoc, 4);
  assert.deepEqual(result.reasons, []);
});

test("escalate: whole-PR logic LOC over softLoc but within waiverLoc", () => {
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[500, 0, "src/foo.mjs"], [40, 0, "test/foo.test.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "escalate");
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("default.softLoc")));
});

test("block, no waiver possible: whole-PR logic LOC over absoluteHardLoc even when waived", () => {
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[2500, 0, "src/foo.mjs"], [0, 0, "test/foo.test.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
    approvedBy: "Jane Reviewer",
  });
  assert.equal(result.outcome, "block");
  assert.ok(result.reasons.some((r) => r.includes("absoluteHardLoc") && r.includes("no waiver possible")));
});

test("block, no waiver possible: config errors present, regardless of waiver", () => {
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[3, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    configErrors: [{ path: "gates.size.tiers", message: "invalid" }],
    waived: true,
    approvedBy: "Jane Reviewer",
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.configErrorCount, 1);
  assert.ok(result.reasons.some((r) => r.includes("config errors present")));
});

test("block, no waiver possible: unclassifiable (ambiguous) diff", () => {
  // A mixed diff with NO hunk content to classify from (e.g. the best-effort
  // full-diff capture degraded to empty) is unclassifiable per the shared
  // classifier — mirrors write-gate-context.mjs's documented degrade path.
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: "",
    numstatOutput: numstatZ([[3, 0, "src/foo.mjs"], [2, 0, "test/foo.test.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
    approvedBy: "Jane Reviewer",
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.ambiguous, true);
  assert.ok(result.reasons.some((r) => r.includes("unclassifiable")));
});

test("block: T1 slice over sliceHardLoc, not waived", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/billing/charge.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[500, 0, "src/billing/charge.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.t1SliceLoc, 500);
  assert.ok(result.reasons.some((r) => r.includes("t1.sliceHardLoc") && r.includes("not waived")));
});

test("T1 waiver WITHOUT a named approver stays blocked", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/billing/charge.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[500, 0, "src/billing/charge.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
    // approvedBy omitted
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.waiver.t1Valid, false);
  assert.ok(result.reasons.some((r) => r.includes("requires --approved-by naming a human approver")));
});

test("T1 waiver WITH a named approver is valid and clears the slice-hard-loc block", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/billing/charge.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[500, 0, "src/billing/charge.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
    approvedBy: "Jane Reviewer",
  });
  // 500 whole-PR logic LOC also exceeds default.softLoc (400), so the waiver
  // clears the BLOCK but the whole-PR total still escalates on its own.
  assert.equal(result.outcome, "escalate");
  assert.equal(result.waiver.t1Valid, true);
  assert.equal(result.waiver.approvedBy, "Jane Reviewer");
  assert.ok(result.reasons.some((r) => r.includes("waived by Jane Reviewer")));
  assert.ok(!result.reasons.some((r) => r.includes("t1.sliceHardLoc") && r.includes("not waived")));
});

test("default-tier waiver: over waiverLoc blocks when not waived", () => {
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[1600, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "block");
  assert.ok(result.reasons.some((r) => r.includes("default.waiverLoc") && r.includes("not waived")));
});

test("default-tier waiver: granting it clears the block but the escalation still stands", () => {
  const result = computeSizeBudget({
    nameStatusOutput: MIXED_NAME_STATUS,
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[1600, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
  });
  // A waived default-tier over-budget PR still escalates the review contract
  // (author annotations, human review, no Copilot-clean) — the waiver only
  // lifts the BLOCK, never the raised bar.
  assert.equal(result.outcome, "escalate");
  assert.equal(result.waiver.defaultValid, true);
  assert.ok(result.reasons.some((r) => r.includes("default.waiverLoc") && r.includes("waived")));
});

test("t3 tier: relaxed default (softLoc: null) never escalates on LOC alone", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/scaffold/widget.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[900, 0, "src/scaffold/widget.mjs"]]),
    sizeConfig: {
      ...SIZE_CONFIG,
      tiers: { ...SIZE_CONFIG.tiers, default: { softLoc: null, waiverLoc: null } },
    },
  });
  assert.equal(result.outcome, "pass");
  assert.equal(result.wholeLogicLoc, 900);
});
