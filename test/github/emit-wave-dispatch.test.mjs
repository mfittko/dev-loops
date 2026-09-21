import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  DEFAULT_WAVE_TIMEOUT_MS,
  buildWavePlanPath,
  buildWaveScriptPath,
  main,
  partitionWaves,
  renderWaveWorkflowScript,
  validateWaveDispatchPlan,
  waveDispatchKey,
  waveScriptCallShape,
} from "../../scripts/github/emit-wave-dispatch.mjs";
import { buildGateEmitPlanPath } from "../../scripts/github/write-gate-context.mjs";

const cliPath = path.resolve("scripts/github/emit-wave-dispatch.mjs");

// resolveFanoutEffectiveConcurrency clamps to CLAUDE_MAX_EFFECTIVE_CONCURRENT
// under the Claude harness, so the in-process assertions below (which pin the
// configured 3) must not inherit an ambient CLAUDECODE — the sibling
// emit-fanout-dispatch suite scrubs it the same way (#1086 cross-harness
// non-regression: the suite must be green on BOTH harnesses).
function withoutClaudeHarness() {
  const previous = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  return () => {
    if (previous === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = previous;
  };
}

function runCli(args = [], opts = {}) {
  return spawnSync("node", [cliPath, ...args], { encoding: "utf8", ...opts });
}

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-emit-wave-dispatch-"));
  const restoreHarness = withoutClaudeHarness();
  try {
    return await fn(tmpDir);
  } finally {
    restoreHarness();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Capture the in-process stdout an emitResult-backed refusal/emission writes. */
async function captureStdout(fn) {
  const original = process.stdout.write;
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    const exitCode = await fn();
    return { exitCode, stdout: captured };
  } finally {
    process.stdout.write = original;
  }
}

const HEAD_SHA = "c".repeat(40);
const GATE = "pre_approval_gate";
const REPO = "o/r";
const PR = "7";

const DEFAULT_UNITS = [
  { scope: "pre-approval-gate-holistic", angles: ["holistic"], group: null },
  { scope: "pre-approval-gate-coverage", angles: ["coverage"], group: null },
  { scope: "pre-approval-gate-group-dry-kiss", angles: ["dry", "kiss"], group: "design-simplicity" },
];

function planPathFor(tmpDir) {
  return buildGateEmitPlanPath({ repo: REPO, pr: PR, gate: GATE, headSha: HEAD_SHA, tmpRoot: path.join(tmpDir, "tmp") });
}

/**
 * Seed the round's keyed emit-plan.json plus one composed reviewer prompt file
 * per unit — the exact artifacts a completed emit-fanout-dispatch.mjs run
 * leaves on disk.
 */
async function seedEmitPlan(tmpDir, { units = DEFAULT_UNITS, maxConcurrent = 3, count } = {}) {
  const planPath = planPathFor(tmpDir);
  const dir = path.dirname(planPath);
  await mkdir(dir, { recursive: true });
  const withPrompts = [];
  for (const unit of units) {
    if (typeof unit.promptPath === "string") {
      withPrompts.push(unit);
      continue;
    }
    const promptPath = path.join(dir, `${unit.scope ?? unit.name ?? "unit"}.prompt.txt`);
    await writeFile(promptPath, typeof unit.promptBytes === "string" ? unit.promptBytes : `PROMPT BYTES for ${unit.scope ?? "unit"}\n`, "utf8");
    withPrompts.push({ ...unit, promptPath });
  }
  await writeFile(planPath, `${JSON.stringify({ ok: true, gate: GATE, headSha: HEAD_SHA, repo: REPO, pr: PR, count: count ?? withPrompts.length, maxConcurrent, units: withPrompts }, null, 2)}\n`, "utf8");
  return { planPath, dir };
}

function baseArgs(tmpDir) {
  return ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--tmp-root", path.join(tmpDir, "tmp")];
}

async function readPlan(tmpDir) {
  return JSON.parse(await readFile(buildWavePlanPath({ planPath: planPathFor(tmpDir), gate: GATE, headSha: HEAD_SHA }), "utf8"));
}

/**
 * Config stub. `sequential` mirrors `gates.fanout.sequential`;
 * `requireFanoutEvidence` mirrors the gate enforcement toggle the
 * fail-closed serialization guard keys on.
 */
function configStub({ maxConcurrent = 3, sequential = false, requireFanoutEvidence = true } = {}) {
  return async () => ({
    config: { gates: { requireFanoutEvidence, fanout: { maxConcurrent, ...(sequential ? { sequential: true } : {}) } } },
  });
}

test("emit-wave-dispatch.mjs --help exits 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /emit-wave-dispatch/);
  assert.match(result.stdout, /workflowScriptPath/);
});

