import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { main } from "../../scripts/github/emit-coordinator-phase-blocked.mjs";
import { ROLE_BUDGETS } from "@dev-loops/core/loop/role-budget-bound";

const HEAD_SHA = "d".repeat(40);
const RUN = "run-1";
const BUDGET = ROLE_BUDGETS.coordinator_phase;

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-emit-coordinator-phase-blocked-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readArtifacts(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const artifacts = [];
  for (const name of entries.filter((n) => n.endsWith(".json")).sort()) {
    artifacts.push(JSON.parse(await readFile(path.join(dir, name), "utf8")));
  }
  return artifacts;
}

function baseArgs(overrides = {}) {
  const args = {
    "--run": RUN,
    "--head-sha": HEAD_SHA,
    "--model-turns": String(BUDGET.maxModelTurns),
    "--tool-calls": String(BUDGET.maxToolCalls),
    "--output-tokens": String(BUDGET.maxOutputTokens),
    ...overrides,
  };
  const argv = [];
  for (const [flag, value] of Object.entries(args)) {
    if (value === undefined) continue;
    argv.push(flag, value);
  }
  return argv;
}

test("--help exits 0", async () => {
  const code = await main(["--help"]);
  assert.equal(code, 0);
});

test("requires --head-sha/--model-turns/--tool-calls/--output-tokens/--findings-dir (--run is optional)", async () => {
  assert.equal(await main([]), 2);
  assert.equal(await main(["--run", RUN, "--head-sha", HEAD_SHA]), 2);
});

test("--run is optional: an explicit empty value is still rejected", async () => {
  assert.equal(
    await main(["--run", "--head-sha", HEAD_SHA, "--model-turns", "0", "--tool-calls", "0", "--output-tokens", "0", "--findings-dir", "unused"]),
    2,
  );
});

test("missing/empty --findings-dir is rejected", async () => {
  await withTmpDir(async (tmpDir) => {
    void tmpDir;
    const argv = baseArgs({ "--findings-dir": undefined, "--model-turns": String(BUDGET.maxModelTurns + 1) });
    assert.equal(await main(argv), 2);
  });
});

test("invalid --head-sha is rejected", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--head-sha": "not-a-sha", "--findings-dir": findingsDir });
    assert.equal(await main(argv), 2);
  });
});

test("invalid --harness is rejected", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--harness": "borg", "--findings-dir": findingsDir });
    assert.equal(await main(argv), 2);
  });
});

test("--head-sha is lowercased", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({
      "--head-sha": HEAD_SHA.toUpperCase(),
      "--model-turns": String(BUDGET.maxModelTurns + 1),
      "--findings-dir": findingsDir,
    });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts[0].headSha, HEAD_SHA);
  });
});

test("within budget exits 1 and writes nothing", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--findings-dir": findingsDir });
    const code = await main(argv);
    assert.equal(code, 1);
    assert.deepEqual(await readArtifacts(findingsDir), []);
  });
});

test("modelTurns over budget writes one blocked artifact naming modelTurns", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--model-turns": String(BUDGET.maxModelTurns + 1), "--findings-dir": findingsDir });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    const [artifact] = artifacts;
    assert.equal(artifact.angle, "coordinator-phase");
    assert.equal(artifact.verdict, "blocked");
    assert.equal(artifact.role, "coordinator_phase");
    assert.equal(artifact.headSha, HEAD_SHA);
    assert.deepEqual(artifact.findings, []);
    assert.deepEqual(artifact.exceededDimensions, ["modelTurns"]);
    assert.equal(artifact.reason, "coordinator_phase_budget_exhausted");
    assert.deepEqual(artifact.consumed, { modelTurns: BUDGET.maxModelTurns + 1, toolCalls: BUDGET.maxToolCalls, outputTokens: BUDGET.maxOutputTokens });
    assert.deepEqual(artifact.budget, BUDGET);
    assert.equal(artifact.remainingWork, undefined);
  });
});

test("toolCalls over budget writes one blocked artifact naming toolCalls", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--tool-calls": String(BUDGET.maxToolCalls + 1), "--findings-dir": findingsDir });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    assert.deepEqual(artifacts[0].exceededDimensions, ["toolCalls"]);
  });
});

test("outputTokens over budget writes one blocked artifact naming outputTokens", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--output-tokens": String(BUDGET.maxOutputTokens + 1), "--findings-dir": findingsDir });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    assert.deepEqual(artifacts[0].exceededDimensions, ["outputTokens"]);
  });
});

test("--remaining-work is included in the blocked artifact when passed", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({
      "--model-turns": String(BUDGET.maxModelTurns + 1),
      "--findings-dir": findingsDir,
      "--remaining-work": "finish reviewer fan-in consolidation",
    });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts[0].remainingWork, "finish reviewer fan-in consolidation");
  });
});

test("--remaining-work is absent from the artifact when not passed", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--model-turns": String(BUDGET.maxModelTurns + 1), "--findings-dir": findingsDir });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(Object.hasOwn(artifacts[0], "remainingWork"), false);
  });
});

test("--run defaults to --head-sha when omitted, and the resulting blocked artifact still writes correctly", async () => {
  await withTmpDir(async (tmpDir) => {
    const findingsDir = path.join(tmpDir, "findings");
    const argv = baseArgs({ "--run": undefined, "--model-turns": String(BUDGET.maxModelTurns + 1), "--findings-dir": findingsDir });
    const code = await main(argv);
    assert.equal(code, 0);
    const artifacts = await readArtifacts(findingsDir);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].headSha, HEAD_SHA);
  });
});

test("cross-harness parity: pi/claude/codex produce byte-identical artifact bodies", async () => {
  await withTmpDir(async (tmpDir) => {
    const bodies = {};
    for (const harness of ["pi", "claude", "codex"]) {
      const findingsDir = path.join(tmpDir, harness);
      const argv = baseArgs({
        "--model-turns": String(BUDGET.maxModelTurns + 1),
        "--findings-dir": findingsDir,
        "--harness": harness,
      });
      const code = await main(argv);
      assert.equal(code, 0);
      const [entry] = await readdir(findingsDir);
      bodies[harness] = await readFile(path.join(findingsDir, entry), "utf8");
    }
    assert.equal(bodies.pi, bodies.claude);
    assert.equal(bodies.claude, bodies.codex);
  });
});

test("mkdirFn/writeFileFn injection: writes exactly one artifact without touching disk", async () => {
  const mkdirCalls = [];
  const writeCalls = [];
  const argv = baseArgs({ "--model-turns": String(BUDGET.maxModelTurns + 1), "--findings-dir": "/virtual/findings" });
  const code = await main(argv, {
    mkdirFn: async (dir, opts) => {
      mkdirCalls.push({ dir, opts });
    },
    writeFileFn: async (filePath, contents, encoding) => {
      writeCalls.push({ filePath, contents, encoding });
    },
  });
  assert.equal(code, 0);
  assert.equal(mkdirCalls.length, 1);
  assert.equal(mkdirCalls[0].dir, "/virtual/findings");
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].filePath, path.join("/virtual/findings", "coordinator-phase.json"));
  const body = JSON.parse(writeCalls[0].contents);
  assert.equal(body.angle, "coordinator-phase");
  assert.equal(body.verdict, "blocked");
});
