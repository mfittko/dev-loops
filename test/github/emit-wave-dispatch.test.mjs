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
async function seedEmitPlan(tmpDir, { units = DEFAULT_UNITS, maxConcurrent = 3 } = {}) {
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
  await writeFile(planPath, `${JSON.stringify({ ok: true, gate: GATE, headSha: HEAD_SHA, repo: REPO, pr: PR, count: withPrompts.length, maxConcurrent, units: withPrompts }, null, 2)}\n`, "utf8");
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
    const keys = [...script.matchAll(/key:\s*"([^"]*)"/g)].map((m) => m[1]);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3, "every runs.all item needs a UNIQUE key");
    for (const key of keys) assert.ok(key.trim().length > 0, "keys must be non-empty");
    assert.deepEqual(plan.waves[0].keys, keys);
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
      assert.equal([...script.matchAll(/key:\s*"([^"]*)"/g)].length, 3);
    }
    assert.equal(new Set(plan.waves.flatMap((w) => w.keys)).size, 6, "keys are unique across the whole round");
  });
});

// AC: "gates.fanout.sequential: true still resolves to a single-unit wave."
test("gates.fanout.sequential resolves to single-unit waves", async () => {
  await withTmpDir(async (tmpDir) => {
    const units = Array.from({ length: 3 }, (_, i) => ({ scope: `pre-approval-gate-angle-${i + 1}`, angles: [`angle-${i + 1}`], group: null }));
    await seedEmitPlan(tmpDir, { units, maxConcurrent: 3 });
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ sequential: true }) }), 0);
    const plan = await readPlan(tmpDir);
    assert.equal(plan.maxConcurrent, 1);
    assert.equal(plan.sequential, true);
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
    const { dir } = await seedEmitPlan(tmpDir);
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
    await seedEmitPlan(tmpDir);
    assert.equal(await main(baseArgs(tmpDir), { loadConfig: configStub({ maxConcurrent: 1, sequential: false, requireFanoutEvidence: false }) }), 0);
    assert.equal((await readPlan(tmpDir)).waves.length, 3);
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