test("refuses with exit 1 when no emit-plan.json exists at this key", () => {
  const result = runCli(baseArgs("/nonexistent-tmp-root"));
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /emit-fanout-dispatch\.mjs/);
});

// AC: "The emitted body uses workflowScript / workflowScriptPath with
// runs.all([...]) ... and carries a unique non-empty key per unit."
// AC: "Regression coverage asserts the emitted wave is one runs.all call with
// unique keys."
test("emits ONE runs.all call per wave with a unique non-empty key per unit", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir);
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub() }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.ok, true);
    assert.equal(plan.count, 3);
    assert.equal(plan.maxConcurrent, 3);
    // 3 units at maxConcurrent 3 → exactly ONE wave, hence ONE call.
    assert.equal(plan.waves.length, 1);
    assert.equal(plan.calls.length, 1);
    const script = await readFile(plan.waves[0].scriptPath, "utf8");
    assert.equal(waveScriptCallShape(script).runsAllCalls, 1, "a wave must be exactly ONE runs.all call");
    // Read the keys from the plan (and, in the probe test below, from the
    // script's own runs.all call), never by regexing the raw script: inlined
    // reviewer prose could otherwise be mistaken for code.
    const keys = plan.waves[0].keys;
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3, "every runs.all item needs a UNIQUE key");
    for (const key of keys) assert.ok(key.trim().length > 0, "keys must be non-empty");
    // The legacy top-level shape this pi-subagents version rejects must never
    // be emitted.
    assert.equal(waveScriptCallShape(script).hasLegacyTasksInput, false);
    // Prompt bytes are inlined verbatim, so the conductor never handles them.
    assert.match(script, /PROMPT BYTES for pre-approval-gate-holistic/);
    // The ready call body is the verified one-call shape.
    assert.equal(plan.calls[0].async, false);
    assert.equal(plan.calls[0].timeoutMs, DEFAULT_WAVE_TIMEOUT_MS);
    assert.equal(plan.calls[0].workflowScriptPath, plan.waves[0].scriptPath);
    assert.equal(typeof plan.calls[0].cwd, "string");
    assert.ok(plan.calls[0].cwd.length > 0);
    // The partition is a function of the round's own recorded artifact.
    assert.equal(plan.maxConcurrentSource, "emit-plan");
    assert.equal(plan.sequential, false);
    assert.equal(plan.sequentialSource, null);
  });
});

test("honors an explicit --cwd and --timeout-ms in the emitted call body", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir);
    assert.equal(await main([...baseArgs(tmpDir), "--cwd", "/some/worktree", "--timeout-ms", "12345"], { loadConfig: configStub() }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.calls[0].cwd, "/some/worktree");
    assert.equal(plan.calls[0].timeoutMs, 12345);
  });
});

