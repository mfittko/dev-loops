// gates.fanout.sizeTiers (issue 3166, ADR 0278): schema, the pure eligibility
// helper, tier packing in resolveFanoutDispatch, the recorded plan, and the
// per-angle Claude model split.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";
import { expandDispatchUnits, isPackedUnitName } from "../../scripts/github/_dispatch-units.mjs";
import { resolveFanoutDispatch } from "../../scripts/github/write-gate-context.mjs";
import { DevLoopConfigSchema, loadDevLoopConfig, resolveFanoutGroups, resolveFanoutSizeTier, resolveGateAngleContract } from "@dev-loops/core/config";
import { fanoutReviewerPairingError } from "@dev-loops/core/loop/gate-fanin";
import { NEUTRAL_RUN_ID_VAR, RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const { config: REPO_CONFIG } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
const piRunIdMarker = RUN_ID_MARKERS.find((m) => m !== NEUTRAL_RUN_ID_VAR);
const claudeEnv = () => ({ ...process.env, CLAUDECODE: "1" });
const piEnv = () => {
  const env = { ...process.env, [piRunIdMarker]: "pi-run-1" };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  return env;
};

const codexEnv = () => {
  const env = { ...process.env, CODEX_THREAD_ID: "codex-thread-1" };
  delete env.CLAUDECODE;
  return env;
};

const TIER = { maxWholeLogicLoc: 40, maxAnglesPerUnit: 10 };
const SIZE = (wholeLogicLoc, extra = {}) => ({ outcome: "pass", wholeLogicLoc, tierLogicLoc: { t1: 0 }, ...extra });
const FILES = ["docs/guide.md", "test/a.test.mjs"];
// Light mode off: a light-eligible round is treated as escalated, which the escalation tests opt into.
const BASE_CONFIG = { ...REPO_CONFIG, localImplementation: { ...REPO_CONFIG.localImplementation, lightMode: { ...REPO_CONFIG.localImplementation?.lightMode, enabled: false } } };
const LIGHT_CONFIG = { ...REPO_CONFIG, localImplementation: { ...REPO_CONFIG.localImplementation, lightMode: { enabled: true, maxFiles: 3, maxLines: 200 } } };
const withFanout = (fanout, config = BASE_CONFIG) => ({ ...config, gates: { ...config.gates, fanout: { ...config.gates.fanout, ...fanout } } });
const POOL = resolveGateAngleContract(REPO_CONFIG, "draft").pool;
const TIERED = withFanout({ sizeTiers: [TIER] });
const facts = (over = {}) => ({ sizeOutcome: SIZE(30), changedFiles: FILES, ...over });
const dispatch = (config, gate, angles, env, over = {}) => resolveFanoutDispatch(config, gate, angles, { env, ...facts(), ...over });
const units = (plan) => expandDispatchUnits(plan.pendingGroups, new Set(), plan.unitBound);

describe("gates.fanout.sizeTiers schema (AC4, AC1)", () => {
  const parse = (fanout) => DevLoopConfigSchema.safeParse({ version: 1, gates: { fanout } });
  test("accepts a maxAnglesPerUnit of 5", () => assert.equal(parse({ sizeTiers: [{ maxWholeLogicLoc: 40, maxAnglesPerUnit: 5 }] }).success, true));
  test("accepts ordered tiers with an optional maxFiles", () => {
    assert.equal(parse({ sizeTiers: [TIER, { maxWholeLogicLoc: 80, maxAnglesPerUnit: 6, maxFiles: 3 }] }).success, true);
  });
  for (const [label, fanout] of [
    ["per-angle mode together with sizeTiers", { mode: "per-angle", sizeTiers: [TIER] }],
    ["unordered tiers", { sizeTiers: [{ maxWholeLogicLoc: 80, maxAnglesPerUnit: 5 }, TIER] }],
    ["equal tier ceilings", { sizeTiers: [TIER, TIER] }],
    ["a non-integer maxWholeLogicLoc", { sizeTiers: [{ maxWholeLogicLoc: 40.5, maxAnglesPerUnit: 5 }] }],
    ["a non-integer maxAnglesPerUnit", { sizeTiers: [{ maxWholeLogicLoc: 40, maxAnglesPerUnit: 2.5 }] }],
    ["a maxAnglesPerUnit above 10", { sizeTiers: [{ maxWholeLogicLoc: 40, maxAnglesPerUnit: 11 }] }],
    ["a maxAnglesPerUnit of 4", { sizeTiers: [{ maxWholeLogicLoc: 40, maxAnglesPerUnit: 4 }] }],
    ["an empty sizeTiers list", { sizeTiers: [] }],
  ]) {
    test(`rejects ${label}`, () => assert.equal(parse(fanout).success, false));
  }
});

describe("resolveFanoutSizeTier eligibility (AC4, AC5)", () => {
  const apply = (over = {}, config = TIERED, gate = "draft") => resolveFanoutSizeTier(config, gate, facts(over));
  test("applies at the tier limit and below, never above", () => {
    assert.equal(apply({ sizeOutcome: SIZE(40) }).reason, "size_tier_applied");
    assert.equal(apply({ sizeOutcome: SIZE(39) }).reason, "size_tier_applied");
    assert.deepEqual(apply({ sizeOutcome: SIZE(41) }), { tier: null, reason: "above_size_tiers" });
  });
  test("selects the first tier whose ceiling is at or above the wLoC", () => {
    const config = withFanout({ sizeTiers: [TIER, { maxWholeLogicLoc: 100, maxAnglesPerUnit: 6 }] });
    assert.equal(apply({ sizeOutcome: SIZE(41) }, config).tier.maxAnglesPerUnit, 6);
  });
  test("tier maxFiles: equal and below apply, above and absent behave as documented", () => {
    const two = withFanout({ sizeTiers: [{ ...TIER, maxFiles: 1 }] });
    assert.equal(apply({ changedFiles: ["docs/a.md", "test/a.test.mjs"] }, two).reason, "size_tier_applied");
    assert.equal(apply({ changedFiles: ["docs/a.md"] }, two).reason, "size_tier_applied");
    assert.equal(apply({ changedFiles: ["test/a.test.mjs", "test/b.test.mjs"] }, two).reason, "over_tier_max_files");
    assert.equal(apply({ changedFiles: ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs"] }).reason, "size_tier_applied");
  });
  for (const [reason, config, gate, over] of [
    ["size_tiers_unconfigured", withFanout({ sizeTiers: undefined }), "draft", {}],
    ["per_angle_mode", withFanout({ sizeTiers: [TIER], mode: "per-angle" }), "draft", {}],
    ["gate_not_tiered", TIERED, "review", {}],
    ["gate_full_label", TIERED, "draft", { hasFullLabel: true }],
    ["escalated", TIERED, "preApproval", { escalated: true }],
    ["size_outcome_unavailable", TIERED, "draft", { sizeOutcome: null }],
    ["size_outcome_unavailable", TIERED, "draft", { sizeOutcome: SIZE(Number.NaN) }],
    ["size_outcome_unavailable", TIERED, "draft", { sizeOutcome: SIZE(-1) }],
    ["size_outcome_not_pass", TIERED, "draft", { sizeOutcome: SIZE(10, { outcome: "escalate" }) }],
    ["size_outcome_t1", TIERED, "draft", { sizeOutcome: SIZE(10, { tierLogicLoc: { t1: 3 } }) }],
    ["changed_files_unavailable", TIERED, "draft", { changedFiles: null }],
    ["risk_path_touch", TIERED, "draft", { changedFiles: ["packages/core/src/config/config.mjs"] }],
    ["config_source_touch", TIERED, "draft", { changedFiles: [".devloops"] }],
    ["unclassifiable_diff", TIERED, "draft", { changedFiles: ["docs/a.md", "mystery.zzz"] }],
  ]) {
    test(`${reason} keeps existing grouping (${gate})`, () => {
      const result = apply(over, config, gate);
      assert.equal(result.tier, null);
      assert.equal(result.reason, reason);
    });
  }
});

describe("tier packing in resolveFanoutDispatch (AC1, AC4, AC6, AC7, AC9)", () => {
  for (const gate of ["draft", "preApproval"]) {
    for (const [harness, env] of [["claude", claudeEnv], ["pi", piEnv], ["codex", codexEnv]]) {
      test(`${gate} (${harness}): a same-model set above five angles is one packed unit with the same membership`, () => {
        const angles = resolveGateAngleContract(REPO_CONFIG, gate).pool.slice(0, 9);
        const plan = dispatch(TIERED, gate, angles, env());
        assert.equal(plan.unitBound, 10);
        assert.equal(plan.groups.length, 1);
        assert.ok(isPackedUnitName(plan.groups[0].name));
        assert.equal(units(plan).length, 1);
        assert.deepEqual([...plan.groups[0].angles].sort(), [...angles].sort());
        assert.deepEqual(plan.sizeTier, { wholeLogicLoc: 30, tier: TIER, angleCount: 9, unitCount: 1, reasons: ["size_tier_applied"] });
      });
    }
  }

  test("a light-eligible round (reachable only through an inline escalation) keeps existing grouping with the escalated reason, no flag needed", () => {
    const angles = POOL.slice(0, 9);
    const baseline = dispatch(withFanout({ sizeTiers: undefined }, LIGHT_CONFIG), "draft", angles, piEnv());
    const plan = dispatch(withFanout({ sizeTiers: [TIER] }, LIGHT_CONFIG), "draft", angles, piEnv());
    assert.deepEqual(plan.groups, baseline.groups);
    assert.equal(plan.unitBound, 5);
    assert.deepEqual(plan.sizeTier.reasons, ["escalated"]);
  });

  test("a light-eligible round with an unclassifiable file records unclassifiable_diff, not escalated", () => {
    const angles = POOL.slice(0, 9);
    const light = withFanout({ sizeTiers: [TIER] }, LIGHT_CONFIG);
    const plan = dispatch(light, "draft", angles, piEnv(), { changedFiles: ["docs/a.md", "mystery.zzz"], sizeOutcome: SIZE(10) });
    assert.deepEqual(plan.sizeTier.reasons, ["unclassifiable_diff"]);
    assert.equal(plan.unitBound, 5);
  });

  test("a sequential tiered round still packs and records size_tier_applied", () => {
    const angles = POOL.slice(0, 9);
    const plan = dispatch(withFanout({ sizeTiers: [TIER], sequential: true }), "draft", angles, piEnv());
    assert.equal(plan.unitBound, 10);
    assert.equal(units(plan).length, 1);
    assert.deepEqual(plan.sizeTier.reasons, ["size_tier_applied"]);
  });

  test("an explicit harness override drives the model partition, not the env harness", () => {
    const config = withFanout({ sizeTiers: [TIER], groups: [{ name: "lowg", angles: POOL.slice(0, 2) }, { name: "highg", angles: POOL.slice(2, 4) }] });
    const tiered = { ...config, gates: { ...config.gates, draft: { ...config.gates.draft, angles: [...POOL.slice(0, 2).map((name) => ({ name, tier: "low" })), ...config.gates.draft.angles] } } };
    const angles = POOL.slice(0, 4);
    assert.equal(dispatch(tiered, "draft", angles, codexEnv(), { harness: "claude" }).groups.length, 2, "the override beats the Codex env harness, which alone yields one group");
    assert.equal(dispatch(tiered, "draft", angles, codexEnv()).groups.length, 1, "the Codex env harness inherits every angle");
  });

  test("a round whose every dispatchable group is carried keeps existing grouping with no_dispatchable_units", () => {
    const angles = ["correctness", "coverage"];
    const baseline = dispatch(withFanout({ sizeTiers: undefined }), "draft", angles, piEnv(), { carriedAngles: angles });
    const plan = dispatch(TIERED, "draft", angles, piEnv(), { carriedAngles: angles });
    assert.deepEqual(plan.groups, baseline.groups);
    assert.equal(plan.unitBound, 5);
    assert.equal(plan.sizeTier.tier, null);
    assert.deepEqual(plan.sizeTier.reasons, ["no_dispatchable_units"]);
  });

  test("a tiered pack above the effective maxConcurrent is discarded with over_concurrency and the capacity path runs", () => {
    const groups = [0, 1, 2].map((i) => ({ name: `g${i}`, angles: POOL.slice(i * 6, i * 6 + 6) }));
    const config = withFanout({ sizeTiers: [TIER], groups, maxConcurrent: 2 });
    assert.throws(() => dispatch(config, "draft", POOL.slice(0, 18), piEnv()), /GATE-EXEC-FANOUT-CAPACITY/);
    // Two model partitions pack to two units, above maxConcurrent 1, while the existing path fits the four angles in one unit.
    const split = withFanout({ sizeTiers: [TIER], maxConcurrent: 1, groups: [{ name: "lowg", angles: POOL.slice(0, 2) }, { name: "highg", angles: POOL.slice(2, 4) }] });
    const tiered = { ...split, gates: { ...split.gates, draft: { ...split.gates.draft, angles: [...POOL.slice(0, 2).map((name) => ({ name, tier: "low" })), ...split.gates.draft.angles] } } };
    const plan = dispatch(tiered, "draft", POOL.slice(0, 4), claudeEnv());
    assert.deepEqual(plan.sizeTier.reasons, ["over_concurrency"]);
    assert.equal(plan.sizeTier.tier, null);
    assert.equal(plan.unitBound, 5);
    assert.equal(plan.groups.length, 1);
  });

  test("a recorded bound above the default is dropped when no tier applies on this build", () => {
    const angles = POOL.slice(0, 9);
    const baseline = dispatch(withFanout({ sizeTiers: undefined }), "draft", angles, piEnv());
    const plan = dispatch(TIERED, "draft", angles, piEnv(), { unitBound: 10, sizeOutcome: SIZE(41) });
    assert.equal(plan.unitBound, 5);
    assert.deepEqual(plan.groups, baseline.groups);
  });

  test("a same-head rebuild without size evidence reuses the recorded applied tier", () => {
    const angles = POOL.slice(0, 9);
    const first = dispatch(TIERED, "draft", angles, piEnv());
    const rebuilt = dispatch(TIERED, "draft", angles, piEnv(), { sizeOutcome: null, unitBound: first.unitBound, recordedSizeTier: first.sizeTier });
    assert.deepEqual(rebuilt.groups, first.groups);
    assert.equal(rebuilt.unitBound, 10);
    assert.deepEqual(rebuilt.sizeTier.reasons, ["size_tier_applied"]);
    assert.equal(rebuilt.sizeTier.wholeLogicLoc, 30);
    const excluded = dispatch(TIERED, "draft", angles, piEnv(), { sizeOutcome: SIZE(41), recordedSizeTier: first.sizeTier });
    assert.deepEqual(excluded.sizeTier.reasons, ["above_size_tiers"], "an explicit exclusion re-derives");
    const stale = dispatch(withFanout({ sizeTiers: [{ maxWholeLogicLoc: 80, maxAnglesPerUnit: 6 }] }), "draft", angles, piEnv(), { sizeOutcome: null, recordedSizeTier: first.sizeTier });
    assert.deepEqual(stale.sizeTier.reasons, ["size_outcome_unavailable"], "a recorded tier the config no longer has re-derives");
    assert.equal(stale.unitBound, 5);
    const noFiles = dispatch(TIERED, "draft", angles, piEnv(), { changedFiles: null, sizeOutcome: null, recordedSizeTier: first.sizeTier });
    assert.deepEqual(noFiles.sizeTier.reasons, ["size_tier_applied"], "absent size evidence reuses");
    const grown = dispatch(TIERED, "draft", angles, piEnv(), { changedFiles: null, sizeOutcome: SIZE(100), recordedSizeTier: first.sizeTier });
    assert.equal(grown.sizeTier.tier, null, "present size above the recorded tier re-derives");
    assert.equal(grown.unitBound, 5);
  });

  test("a present malformed sizeOutcome does not reuse the recorded tier, and valid in-tier evidence with no changed files does", () => {
    const angles = POOL.slice(0, 9);
    const first = dispatch(TIERED, "draft", angles, piEnv());
    for (const sizeOutcome of [{ outcome: "block" }, SIZE(-1), SIZE(Number.NaN)]) {
      const plan = dispatch(TIERED, "draft", angles, piEnv(), { sizeOutcome, recordedSizeTier: first.sizeTier });
      assert.deepEqual(plan.sizeTier.reasons, ["size_outcome_unavailable"]);
      assert.equal(plan.sizeTier.tier, null);
      assert.equal(plan.unitBound, 5);
    }
    for (const sizeOutcome of [null, undefined, SIZE(30)]) {
      const plan = dispatch(TIERED, "draft", angles, piEnv(), { changedFiles: null, sizeOutcome, recordedSizeTier: first.sizeTier });
      assert.deepEqual(plan.sizeTier.reasons, ["size_tier_applied"]);
      assert.equal(plan.unitBound, 10);
    }
  });

  test("without the key the plan carries no sizeTier record and today's grouping", () => {
    const config = withFanout({ sizeTiers: undefined });
    const plan = dispatch(config, "draft", POOL.slice(0, 9), piEnv());
    assert.equal("sizeTier" in plan, false);
    assert.equal(plan.unitBound, 5);
  });

  test("an excluded round keeps existing grouping and records the reason", () => {
    const angles = POOL.slice(0, 9);
    const baseline = dispatch(withFanout({ sizeTiers: undefined }), "draft", angles, piEnv());
    const plan = dispatch(TIERED, "draft", angles, piEnv(), { sizeOutcome: SIZE(41) });
    assert.deepEqual(plan.groups, baseline.groups);
    assert.equal(plan.unitBound, 5);
    assert.deepEqual(plan.sizeTier, { wholeLogicLoc: 41, tier: null, angleCount: 9, unitCount: baseline.groups.length, reasons: ["above_size_tiers"] });
  });

  test("three indivisible six-angle base units at bound ten emit three units, never fewer", () => {
    const groups = [0, 1, 2].map((i) => ({ name: `g${i}`, angles: POOL.slice(i * 6, i * 6 + 6) }));
    const config = withFanout({ sizeTiers: [TIER], groups });
    const plan = dispatch(config, "draft", POOL.slice(0, 18), piEnv());
    assert.equal(units(plan).length, 3);
    assert.deepEqual(plan.sizeTier.reasons, ["size_tier_applied", "unit_bound_reached"]);
    assert.deepEqual(plan.groups.flatMap((g) => g.angles).sort(), POOL.slice(0, 18).sort());
  });

  test("an eleven-angle set whose base units fit two bins emits two units and drops no angle", () => {
    const groups = [{ name: "a", angles: POOL.slice(0, 6) }, { name: "b", angles: POOL.slice(6, 10) }, { name: "c", angles: POOL.slice(10, 11) }];
    const plan = dispatch(withFanout({ sizeTiers: [TIER], groups }), "draft", POOL.slice(0, 11), piEnv());
    assert.equal(units(plan).length, 2);
    assert.ok(plan.sizeTier.reasons.includes("unit_bound_reached"));
    assert.deepEqual(plan.groups.flatMap((g) => g.angles).sort(), POOL.slice(0, 11).sort());
  });

  test("a recorded packed plan fails the pairing check against the plan re-derived above the tier (AC6)", () => {
    const angles = POOL.slice(0, 9);
    const packed = dispatch(TIERED, "draft", angles, piEnv());
    const rederived = resolveFanoutGroups(TIERED, "draft", angles);
    const perAngle = angles.map((angle) => ({ angle, reviewer: "r1", group: packed.groups[0].name }));
    assert.equal(fanoutReviewerPairingError(perAngle, rederived, packed.groups, 10), null, "the packed plan itself validates");
    const grown = dispatch(TIERED, "draft", angles, piEnv(), { sizeOutcome: SIZE(41) });
    assert.notDeepEqual(grown.groups, packed.groups);
    assert.notEqual(fanoutReviewerPairingError(perAngle, resolveFanoutGroups(TIERED, "draft", angles), grown.groups, grown.unitBound), null);
  });
});

describe("per-angle Claude model tiers split packed units by tier (AC5, ADR 0278)", () => {
  const LOW = POOL.slice(0, 2);
  const HIGH = POOL.slice(2, 4);
  const lowTier = (config) => {
    const entries = config.gates.draft.angles;
    assert.ok(Array.isArray(entries));
    return { ...config, gates: { ...config.gates, draft: { ...config.gates.draft, angles: [...LOW.map((name) => ({ name, tier: "low" })), ...entries] } } };
  };

  test("a mixed-tier selection splits by tier and never mixes models in one unit", () => {
    const config = lowTier(withFanout({ sizeTiers: [TIER], groups: [{ name: "lowg", angles: LOW }, { name: "highg", angles: HIGH }] }));
    const plan = dispatch(config, "draft", [...LOW, ...HIGH], claudeEnv());
    assert.equal(plan.groups.length, 2);
    assert.deepEqual(plan.groups.map((g) => [...g.angles].sort()).sort(), [[...LOW].sort(), [...HIGH].sort()].sort());
    assert.ok(plan.sizeTier.reasons.includes("model_partition"));
  });

  test("the default (no angle tier) keeps every Claude angle in one unit", () => {
    const plan = dispatch(TIERED, "draft", [...LOW, ...HIGH], claudeEnv());
    assert.equal(plan.groups.length, 1);
  });

  test("a base unit that mixes models keeps existing grouping with a reason", () => {
    const config = lowTier(withFanout({ sizeTiers: [TIER], groups: [{ name: "mixed", angles: [LOW[0], HIGH[0]] }] }));
    const plan = dispatch(config, "draft", [LOW[0], HIGH[0]], claudeEnv());
    assert.equal(plan.unitBound, 5);
    assert.deepEqual(plan.sizeTier.reasons, ["mixed_model_base_unit"]);
    assert.equal(plan.sizeTier.tier, null);
  });
});
