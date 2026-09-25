// Single-wave gate fan-out: a typical 10-to-12-angle round under the shipped
// group table, the 5-angle reviewer-unit bound, and this repo's
// gates.fanout.maxConcurrent: 4 emits at most 4 dispatch units and releases
// them in exactly one wave, with no primer or lead-reviewer step before it.
// The same holds under the Claude clamp (4) and a Pi env (one runs.all call per
// wave). The full draft pool needs at most 2 waves.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";
import { expandDispatchUnits } from "../../scripts/github/emit-fanout-dispatch.mjs";
import { mapGateToConfigKey, parseWriteGateContextCliArgs, resolveFanoutDispatch, writeGateContext } from "../../scripts/github/write-gate-context.mjs";
import {
  loadDevLoopConfig,
  resolveFanoutEffectiveConcurrency,
  resolveFanoutGroups,
  resolveGateAngleContract,
} from "@dev-loops/core/config";
import { scheduleFanoutWaves } from "@dev-loops/core/loop/gate-fanin";
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

// The round's first N angles in shipped catalog order, always including the
// mandatory holistic angle: the first N-1 non-holistic pool angles + holistic.
function roundAngles(configGate, n) {
  const { pool } = resolveGateAngleContract(REPO_CONFIG, configGate);
  const others = pool.filter((a) => a !== "holistic");
  return n >= pool.length ? [...pool] : [...others.slice(0, n - 1), "holistic"];
}

function emittedUnits(configGate, angles) {
  const configured = new Set((REPO_CONFIG.gates.fanout.groups ?? []).map((g) => g.name));
  return expandDispatchUnits(resolveFanoutGroups(REPO_CONFIG, configGate, angles), configured);
}

describe("single-wave fan-out under the shipped group table and maxConcurrent 4", () => {
  test("this repo configures maxConcurrent 4 and keeps queue.maxParallel 3", () => {
    assert.deepEqual(REPO_CONFIG_ERRORS, []);
    assert.equal(REPO_CONFIG.gates.fanout.maxConcurrent, 4);
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
        const units = emittedUnits(configGate, angles);
        const maxConcurrent = resolveFanoutEffectiveConcurrency(REPO_CONFIG, env());
        assert.equal(maxConcurrent, 4);
        assert.ok(units.length <= maxConcurrent, `${units.length} units exceed maxConcurrent ${maxConcurrent}`);
        assert.equal(scheduleFanoutWaves(units, maxConcurrent).length, 1);
        // holistic keeps its own angle entry inside exactly one emitted unit.
        assert.equal(units.filter((u) => u.angles.includes("holistic")).length, 1);
        // Breadth unchanged: every resolved angle is emitted exactly once.
        assert.deepEqual(units.flatMap((u) => u.angles).sort(), [...angles].sort());
        for (const u of units) assert.ok(u.angles.length <= REVIEWER_UNIT_MAX_ANGLES);
      });
    }
  }

  test("full draft pool: at most 2 waves and no unit above 5 angles", () => {
    const { pool } = resolveGateAngleContract(REPO_CONFIG, "draft");
    assert.equal(pool.length, 20);
    assert.ok(pool.includes("holistic"));
    const units = emittedUnits("draft", pool);
    for (const u of units) assert.ok(u.angles.length <= 5, `unit ${u.name} has ${u.angles.length} angles`);
    for (const [, env] of HARNESS_ENVS) {
      assert.ok(scheduleFanoutWaves(units, resolveFanoutEffectiveConcurrency(REPO_CONFIG, env())).length <= 2);
    }
    assert.deepEqual(units.flatMap((u) => u.angles).sort(), [...pool].sort());
  });

  test("rollback: a repo gates.fanout.groups entry { name: holistic, angles: [holistic] } restores the holistic singleton unit", async () => {
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
      const angles = roundAngles("preApproval", 12);
      const configured = new Set(config.gates.fanout.groups.map((g) => g.name));
      const units = expandDispatchUnits(resolveFanoutGroups(config, "preApproval", angles), configured);
      const holisticUnits = units.filter((u) => u.angles.includes("holistic"));
      assert.equal(holisticUnits.length, 1);
      assert.equal(holisticUnits[0].name, "holistic");
      assert.deepEqual(holisticUnits[0].angles, ["holistic"]);
      assert.deepEqual(units.flatMap((u) => u.angles).sort(), [...angles].sort());
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("a 6-unit round releases 4 units in wave 1 and the remaining 2 in wave 2", () => {
    const units = Array.from({ length: 6 }, (_, i) => ({ name: `u${i}`, angles: [`a${i}`] }));
    assert.deepEqual(scheduleFanoutWaves(units, 4).map((w) => w.length), [4, 2]);
  });
});

// Dispatch sequence as the gate coordinator runs it: emit, then release waves
// of the emitted units. The first wave carries reviewer 1 together with its
// siblings (no 1 -> wait -> N shape), no unit is a primer, and no primer
// artifact is written. Pi releases each wave as one runs.all call.
describe("no primer or lead-reviewer serialization precedes the first wave", () => {
  for (const [gate, configGate] of [["draft_gate", "draft"], ["pre_approval_gate", "preApproval"]]) for (const [harness, env] of HARNESS_ENVS) {
    test(`12-angle ${configGate} round (${harness}): all emitted units release together in the first wave`, async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-single-wave-"));
      try {
        await copyFile(path.join(REPO_ROOT, ".devloops"), path.join(tmpDir, ".devloops"));
        const { config } = await loadDevLoopConfig({ repoRoot: tmpDir });
        const angles = roundAngles(configGate, 12);
        const options = parseWriteGateContextCliArgs([
          "--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA,
          "--angles", JSON.stringify(angles),
        ]);
        options.config = config;
        options.fanoutDispatch = resolveFanoutDispatch(config, mapGateToConfigKey(gate), angles, {});
        await writeGateContext(options, { repoRoot: tmpDir });

        const result = spawnSync("node", [emitCliPath, "--repo", REPO, "--pr", PR, "--gate", gate, "--head-sha", HEAD_SHA], {
          cwd: tmpDir,
          encoding: "utf8",
          env: env(),
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.maxConcurrent, 4);
        assert.ok(payload.count <= payload.maxConcurrent);
        const waves = scheduleFanoutWaves(payload.units, payload.maxConcurrent);
        // Pi: one runs.all call per wave; a typical round is one call.
        assert.equal(waves.length, 1);
        // Reviewer 1 is released with every sibling, never alone ahead of them.
        assert.deepEqual(waves[0].map((u) => u.scope), payload.units.map((u) => u.scope));
        assert.ok(waves[0].length > 1);
        for (const u of payload.units) assert.doesNotMatch(u.scope, /prime/);
        // holistic keeps its own prompt, findings artifact and provenance slot
        // inside a shared leftover unit.
        const holisticUnits = payload.units.filter((u) => u.workOrder.assignedAngles.includes("holistic"));
        assert.equal(holisticUnits.length, 1);
        const [holisticUnit] = holisticUnits;
        assert.ok(holisticUnit.angles.length > 1);
        assert.match(holisticUnit.group, /^group:/);
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