// AC: "releases up to gates.fanout.maxConcurrent units concurrently in ONE
// call" + "Definition of done: concurrency bound honored."
test("partitions the round into ceil(n / maxConcurrent) waves, each within the bound", async () => {
  await withTmpDir(async (tmpDir) => {
    const units = Array.from({ length: 6 }, (_, i) => ({ scope: `pre-approval-gate-angle-${i + 1}`, angles: [`angle-${i + 1}`], group: null }));
    await seedEmitPlan(tmpDir, { units, maxConcurrent: 3 });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub() }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.waves.length, 2, "6 units at maxConcurrent 3 is 2 waves");
    assert.equal(plan.calls.length, 2, "one call per wave");
    assert.deepEqual(plan.waves.map((w) => w.count), [3, 3]);
    for (const wave of plan.waves) {
      const script = await readFile(wave.scriptPath, "utf8");
      assert.equal(waveScriptCallShape(script).runsAllCalls, 1);
      assert.equal(wave.keys.length, 3);
    }
    assert.equal(new Set(plan.waves.flatMap((w) => w.keys)).size, 6, "keys are unique across the whole round");
  });
});

// AC: "gates.fanout.sequential: true still resolves to a single-unit wave."
test("gates.fanout.sequential resolves to single-unit waves", async () => {
  await withTmpDir(async (tmpDir) => {
    const units = Array.from({ length: 3 }, (_, i) => ({ scope: `pre-approval-gate-angle-${i + 1}`, angles: [`angle-${i + 1}`], group: null }));
    // The emitter records the EFFECTIVE concurrency, which is 1 when
    // gates.fanout.sequential is set.
    await seedEmitPlan(tmpDir, { units, maxConcurrent: 1 });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ sequential: true }) }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.maxConcurrent, 1);
    assert.equal(plan.sequential, true);
    assert.equal(plan.sequentialSource, "config-flag");
    assert.equal(plan.waves.length, 3, "sequential resolves to one unit per wave");
    assert.deepEqual(plan.waves.map((w) => w.count), [1, 1, 1]);
  });
});

// AC: "any other serialization fails closed instead of silently degrading a
// gates.requireFanoutEvidence gate."
test("an unjustified serialization request fails closed when requireFanoutEvidence is on", async () => {
  await withTmpDir(async (tmpDir) => {
    const { dir } = await seedEmitPlan(tmpDir);
    const { exitCode, stdout } = await captureStdout(() => main([...baseArgs(tmpDir), "--sequential"], { loadConfig: configStub({ sequential: false, requireFanoutEvidence: true }) }));
    assert.equal(exitCode, 1, "exit 1 refusal, not a silent single-unit degrade");
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK/);
    assert.match(payload.error, /gates\.fanout\.sequential/);
    // No script may survive the refusal — a stale script is dispatchable.
    assert.equal(await readFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "utf8").catch(() => null), null);
  });
});

test("serialization is permitted when the gate does not require fan-out evidence", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir);
    assert.equal(await main([...baseArgs(tmpDir), "--sequential"], { loadConfig: configStub({ sequential: false, requireFanoutEvidence: false }) }), 0);
    assert.equal((await readPlan(tmpDir)).waves.length, 3);
  });
});

// AC: "any other serialization fails closed." A resolved effective concurrency
// of 1 that the recorded `gates.fanout.sequential` flag does not back (e.g.
// `gates.fanout.maxConcurrent: 1`) is the same silent serialization.
test("a config-level concurrency of 1 without gates.fanout.sequential fails closed", async () => {
  await withTmpDir(async (tmpDir) => {
    // The emit-plan records the effective 1, so the refusal is the serialization
    // guard, not a recorded-vs-resolved maxConcurrent disagreement.
    const { dir } = await seedEmitPlan(tmpDir, { maxConcurrent: 1 });
    const { exitCode, stdout } = await captureStdout(() => main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 1, sequential: false, requireFanoutEvidence: true }) }));
    assert.equal(exitCode, 1);
    const payload = JSON.parse(stdout);
    assert.match(payload.error, /GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK/);
    assert.match(payload.error, /gates\.fanout\.maxConcurrent: 1/);
    assert.equal(await readFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "utf8").catch(() => null), null);
  });
});

test("a config-level concurrency of 1 is permitted when fan-out evidence is not required", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { maxConcurrent: 1 });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 1, sequential: false, requireFanoutEvidence: false }) }), 0);
    assert.equal((await readPlan(tmpDir)).waves.length, 3);
  });
});

