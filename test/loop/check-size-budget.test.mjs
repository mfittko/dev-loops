import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSizeBudget,
  matchesGlob,
  parseCheckSizeBudgetCliArgs,
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

test("resolveFileTier: a file matching BOTH t1 and t3 patterns resolves to t1", () => {
  const tiers = {
    t1: { patterns: ["src/billing/*"] },
    t3: { patterns: ["src/billing/*"] },
  };
  assert.equal(resolveFileTier("src/billing/charge.mjs", tiers), "t1");
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
  // Output-contract: waiver.*Valid must not read true under an unwaivable
  // ceiling, even though --waived/--approved-by were both given and wholeLoc
  // (2500) also exceeds default.waiverLoc (1500).
  assert.equal(result.waiver.defaultValid, false);
  assert.equal(result.waiver.t1Valid, false);
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

test("a T1 slice over sliceHardLoc alongside an unwaivable block (absoluteHardLoc) blocks with a valid waiver request present, both the T1 and default-tier reason arms name the unwaivable-block collision", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/billing/charge.mjs\n",
    diffOutput: "",
    // 2500 whole-PR logic LOC: over t1.sliceHardLoc (400), over
    // absoluteHardLoc (2000, unwaivable), and over default.waiverLoc (1500).
    numstatOutput: numstatZ([[2500, 0, "src/billing/charge.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
    approvedBy: "Jane Reviewer",
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.waiver.t1Valid, false);
  assert.equal(result.waiver.defaultValid, false);
  assert.ok(
    result.reasons.some(
      (r) => r.includes("t1.sliceHardLoc") && r.includes("no waiver possible alongside an unwaivable block"),
    ),
  );
  assert.ok(
    result.reasons.some(
      (r) => r.includes("default.waiverLoc") && r.includes("no waiver possible alongside an unwaivable block"),
    ),
  );
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

test("default tier: relaxed default (softLoc: null) never escalates on LOC alone", () => {
  // Named for what it actually drives: SIZE_CONFIG has no t3 patterns, so
  // src/scaffold/widget.mjs resolves to the DEFAULT tier here, not t3 (see
  // the genuine t3-resolution test below for that case).
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
  assert.equal(result.tierLogicLoc.default, 900);
});

test("t3 tier: a file matching a configured t3 pattern resolves its LOC under tierLogicLoc.t3, not default", () => {
  // wholeLoc (900) is still measured against the DEFAULT tier's softLoc
  // (400) regardless of which tier the file resolved to — t3 does not give
  // it a relaxed whole-PR ceiling in Phase 1 (see the config-honesty note on
  // SizeTierConfig); resolveFileTier still routes its LOC into tierLogicLoc.t3.
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/scaffold/widget.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[900, 0, "src/scaffold/widget.mjs"]]),
    sizeConfig: {
      ...SIZE_CONFIG,
      tiers: { ...SIZE_CONFIG.tiers, t3: { patterns: ["src/scaffold/*"] } },
    },
  });
  assert.equal(result.outcome, "escalate");
  assert.equal(result.tierLogicLoc.t3, 900);
  assert.equal(result.tierLogicLoc.default, 0);
});

// ---------------------------------------------------------------------------
// computeSizeBudget — boundary values (strict `>`, not `>=`)
// ---------------------------------------------------------------------------

test("boundary: absoluteHardLoc — AT threshold does not block on it, ABOVE does", () => {
  const atThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[2000, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true, // clears the default.waiverLoc block this whole-PR total also crosses
  });
  assert.ok(!atThreshold.reasons.some((r) => r.includes("absoluteHardLoc")));

  const aboveThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[2001, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
    waived: true,
  });
  assert.equal(aboveThreshold.outcome, "block");
  assert.ok(aboveThreshold.reasons.some((r) => r.includes("absoluteHardLoc") && r.includes("no waiver possible")));
});

