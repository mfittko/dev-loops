// Single-wave gate fan-out: every planned round under the shipped group table,
// the 5-angle reviewer-unit bound and gates.fanout.maxConcurrent: 5 emits at
// most 5 dispatch units and releases them in exactly one wave, with no primer or
// lead-reviewer step before it. write-gate-context.mjs packs whole base units
// when a round has more units than the effective concurrency, and refuses a
// round above maxConcurrent x 5 angles. The same holds under the Claude clamp
// (5) and a Pi env (one runs.all call per wave).
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";
import { expandDispatchUnits } from "../../scripts/github/_dispatch-units.mjs";
import { mapGateToConfigKey, parseWriteGateContextCliArgs, resolveFanoutDispatch, writeGateContext } from "../../scripts/github/write-gate-context.mjs";
import {
  loadDevLoopConfig,
  resolveFanoutEffectiveConcurrency,
  resolveFanoutGroups,
  resolveGateAngleContract,
} from "@dev-loops/core/config";
import { angleReviewSurface } from "@dev-loops/core/loop/gate-carry-forward";
import { fanoutReviewerPairingError, scheduleFanoutWaves } from "@dev-loops/core/loop/gate-fanin";
import { REVIEWER_UNIT_MAX_ANGLES } from "@dev-loops/core/loop/reviewer-unit-bound";
import { NEUTRAL_RUN_ID_VAR, RUN_ID_MARKERS } from "@dev-loops/core/loop/run-context";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const emitCliPath = path.resolve(REPO_ROOT, "scripts/github/emit-fanout-dispatch.mjs");
const REPO = "o/r";
const PR = "7";
const HEAD_SHA = "c".repeat(40);

const piRunIdMarker = RUN_ID_MARKERS.find((m) => m !== NEUTRAL_RUN_ID_VAR);
function claudeEnv() {
  return { ...process.env, CLAUDECODE: "1" };
}
function piEnv() {
  const env = { ...process.env, [piRunIdMarker]: "pi-run-1" };
  delete env.CLAUDECODE;
  return env;
}
const HARNESS_ENVS = [["claude", claudeEnv], ["pi", piEnv]];

const { config: REPO_CONFIG, errors: REPO_CONFIG_ERRORS } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
const SHIPPED_DIR = await mkdtemp(path.join(os.tmpdir(), "dev-loops-shipped-config-"));
const { config: SHIPPED_CONFIG } = await loadDevLoopConfig({ repoRoot: SHIPPED_DIR });
await rm(SHIPPED_DIR, { recursive: true, force: true });

// The round's first N angles in shipped catalog order, always including the
// mandatory holistic angle: the first N-1 non-holistic pool angles + holistic.
function roundAngles(configGate, n, config = REPO_CONFIG) {
  const { pool } = resolveGateAngleContract(config, configGate);
  const others = pool.filter((a) => a !== "holistic");
  return n >= pool.length ? [...pool] : [...others.slice(0, n - 1), "holistic"];
}

function configuredNames(config) {
  return new Set((config.gates.fanout.groups ?? []).map((g) => g.name));
}

// The units the emitter dispatches (--pending) for a round planned by
// write-gate-context.mjs: resolveFanoutDispatch (packing) then the emitter's
// own cap-split.
function plannedUnits(config, configGate, angles, env, options = {}) {
  const plan = resolveFanoutDispatch(config, configGate, angles, { env, ...options });
  return { plan, units: expandDispatchUnits(plan.pendingGroups, configuredNames(config)) };
}

function assertSingleWave(config, units, env, label) {
  const maxConcurrent = resolveFanoutEffectiveConcurrency(config, env);
  assert.ok(units.length <= maxConcurrent, `${label}: ${units.length} units exceed maxConcurrent ${maxConcurrent}`);
  assert.equal(scheduleFanoutWaves(units, maxConcurrent).length, 1, `${label}: exactly one wave`);
  for (const u of units) assert.ok(u.angles.length <= REVIEWER_UNIT_MAX_ANGLES, `${label}: unit ${u.name} has ${u.angles.length} angles`);
}

function assertCoverage(units, angles) {
  // Breadth unchanged: every resolved angle is dispatched exactly once, and
  // holistic keeps its own angle entry inside exactly one unit.
  assert.deepEqual(units.flatMap((u) => u.angles).sort(), [...angles].sort());
  if (angles.includes("holistic")) assert.equal(units.filter((u) => u.angles.includes("holistic")).length, 1);
}