// A truncated/partial emit-plan must not dispatch as a complete round.
test("refuses when the emit-plan's recorded count disagrees with its units", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { count: 2 });
    const { exitCode, stdout } = await captureStdout(() => main(baseArgs(tmpDir), { loadConfig: configStub() }));
    assert.equal(exitCode, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /records count 2 but carries 3/);
  });
});

// A re-run at the same key must partition as the round's own artifact records.
test("refuses when the emit-plan's recorded maxConcurrent disagrees with the resolved value", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { maxConcurrent: 2 });
    const { exitCode, stdout } = await captureStdout(() => main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 3 }) }));
    assert.equal(exitCode, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /records maxConcurrent 2 but the resolved effective fan-out concurrency is 3/);
  });
});

test("falls back to the resolved concurrency when the emit-plan records none", async () => {
  await withTmpDir(async (tmpDir) => {
    const { planPath } = await seedEmitPlan(tmpDir);
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    delete plan.maxConcurrent;
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub() }), 0);
    const out = await readPlan(tmpDir);
    assert.equal(out.maxConcurrent, 3);
    assert.equal(out.maxConcurrentSource, "config");
  });
});

// `sequential` reports the resolved config flag, not the derived concurrency;
// `sequentialSource` names the trigger honestly.
test("reports the resolved sequential flag and its source", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { maxConcurrent: 1 });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 1, sequential: true, requireFanoutEvidence: true }) }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.sequential, true);
    assert.equal(plan.sequentialSource, "config-flag");
    assert.equal(plan.maxConcurrent, 1);
  });
});

test("an explicit --sequential without the config flag reports explicit-request, not a config flag", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { maxConcurrent: 3 });
    assert.equal(await main([...baseArgs(tmpDir), "--sequential"], { loadConfig: configStub({ maxConcurrent: 3, sequential: false, requireFanoutEvidence: false }) }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.sequential, false, "the config flag is off; only the request serialized");
    assert.equal(plan.sequentialSource, "explicit-request");
    assert.equal(plan.maxConcurrent, 1);
    assert.equal(plan.waves.length, 3);
  });
});

test("a config-level concurrency of 1 reports maxConcurrent:1 as the sequential source", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { maxConcurrent: 1 });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 1, sequential: false, requireFanoutEvidence: false }) }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.sequential, false);
    assert.equal(plan.sequentialSource, "maxConcurrent:1");
    assert.equal(plan.maxConcurrent, 1);
  });
});

// #1086 cross-harness non-regression: under the Claude harness the effective
// concurrency is clamped to CLAUDE_MAX_EFFECTIVE_CONCURRENT (2). That clamp is
// NOT an unjustified serialization and must not trip the maxConcurrent === 1
// refusal.
test("the Claude harness clamp partitions at 2 without tripping the maxConcurrent === 1 refusal", async () => {
  await withTmpDir(async (tmpDir) => {
    const units = Array.from({ length: 3 }, (_, i) => ({ scope: `pre-approval-gate-angle-${i + 1}`, angles: [`angle-${i + 1}`], group: null }));
    // The emitter records the EFFECTIVE concurrency, so under CLAUDECODE=1 the
    // plan records 2 even though the configured value is 3.
    await seedEmitPlan(tmpDir, { units, maxConcurrent: 2 });
    const previous = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 3 }) }), 0, "the clamp must not be read as a refusal");
    } finally {
      if (previous === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previous;
    }
    const plan = await readPlan(tmpDir);
    assert.equal(plan.maxConcurrent, 2, "the Claude clamp caps the effective bound at 2");
    assert.equal(plan.sequential, false, "the clamp is not a serialization");
    assert.equal(plan.waves.length, 2, "3 units at an effective 2 is 2 waves");
    assert.deepEqual(plan.waves.map((w) => w.count), [2, 1]);
    for (const wave of plan.waves) assert.ok(wave.count <= 2);
  });
});