test("boundary: default.waiverLoc — AT threshold does not block, ABOVE does", () => {
  const atThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[1500, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.ok(!atThreshold.reasons.some((r) => r.includes("default.waiverLoc")));

  const aboveThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[1501, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(aboveThreshold.outcome, "block");
  assert.ok(aboveThreshold.reasons.some((r) => r.includes("default.waiverLoc") && r.includes("not waived")));
});

test("boundary: default.softLoc — AT threshold does not escalate, ABOVE does", () => {
  const atThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[400, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(atThreshold.outcome, "pass");

  const aboveThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[401, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(aboveThreshold.outcome, "escalate");
  assert.ok(aboveThreshold.reasons.some((r) => r.includes("default.softLoc")));
});

test("boundary: t1.sliceHardLoc — AT threshold does not block, ABOVE does", () => {
  const atThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/billing/charge.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[400, 0, "src/billing/charge.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(atThreshold.outcome, "pass");

  const aboveThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/billing/charge.mjs\n",
    diffOutput: "",
    numstatOutput: numstatZ([[401, 0, "src/billing/charge.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(aboveThreshold.outcome, "block");
  assert.ok(aboveThreshold.reasons.some((r) => r.includes("t1.sliceHardLoc") && r.includes("not waived")));
});

test("boundary: UNCLASSIFIED_BLOCK_RATIO (source-like denominator) — AT threshold does not block on it, ABOVE does", () => {
  // AT: 500 unknown + 500 code -> sourceChangedLines 1000, ratio 500/1000 = 0.5
  // exactly (strict `>`, so this must not trigger the unclassified block).
  const atThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\nM\tapp/models/thing.rb\n",
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[500, 0, "src/foo.mjs"], [500, 0, "app/models/thing.rb"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.ok(!atThreshold.reasons.some((r) => r.includes("unclassified")));

  // ABOVE: 500 code + 501 unknown -> sourceChangedLines 1001, ratio 501/1001
  // > 0.5 -> blocks.
  const aboveThreshold = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\nM\tapp/models/thing.rb\n",
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[500, 0, "src/foo.mjs"], [501, 0, "app/models/thing.rb"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(aboveThreshold.outcome, "block");
  assert.ok(aboveThreshold.reasons.some((r) => r.includes("unclassified") && r.includes("no waiver possible")));
});

// ---------------------------------------------------------------------------
// computeSizeBudget — generated/lockfile/docs/config exclusion
// ---------------------------------------------------------------------------

test("a lockfile with a large numstat count contributes 0 logic LOC alongside a small code change", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tpackage-lock.json\nM\tsrc/foo.mjs\n",
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[5000, 0, "package-lock.json"], [3, 0, "src/foo.mjs"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "pass");
  assert.equal(result.wholeLogicLoc, 3);
  assert.equal(result.tierLogicLoc.default, 3);
});

// ---------------------------------------------------------------------------
// computeSizeBudget — fail-closed on substantially unclassified source
// ---------------------------------------------------------------------------

test("a pure-Ruby-style diff (all files classify unknown) blocks — size budget cannot be computed safely", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tapp/models/subscription.rb\n",
    diffOutput: "",
    numstatOutput: numstatZ([[500, 0, "app/models/subscription.rb"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.wholeLogicLoc, 0);
  assert.ok(result.reasons.some((r) => r.includes("unclassified") && r.includes("no waiver possible")));
});

test("a mostly-JS diff with a little unknown source still computes normally (no block)", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\nM\tweird/thing.xyz\n",
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[300, 0, "src/foo.mjs"], [10, 0, "weird/thing.xyz"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "pass");
  assert.equal(result.wholeLogicLoc, 300);
});

test("a substantially-unclassified diff still blocks when padded with docs+config (docs/config must not dilute the unclassified ratio)", () => {
  // Same shape as the pure-Ruby-only case above, but padded with docs/config
  // lines that contribute 0 logicLoc and are NOT source-like: the ratio
  // denominator is source-like changed lines (code + test + unknown) only,
  // so this padding must not dilute unclassifiedRatio below the block
  // threshold. Before the fix, the denominator was ALL changed lines
  // (300 rb + 300 docs + 100 config = 700, ratio 300/700 = 0.43 -> pass);
  // after the fix, the denominator is source-like lines only (300 rb,
  // docs/config excluded), so ratio is 300/300 = 1.0 -> still blocks.
  const result = computeSizeBudget({
    nameStatusOutput: "M\tapp/models/subscription.rb\nM\tdocs/design.md\nM\tconfig/settings.yml\n",
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([
      [300, 0, "app/models/subscription.rb"],
      [300, 0, "docs/design.md"],
      [100, 0, "config/settings.yml"],
    ]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.wholeLogicLoc, 0);
  assert.ok(result.reasons.some((r) => r.includes("unclassified") && r.includes("no waiver possible")));
});

test("a configured t1 pattern matching a file that classifies unknown (0 LOC) blocks even when unclassified lines are a small share of the diff", () => {
  const result = computeSizeBudget({
    nameStatusOutput: "M\tsrc/foo.mjs\nM\tsrc/billing/charge.rb\n",
    diffOutput: MIXED_DIFF,
    numstatOutput: numstatZ([[500, 0, "src/foo.mjs"], [10, 0, "src/billing/charge.rb"]]),
    sizeConfig: SIZE_CONFIG,
  });
  assert.equal(result.outcome, "block");
  assert.ok(result.reasons.some((r) => r.includes("t1/t3 pattern") && r.includes("no waiver possible")));
});

// ---------------------------------------------------------------------------
// parseCheckSizeBudgetCliArgs
// ---------------------------------------------------------------------------

test("parseCheckSizeBudgetCliArgs: missing --base throws", () => {
  assert.throws(() => parseCheckSizeBudgetCliArgs([]), /--base/);
});

test("parseCheckSizeBudgetCliArgs: a positional argument throws", () => {
  assert.throws(() => parseCheckSizeBudgetCliArgs(["--base", "main", "extra"]), /Unknown argument/);
});

test("parseCheckSizeBudgetCliArgs: a '-'-leading --base throws", () => {
  assert.throws(() => parseCheckSizeBudgetCliArgs(["--base", "-evil"]), /plausible git ref/);
});

test("parseCheckSizeBudgetCliArgs: a '..'-containing --base throws", () => {
  assert.throws(() => parseCheckSizeBudgetCliArgs(["--base", "main..evil"]), /plausible git ref/);
});

test("parseCheckSizeBudgetCliArgs: a '-'-leading --head throws (same denylist as --base)", () => {
  assert.throws(() => parseCheckSizeBudgetCliArgs(["--base", "main", "--head", "-evil"]), /plausible git ref/);
});

test("parseCheckSizeBudgetCliArgs: a '..'-containing --head throws (same denylist as --base)", () => {
  assert.throws(() => parseCheckSizeBudgetCliArgs(["--base", "main", "--head", "feature..evil"]), /plausible git ref/);
});

test("parseCheckSizeBudgetCliArgs: a plain valid --base (and --head) is accepted", () => {
  const options = parseCheckSizeBudgetCliArgs(["--base", "main", "--head", "feature/x"]);
  assert.equal(options.base, "main");
  assert.equal(options.head, "feature/x");
});