describe("single-wave fan-out under the shipped group table and maxConcurrent 5", () => {
  test("this repo configures maxConcurrent 5 and keeps queue.maxParallel 3; the shipped default is 5", () => {
    assert.deepEqual(REPO_CONFIG_ERRORS, []);
    assert.equal(REPO_CONFIG.gates.fanout.maxConcurrent, 5);
    assert.equal(SHIPPED_CONFIG.gates.fanout.maxConcurrent, 5);
    assert.equal(REPO_CONFIG.queue.maxParallel, 3);
    assert.equal(REPO_CONFIG.gates.fanout.maxAnglesPerGroup, 5);
    assert.equal(REVIEWER_UNIT_MAX_ANGLES, 5);
  });

  const ROUNDS = [
    ["draft", 10],
    ["draft", 12],
    ["preApproval", 10],
    ["preApproval", 12],
  ];
  for (const [configGate, n] of ROUNDS) {
    for (const [harness, env] of HARNESS_ENVS) {
      test(`${configGate}, first ${n} shipped angles incl. holistic (${harness}): at most maxConcurrent units, exactly one wave`, () => {
        const angles = roundAngles(configGate, n);
        assert.equal(angles.length, n);
        assert.ok(angles.includes("holistic"));
        const { units } = plannedUnits(REPO_CONFIG, configGate, angles, env());
        assert.equal(resolveFanoutEffectiveConcurrency(REPO_CONFIG, env()), 5);
        assertSingleWave(REPO_CONFIG, units, env(), `${configGate}/${n}`);
        assertCoverage(units, angles);
      });
    }
  }

  for (const [label, config, expectedPool] of [["shipped 22-angle draft catalog", SHIPPED_CONFIG, 22], ["this repo's 20-angle draft pool", REPO_CONFIG, 20]]) {
    for (const [harness, env] of HARNESS_ENVS) {
      test(`full round, ${label} (${harness}): packed into one grouped wave of at most 5 units`, () => {
        const { pool } = resolveGateAngleContract(config, "draft");
        assert.equal(pool.length, expectedPool);
        const baseUnits = expandDispatchUnits(resolveFanoutGroups(config, "draft", pool), configuredNames(config));
        assert.ok(baseUnits.length > 5, "the unpacked full round exceeds one wave");
        const { units } = plannedUnits(config, "draft", pool, env());
        assertSingleWave(config, units, env(), label);
        assert.ok(units.some((u) => u.angles.length > 1), "grouped dispatch");
        assertCoverage(units, pool);
      });
    }
  }

  // Same-head resume after a partial wave: the packed grouping is derived from
  // the round's FULL resolved angle set, so re-planning with some packed units
  // already complete re-derives the IDENTICAL membership and the recorded
  // provenance still admits the wave-1 reviewers. Before this, packing keyed on
  // the pending set, so a resume re-planned the unpacked grouping, recorded it
  // as provenance.dispatchUnits, and fanoutReviewerPairingError refused a
  // legitimate round (the documented resume contract became unreachable).
  for (const [harness, env] of HARNESS_ENVS) {
    test(`same-head resume after a partial packed wave (${harness}): stable membership, one pending wave`, () => {
      const { pool } = resolveGateAngleContract(REPO_CONFIG, "draft");
      const first = resolveFanoutDispatch(REPO_CONFIG, "draft", pool, { env: env() });
      const wave1 = expandDispatchUnits(first.pendingGroups, configuredNames(REPO_CONFIG));
      const shared = wave1.find((u) => u.angles.length > 1);
      assert.ok(shared, "the packed round shares at least one unit");

      // Wave-1 provenance: one reviewer per emitted unit, the packed unit's own
      // name as its recorded group (the emitter's rule for a packed unit).
      const perAngle = wave1.flatMap((unit, index) => unit.angles.map((angle) => ({
        angle,
        reviewer: `r${index}`,
        ...(unit.angles.length > 1 ? { group: unit.name } : {}),
      })));
      assert.equal(fanoutReviewerPairingError(perAngle, null, first.pendingGroups), null, "wave 1 records a membership that admits its own reviewers");

      // Resume at the same head with that unit's angles already complete.
      const resumed = resolveFanoutDispatch(REPO_CONFIG, "draft", pool, { env: env(), completedAngles: [...shared.angles] });
      assert.deepEqual(resumed.groups, first.groups, "the packed membership is stable under a pending-set change");
      assert.equal(fanoutReviewerPairingError(perAngle, null, resumed.groups), null, "the wave-1 reviewer is still admitted after the resume");

      const wave2 = expandDispatchUnits(resumed.pendingGroups, configuredNames(REPO_CONFIG));
      assertSingleWave(REPO_CONFIG, wave2, env(), `resume ${harness}`);
      assert.equal(wave2.length, wave1.length - 1, "the shortfall is exactly the completed unit");
      assert.equal(wave2.some((u) => u.name === shared.name), false);

      // Differential: against the unpacked full grouping — what the pending-keyed
      // packing recorded on a resume before this fix — the same provenance is refused.
      const unpacked = expandDispatchUnits(resolveFanoutGroups(REPO_CONFIG, "draft", pool), configuredNames(REPO_CONFIG));
      assert.notEqual(fanoutReviewerPairingError(perAngle, null, unpacked), null, "the unpacked grouping cannot admit the packed wave's shared reviewer");
    });
  }

  // Carry-forward re-gate: the round resolves the full pool, the carry-forward
  // seam proves the carriable angles carried, and only N stay fresh.
  function carriable(config, configGate, angle) {
    const { mandatoryAngles } = resolveGateAngleContract(config, configGate);
    return angleReviewSurface(angle, { alwaysRerun: mandatoryAngles }).kind === "kinds";
  }
  for (const fresh of [2, 3, 4]) {
    for (const [harness, env] of HARNESS_ENVS) {
      test(`carry-forward round with ${fresh} fresh angles (${harness}): grouped, one wave`, () => {
        const { pool } = resolveGateAngleContract(REPO_CONFIG, "draft");
        const carriableAngles = pool.filter((a) => carriable(REPO_CONFIG, "draft", a));
        const freshAngles = ["holistic", ...carriableAngles.slice(0, fresh - 1)];
        const carried = carriableAngles.filter((a) => !freshAngles.includes(a));
        const angles = pool.filter((a) => freshAngles.includes(a) || carried.includes(a));
        const { plan, units } = plannedUnits(REPO_CONFIG, "draft", angles, env(), { carriedAngles: carried });
        assertSingleWave(REPO_CONFIG, units, env(), `carry-forward ${fresh}`);
        assert.ok(units.length >= 1 && units.length <= fresh);
        // Every fresh angle is dispatched exactly once; carried units stay out.
        const dispatched = units.flatMap((u) => u.angles);
        for (const angle of freshAngles) assert.equal(dispatched.filter((a) => a === angle).length, 1);
        assert.equal(new Set(dispatched).size, dispatched.length);
        assert.deepEqual(plan.preflight.carriedAngles.sort(), [...carried].sort());
      });
    }
  }

  // One fresh angle in each of the 4 draft configured groups plus leftovers.
  function partialRound(config, leftoverCount) {
    const { pool } = resolveGateAngleContract(config, "draft");
    const grouped = new Set();
    const firsts = [];
    for (const group of config.gates.fanout.groups ?? []) {
      const member = group.angles.find((a) => pool.includes(a));
      if (member && firsts.length < 4) firsts.push(member);
      for (const a of group.angles) grouped.add(a);
    }
    assert.equal(firsts.length, 4);
    const leftovers = pool.filter((a) => !grouped.has(a) && a !== "holistic").slice(0, leftoverCount - 1);
    return [...firsts, "holistic", ...leftovers];
  }
  for (const [leftoverCount, maxConcurrent] of [[3, 5], [8, 5], [3, 4]]) {
    for (const [harness, env] of HARNESS_ENVS) {
      test(`partial round, one angle per draft configured group + ${leftoverCount} leftovers, maxConcurrent ${maxConcurrent} (${harness}): one wave`, () => {
        const config = structuredClone(REPO_CONFIG);
        config.gates.fanout.maxConcurrent = maxConcurrent;
        const angles = partialRound(config, leftoverCount);
        const { units } = plannedUnits(config, "draft", angles, env());
        assertSingleWave(config, units, env(), `partial ${leftoverCount}/${maxConcurrent}`);
        assertCoverage(units, angles);
      });
    }
  }

  for (const [harness, env] of HARNESS_ENVS) {
    test(`single-angle round (${harness}): one unit, one wave`, () => {
      const { units } = plannedUnits(REPO_CONFIG, "draft", ["holistic"], env());
      assert.deepEqual(units.map((u) => u.angles), [["holistic"]]);
      assertSingleWave(REPO_CONFIG, units, env(), "single-angle");
    });
  }

  test("packing is deterministic: the same input gives the same units", () => {
    const { pool } = resolveGateAngleContract(REPO_CONFIG, "draft");
    const first = resolveFanoutDispatch(REPO_CONFIG, "draft", pool, { env: {} });
    const second = resolveFanoutDispatch(structuredClone(REPO_CONFIG), "draft", [...pool], { env: {} });
    assert.deepEqual(second.groups, first.groups);
    assert.deepEqual(second.pendingGroups, first.pendingGroups);
    // Input order never moves a unit boundary: angles are ordered by the pool.
    const reversed = resolveFanoutDispatch(REPO_CONFIG, "draft", [...pool].reverse(), { env: {} });
    assert.deepEqual(reversed.groups, first.groups);
    const unpackedAngles = pool.slice(0, 17);
    const unpacked = resolveFanoutDispatch(REPO_CONFIG, "draft", unpackedAngles, { env: {} });
    assert.deepEqual(resolveFanoutDispatch(REPO_CONFIG, "draft", [...unpackedAngles].reverse(), { env: {} }).groups, unpacked.groups);
  });

  // Property: for maxConcurrent 1..5 and 1..maxConcurrent x 5 fresh angles,
  // with singleton base units and with 5-angle auto-chunks (both always
  // packable), the plan is at most maxConcurrent units of at most 5 angles in
  // one wave covering every angle; one angle above capacity is refused. With
  // 2-angle base units FFD can also refuse below capacity (a base unit is never
  // split), and it refuses rather than planning a second wave.
  test("property: unit count <= maxConcurrent and no unit above 5 angles up to capacity; refusal above it", () => {
    for (let maxConcurrent = 1; maxConcurrent <= 5; maxConcurrent += 1) {
      for (const maxAnglesPerGroup of [1, 2, 5]) {
        const config = { version: 1, gates: { fanout: { groups: [], maxConcurrent, maxAnglesPerGroup } } };
        const capacity = maxConcurrent * REVIEWER_UNIT_MAX_ANGLES;
        for (let n = 1; n <= capacity; n += 1) {
          const angles = Array.from({ length: n }, (_, i) => `angle-${i}`);
          let units;
          try {
            ({ units } = plannedUnits(config, "draft", angles, {}));
          } catch (error) {
            assert.equal(maxAnglesPerGroup, 2, `M=${maxConcurrent} N=${maxAnglesPerGroup} n=${n}: unexpected refusal ${error.message}`);
            assert.match(error.message, /GATE-EXEC-FANOUT-CAPACITY/);
            continue;
          }
          assert.ok(units.length <= maxConcurrent, `M=${maxConcurrent} N=${maxAnglesPerGroup} n=${n}: ${units.length} units`);
          for (const u of units) assert.ok(u.angles.length <= REVIEWER_UNIT_MAX_ANGLES);
          assert.equal(scheduleFanoutWaves(units, maxConcurrent).length, 1);
          assert.deepEqual(units.flatMap((u) => u.angles).sort(), [...angles].sort());
        }
        const over = Array.from({ length: capacity + 1 }, (_, i) => `angle-${i}`);
        assert.throws(() => resolveFanoutDispatch(config, "draft", over, { env: {} }), new RegExp(`GATE-EXEC-FANOUT-CAPACITY: refusing — ${capacity + 1} fresh angles .*capacity ${capacity}\\)`));
      }
    }
  });

  test("sequential dispatch stays an explicit serial opt-out: no packing, one unit per wave", () => {
    const config = structuredClone(REPO_CONFIG);
    config.gates.fanout.sequential = true;
    const { pool } = resolveGateAngleContract(config, "draft");
    const plan = resolveFanoutDispatch(config, "draft", pool, { env: {} });
    assert.equal(plan.effectiveConcurrency, 1);
    assert.ok(plan.pendingWavePlan.length > 1);
    assert.ok(plan.pendingWavePlan.every((w) => w.length === 1));
  });

  test("rollback: a repo gates.fanout.groups entry { name: holistic, angles: [holistic] } restores the holistic singleton unit, never packed when the round fits", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-holistic-rollback-"));
    try {
      // gates.fanout.groups merges wholesale; a real override restates the
      // shipped table too. The holistic entry alone is enough to pin placement.
      await writeFile(path.join(tmpDir, ".devloops"), [
        "version: 1",
        "gates:",
        "  fanout:",
        "    groups:",
        "      - name: holistic",
        "        angles: [holistic]",
        "",
      ].join("\n"), "utf8");
      const { config, errors } = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(errors, []);
      const angles = roundAngles("preApproval", 12, config);
      const { units } = plannedUnits(config, "preApproval", angles, claudeEnv());
      const holisticUnits = units.filter((u) => u.angles.includes("holistic"));
      assert.equal(holisticUnits.length, 1);
      assert.deepEqual(holisticUnits[0].angles, ["holistic"]);
      assertSingleWave(config, units, claudeEnv(), "rollback");
      assert.deepEqual(units.flatMap((u) => u.angles).sort(), [...angles].sort());
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// Dispatch sequence as the gate coordinator runs it: emit, then release waves
// of the emitted units. The first wave carries reviewer 1 together with its
// siblings (no 1 -> wait -> N shape), no unit is a primer, and no primer
// artifact is written. Pi releases each wave as one runs.all call. The full
// 20-angle pool emits packed units whose holistic entry keeps its own prompt
// and findings artifact.
describe("no primer or lead-reviewer serialization precedes the first wave", () => {
  const CASES = [];
  for (const [gate, configGate] of [["draft_gate", "draft"], ["pre_approval_gate", "preApproval"]]) CASES.push([gate, configGate, 12]);
  CASES.push(["draft_gate", "draft", 20]);
  for (const [gate, configGate, n] of CASES) for (const [harness, env] of HARNESS_ENVS) {
    test(`${n}-angle ${configGate} round (${harness}): all emitted units release together in the first wave`, async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-single-wave-"));
      try {
        await copyFile(path.join(REPO_ROOT, ".devloops"), path.join(tmpDir, ".devloops"));
        const { config } = await loadDevLoopConfig({ repoRoot: tmpDir });
        const angles = roundAngles(configGate, n);
        assert.equal(angles.length, n);
        const options = parseWriteGateContextCliArgs([
          "--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA,
          "--angles", JSON.stringify(angles),
        ]);
        options.config = config;
        options.fanoutDispatch = resolveFanoutDispatch(config, mapGateToConfigKey(gate), angles, { env: env() });
        await writeGateContext(options, { repoRoot: tmpDir });

        const result = spawnSync("node", [emitCliPath, "--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA], {
          cwd: tmpDir,
          encoding: "utf8",
          env: env(),
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.maxConcurrent, 5);
        assert.ok(payload.count <= payload.maxConcurrent);
        const waves = scheduleFanoutWaves(payload.units, payload.maxConcurrent);
        // Pi: one runs.all call per wave; every round is one call.
        assert.equal(waves.length, 1);
        // Reviewer 1 is released with every sibling, never alone ahead of them.
        assert.deepEqual(waves[0].map((u) => u.scope), payload.units.map((u) => u.scope));
        assert.ok(waves[0].length > 1);
        for (const u of payload.units) assert.doesNotMatch(u.scope, /prime/);
        for (const u of payload.units) assert.ok(u.angles.length <= REVIEWER_UNIT_MAX_ANGLES);
        assert.deepEqual(payload.units.flatMap((u) => u.angles).sort(), [...angles].sort());
        // holistic keeps its own prompt, findings artifact and provenance slot
        // inside one shared unit.
        const holisticUnits = payload.units.filter((u) => u.workOrder.assignedAngles.includes("holistic"));
        assert.equal(holisticUnits.length, 1);
        const [holisticUnit] = holisticUnits;
        assert.ok(holisticUnit.angles.length > 1 && holisticUnit.angles.length <= REVIEWER_UNIT_MAX_ANGLES);
        assert.equal(typeof holisticUnit.group, "string");
        const instruction = holisticUnit.workOrder.angleInstructions.find((i) => i.angle === "holistic");
        assert.match(instruction.prompt, /holistic/i);
        assert.equal(holisticUnit.workOrder.outputRefs.filter((ref) => ref.endsWith("/holistic.json")).length, 1);
        const contextDir = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-7");
        const files = await readdir(contextDir);
        assert.equal(files.some((f) => f.includes("primer")), false, "no primer artifact is written");
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
});