// Cleanup branches: every non-success exit after the key is resolved must leave
// no wave artifact (a stale script is dispatchable).
test("clears this key's artifacts when a wave script write fails mid-round", async () => {
  await withTmpDir(async (tmpDir) => {
    const { dir } = await seedEmitPlan(tmpDir);
    const exitCode = await main(baseArgs(tmpDir), {
      loadConfig: configStub(),
      writeScript: async (file, data) => {
        await writeFile(file, data.slice(0, 16), "utf8");
        throw Object.assign(new Error("simulated partial write"), { code: "ENOSPC" });
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(await readFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "utf8").catch(() => null), null);
    assert.equal(await readFile(buildWavePlanPath({ planPath: planPathFor(tmpDir), gate: GATE, headSha: HEAD_SHA }), "utf8").catch(() => null), null);
  });
});

test("clears this key's artifacts when the wave-plan persist fails", async () => {
  await withTmpDir(async (tmpDir) => {
    const { dir } = await seedEmitPlan(tmpDir);
    const exitCode = await main(baseArgs(tmpDir), {
      loadConfig: configStub(),
      persistPlan: async () => {
        throw Object.assign(new Error("simulated persist failure"), { code: "EIO" });
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(await readFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "utf8").catch(() => null), null);
    assert.equal(await readFile(buildWavePlanPath({ planPath: planPathFor(tmpDir), gate: GATE, headSha: HEAD_SHA }), "utf8").catch(() => null), null);
  });
});

// The --jq validation runs AFTER the start-of-flow clear, so even an invalid
// filter (which exits 2 before the plan is read) leaves no stale wave artifact.
test("an invalid --jq filter exits 2 and leaves no stale wave artifact", async () => {
  await withTmpDir(async (tmpDir) => {
    const { dir } = await seedEmitPlan(tmpDir);
    await writeFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "stale script", "utf8");
    await writeFile(buildWavePlanPath({ planPath: planPathFor(tmpDir), gate: GATE, headSha: HEAD_SHA }), "{}", "utf8");
    assert.equal(await main([...baseArgs(tmpDir), "--jq", 'error("boom")'], { loadConfig: configStub() }), 2);
    assert.equal(await readFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "utf8").catch(() => null), null);
    assert.equal(await readFile(buildWavePlanPath({ planPath: planPathFor(tmpDir), gate: GATE, headSha: HEAD_SHA }), "utf8").catch(() => null), null);
  });
});

// A data-dependent --jq error fails AFTER the artifacts are written; the
// success-path guard must still clear them.
test("a data-dependent --jq error exits 2 and clears the just-written wave artifacts", async () => {
  await withTmpDir(async (tmpDir) => {
    const { dir } = await seedEmitPlan(tmpDir);
    // `.count | length` is syntactically valid but fails at evaluation (count is
    // a number), so it reaches emitResult after the scripts were persisted.
    assert.equal(await main([...baseArgs(tmpDir), "--jq", ".count | length"], { loadConfig: configStub() }), 2);
    assert.equal(await readFile(path.join(dir, `${GATE}-${HEAD_SHA}.wave-1.js`), "utf8").catch(() => null), null);
    assert.equal(await readFile(buildWavePlanPath({ planPath: planPathFor(tmpDir), gate: GATE, headSha: HEAD_SHA }), "utf8").catch(() => null), null);
  });
});

// AC: "fails when a unit lacks a key."
test("refuses when a dispatch unit carries no key", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { units: [{ angles: ["holistic"], group: null }] });
    const { exitCode, stdout } = await captureStdout(() => main(baseArgs(tmpDir), { loadConfig: configStub() }));
    assert.equal(exitCode, 1);
    assert.match(JSON.parse(stdout).error, /GATE-EXEC-FANOUT-DISPATCH-KEY/);
  });
});

test("refuses when a unit's promptPath is missing or unreadable", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { units: [{ scope: "pre-approval-gate-holistic", angles: ["holistic"], group: null, promptPath: "/nonexistent/prompt.txt" }] });
    const { exitCode, stdout } = await captureStdout(() => main(baseArgs(tmpDir), { loadConfig: configStub() }));
    assert.equal(exitCode, 1);
    assert.match(JSON.parse(stdout).error, /unreadable/);
  });
});

test("refuses when the emit-plan carries no units", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir, { units: [] });
    const { exitCode, stdout } = await captureStdout(() => main(baseArgs(tmpDir), { loadConfig: configStub() }));
    assert.equal(exitCode, 1);
    assert.match(JSON.parse(stdout).error, /no dispatch units/);
  });
});

test("waveDispatchKey prefers an explicit key and falls back to scope", () => {
  assert.equal(waveDispatchKey({ key: "explicit", scope: "scoped" }), "explicit");
  assert.equal(waveDispatchKey({ scope: " scoped " }), "scoped");
  assert.equal(waveDispatchKey({ scope: "" }), "");
  assert.equal(waveDispatchKey({}), "");
  assert.equal(waveDispatchKey(null), "");
});

// AC: "fails when ... units are emitted as separate calls."
test("validateWaveDispatchPlan rejects a wave partition that does not honor maxConcurrent", () => {
  const script = renderWaveWorkflowScript({ gate: GATE, headSha: HEAD_SHA, waveIndex: 1, waveCount: 1, units: [{ key: "a", promptBytes: "p" }] });
  // Six units emitted as SIX separate single-unit calls while maxConcurrent is
  // 3 — the exact shape a conductor produces when it dispatches unit by unit.
  const serialized = { maxConcurrent: 3, count: 6, waves: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, keys: [`angle-${i + 1}`], script })) };
  const result = validateWaveDispatchPlan(serialized);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /separate calls/.test(e)), result.errors.join("; "));
});

test("validateWaveDispatchPlan rejects blank, duplicated, and over-bound keys", () => {
  const script = renderWaveWorkflowScript({ gate: GATE, headSha: HEAD_SHA, waveIndex: 1, waveCount: 1, units: [{ key: "a", promptBytes: "p" }] });
  const blank = validateWaveDispatchPlan({ maxConcurrent: 3, count: 1, waves: [{ index: 1, keys: ["  "], script }] });
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.some((e) => /blank dispatch key/.test(e)));
  const dup = validateWaveDispatchPlan({ maxConcurrent: 3, count: 2, waves: [{ index: 1, keys: ["same", "same"], script }] });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => /duplicated/.test(e)));
  const over = validateWaveDispatchPlan({ maxConcurrent: 1, count: 2, waves: [{ index: 1, keys: ["a", "b"], script }] });
  assert.equal(over.ok, false);
  assert.ok(over.errors.some((e) => /exceeding the maxConcurrent bound/.test(e)));
  const shortCoverage = validateWaveDispatchPlan({ maxConcurrent: 3, count: 3, waves: [{ index: 1, keys: ["a"], script }] });
  assert.equal(shortCoverage.ok, false);
  assert.ok(shortCoverage.errors.some((e) => /every dispatch unit must appear exactly once/.test(e)));
});

test("validateWaveDispatchPlan rejects a wave that is not exactly one runs.all call or that uses tasks:", () => {
  const good = renderWaveWorkflowScript({ gate: GATE, headSha: HEAD_SHA, waveIndex: 1, waveCount: 1, units: [{ key: "a", promptBytes: "p" }] });
  const twoCalls = `${good}\nreturn runs.all([]);\n`;
  const twoCallResult = validateWaveDispatchPlan({ maxConcurrent: 3, count: 1, waves: [{ index: 1, keys: ["a"], script: twoCalls }] });
  assert.equal(twoCallResult.ok, false);
  assert.ok(twoCallResult.errors.some((e) => /exactly ONE runs\.all call/.test(e)));
  const legacy = good.replace("return runs.all([", "return tasks: [");
  const legacyResult = validateWaveDispatchPlan({ maxConcurrent: 3, count: 1, waves: [{ index: 1, keys: ["a"], script: legacy }] });
  assert.equal(legacyResult.ok, false);
  assert.ok(legacyResult.errors.some((e) => /tasks:/.test(e)));
  assert.equal(validateWaveDispatchPlan({ maxConcurrent: 3, count: 1, waves: [{ index: 1, keys: ["a"], script: good }] }).ok, true);
});

test("renderWaveWorkflowScript escapes line separators and emits no tasks: input", () => {
  const script = renderWaveWorkflowScript({ gate: GATE, headSha: HEAD_SHA, waveIndex: 1, waveCount: 1, units: [{ key: "k", promptBytes: "a\u2028b\u2029c" }] });
  assert.match(script, /\\u2028/);
  assert.match(script, /\\u2029/);
  const shape = waveScriptCallShape(script);
  assert.equal(shape.hasLegacyTasksInput, false);
  assert.equal(shape.runsAllCalls, 1);
});

// The inlined reviewer prompt bytes may legitimately mention runs.all or a
// tasks: field; that prose is DATA, never the script's own call shape.
test("waveScriptCallShape reads code only, never the inlined prompt prose", () => {
  const script = renderWaveWorkflowScript({ gate: GATE, headSha: HEAD_SHA, waveIndex: 1, waveCount: 1, units: [{ key: "k", promptBytes: "reviewers use runs.all([...]) and never tasks: [...]\nreturn runs.all([0]);" }] });
  const shape = waveScriptCallShape(script);
  assert.equal(shape.runsAllCalls, 1);
  assert.equal(shape.hasLegacyTasksInput, false);
});

test("the generated wave script is loadable JavaScript", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedEmitPlan(tmpDir);
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub() }), 0);
    const plan = await readPlan(tmpDir);
    const scriptPath = plan.waves[0].scriptPath;
    const probe = path.join(tmpDir, "probe.mjs");
    // `runs` is the pi-subagents workflow-script scope binding; the probe
    // supplies a recorder and asserts the emitted body is executable and
    // returns exactly one runs.all call with the expected keys.
    await writeFile(probe, `import { readFileSync, writeFileSync } from "node:fs";\nconst calls = [];\nconst runs = { all: (items) => { calls.push(items); return items; } };\nconst body = readFileSync(${JSON.stringify(scriptPath)}, "utf8");\nconst fn = new Function("runs", body);\nconst out = fn(runs);\nwriteFileSync(${JSON.stringify(path.join(tmpDir, "probe-out.json"))}, JSON.stringify({ callCount: calls.length, keys: out.map((i) => i.key), agents: out.map((i) => i.agent), contexts: out.map((i) => i.context), taskHasPrompt: out.every((i) => typeof i.task === "string" && i.task.length > 0) }));\n`, "utf8");
    const probeResult = spawnSync("node", [probe], { encoding: "utf8" });
    assert.equal(probeResult.status, 0, probeResult.stderr);
    const out = JSON.parse(await readFile(path.join(tmpDir, "probe-out.json"), "utf8"));
    assert.equal(out.callCount, 1, "the script must make exactly ONE runs.all call");
    assert.deepEqual(out.keys, plan.waves[0].keys);
    assert.deepEqual(out.agents, ["review", "review", "review"]);
    assert.deepEqual(out.contexts, ["fresh", "fresh", "fresh"]);
    assert.equal(out.taskHasPrompt, true);
  });
});

// Code generation is the seam most likely to break, so the probe must run on
// the bytes that break it: quotes, backslashes, template literals, interpolation
// markers, a script-closing tag, a comment introducer, and a line separator.
test("the emitted script stays loadable and byte-exact for adversarial prompt bytes", async () => {
  await withTmpDir(async (tmpDir) => {
    const nasty = 'quote" back\\slash `tick` ${expr} </script> // comment\nline\u2028sep\u2029par\nreturn runs.all([1]);\ntasks: ["x"]';
    await seedEmitPlan(tmpDir, { units: [{ scope: "pre-approval-gate-nasty", angles: ["nasty"], group: null, promptBytes: nasty }] });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub() }), 0);
    const plan = await readPlan(tmpDir);
    const probe = path.join(tmpDir, "nasty-probe.mjs");
    const outPath = path.join(tmpDir, "nasty-probe-out.json");
    await writeFile(probe, `import { readFileSync, writeFileSync } from "node:fs";\nconst calls = [];\nconst runs = { all: (items) => { calls.push(items); return items; } };\nconst fn = new Function("runs", readFileSync(${JSON.stringify(plan.waves[0].scriptPath)}, "utf8"));\nconst out = fn(runs);\nwriteFileSync(${JSON.stringify(outPath)}, JSON.stringify({ callCount: calls.length, keys: out.map((i) => i.key), tasks: out.map((i) => i.task) }));\n`, "utf8");
    const probeResult = spawnSync("node", [probe], { encoding: "utf8" });
    assert.equal(probeResult.status, 0, probeResult.stderr);
    const out = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(out.callCount, 1);
    assert.deepEqual(out.keys, ["pre-approval-gate-nasty"]);
    // Byte-exact delivery: the reviewer receives exactly the composed bytes.
    assert.equal(out.tasks[0], nasty);
    // The adversarial prose in the DATA must not be read as the script's own shape.
    const script = await readFile(plan.waves[0].scriptPath, "utf8");
    assert.equal(waveScriptCallShape(script).runsAllCalls, 1);
    assert.equal(waveScriptCallShape(script).hasLegacyTasksInput, false);
    // Pin the escaping BRANCH, not just the round-trip: ES2019+ accepts raw
    // U+2028/U+2029 inside a string literal, so the byte-exact assertion above
    // stays green even if the escaping were dropped. Only the emitted escape
    // sequences prove the pre-ES2019 guarantee is still applied.
    assert.match(script, /\\u2028/);
    assert.match(script, /\\u2029/);
    assert.doesNotMatch(script, /\u2028|\u2029/);
  });
});

test("partitionWaves preserves order and never exceeds the bound", () => {
  assert.deepEqual(partitionWaves([1, 2, 3, 4, 5, 6, 7], 3).map((w) => w.length), [3, 3, 1]);
  assert.deepEqual(partitionWaves([1, 2], 1).map((w) => w.length), [1, 1]);
  assert.deepEqual(partitionWaves([], 3), []);
  assert.deepEqual(partitionWaves([1, 2, 3], 0).map((w) => w.length), [1, 1, 1]);
});

test("buildWaveScriptPath keys the script to gate and head", () => {
  const planPath = `/tmp/gate-context/o-r/pr-7/${GATE}-${HEAD_SHA}.emit-plan.json`;
  assert.equal(buildWaveScriptPath({ planPath, gate: GATE, headSha: HEAD_SHA, index: 2 }), `/tmp/gate-context/o-r/pr-7/${GATE}-${HEAD_SHA}.wave-2.js`);
});

test("CLI usage errors exit 2 with a stderr hint", () => {
  const missingPr = runCli(["--repo", REPO]);
  assert.equal(missingPr.status, 2);
  assert.match(missingPr.stderr, /--pr is required/);
  const badTimeout = runCli([...baseArgs("/tmp"), "--timeout-ms", "0"]);
  assert.equal(badTimeout.status, 2);
  assert.match(badTimeout.stderr, /--timeout-ms/);
  const badSha = runCli(["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", "short"]);
  assert.equal(badSha.status, 2);
  assert.match(badSha.stderr, /--head-sha/);
  const badGate = runCli(["--repo", REPO, "--pr", PR, "--gate", "nope", "--head-sha", HEAD_SHA]);
  assert.equal(badGate.status, 2);
  assert.match(badGate.stderr, /--gate/);
});
