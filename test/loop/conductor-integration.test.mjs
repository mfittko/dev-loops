import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runConductor } from "../../scripts/loop/conductor.mjs";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/conductor.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// ---------------------------------------------------------------------------
// Config stub helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal .pi/dev-loop/settings.yaml and return cleanup helper.
 */
async function setupConfigDir(requireRetrospective = false, extraSettings = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-config-"));
  const configDir = path.join(tempDir, ".pi", "dev-loop");
  await mkdir(configDir, { recursive: true });

  const settings = {
    version: 1,
    workflow: {
      requireRetrospective,
      requireDraftFirst: false,
      devModeDefault: false,
    },
    ...extraSettings,
  };

  // Simple YAML writer for test configs
  const yamlLines = [];
  for (const [k, v] of Object.entries(settings)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      yamlLines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v)) {
        yamlLines.push(`  ${sk}: ${typeof sv === "boolean" ? sv : JSON.stringify(sv)}`);
      }
    } else if (Array.isArray(v)) {
      yamlLines.push(`${k}:`);
      for (const item of v) {
        yamlLines.push(`  - ${typeof item === "string" ? item : JSON.stringify(item)}`);
      }
    } else {
      yamlLines.push(`${k}: ${typeof v === "boolean" ? v : JSON.stringify(v)}`);
    }
  }

  await writeFile(path.join(configDir, "settings.yaml"), yamlLines.join("\n"), "utf8");

  return {
    repoRoot: tempDir,
    configDir,
    cleanup: async () => { await rm(tempDir, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------------------
// Unit: retrospective gate with config
// ---------------------------------------------------------------------------

test("runConductor blocks when requireRetrospective is true and checkpoint is required", async () => {
  const { repoRoot, cleanup } = await setupConfigDir(true);

  try {
    const piDir = path.join(repoRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required", triggeredAt: "2026-06-05T00:00:00.000Z" }),
    );

    const fakeLoadConfig = async () => ({
      config: {
        version: 1,
        workflow: { requireRetrospective: true, requireDraftFirst: false, devModeDefault: false },
        autonomy: { stopAt: ["merge"] },
        gates: { draft: { requireCi: true }, preApproval: { requireCi: true } },
      },
      warnings: [],
      errors: [],
    });

    const result = await runConductor(
      { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false },
      { env: process.env, ghCommand: "gh", repoRoot, loadConfigImpl: fakeLoadConfig },
    );

    assert.equal(result.ok, false);
    assert.equal(result.blockedByRetrospective, true);
    assert.match(result.error, /Retrospective checkpoint pending/);
    assert.equal(result.cycle, undefined);
    assert.equal(result.monitor, undefined);
  } finally {
    await cleanup();
  }
});

test("runConductor does NOT block when requireRetrospective is false even if checkpoint is required", async () => {
  const { repoRoot, cleanup } = await setupConfigDir(false);

  try {
    const piDir = path.join(repoRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required", triggeredAt: "2026-06-05T00:00:00.000Z" }),
    );

    const fakeLoadConfig = async () => ({
      config: {
        version: 1,
        workflow: { requireRetrospective: false, requireDraftFirst: false, devModeDefault: false },
        autonomy: { stopAt: ["merge"] },
        gates: { draft: { requireCi: true }, preApproval: { requireCi: true } },
      },
      warnings: [],
      errors: [],
    });

    const result = await runConductor(
      { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false },
      { env: process.env, ghCommand: "gh", repoRoot, loadConfigImpl: fakeLoadConfig },
    );

    assert.equal(result.blockedByRetrospective, undefined);
    assert.equal(result.monitor, null);
    assert.ok(result.cycle !== null);
  } finally {
    await cleanup();
  }
});

test("runConductor blocks when --require-retrospective override is true and checkpoint is required", async () => {
  const { repoRoot, cleanup } = await setupConfigDir(false);

  try {
    const piDir = path.join(repoRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required", triggeredAt: "2026-06-05T00:00:00.000Z" }),
    );

    const fakeLoadConfig = async () => ({
      config: {
        version: 1,
        workflow: { requireRetrospective: false, requireDraftFirst: false, devModeDefault: false },
        autonomy: { stopAt: ["merge"] },
        gates: { draft: { requireCi: true }, preApproval: { requireCi: true } },
      },
      warnings: [],
      errors: [],
    });

    const result = await runConductor(
      { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false, requireRetrospective: true },
      { env: process.env, ghCommand: "gh", repoRoot, loadConfigImpl: fakeLoadConfig },
    );

    assert.equal(result.ok, false);
    assert.equal(result.blockedByRetrospective, true);
    assert.match(result.error, /Retrospective checkpoint pending/);
  } finally {
    await cleanup();
  }
});

test("runConductor does NOT block when checkpoint file is missing regardless of requireRetrospective", async () => {
  const { repoRoot, cleanup } = await setupConfigDir(true);

  try {
    // No checkpoint file at all
    const fakeLoadConfig = async () => ({
      config: {
        version: 1,
        workflow: { requireRetrospective: true, requireDraftFirst: false, devModeDefault: false },
        autonomy: { stopAt: ["merge"] },
        gates: { draft: { requireCi: true }, preApproval: { requireCi: true } },
      },
      warnings: [],
      errors: [],
    });

    const result = await runConductor(
      { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false },
      { env: process.env, ghCommand: "gh", repoRoot, loadConfigImpl: fakeLoadConfig },
    );

    assert.equal(result.blockedByRetrospective, undefined);
    assert.equal(result.monitor, null);
    assert.ok(result.cycle !== null);
  } finally {
    await cleanup();
  }
});

test("runConductor includes config in output", async () => {
  const { repoRoot, cleanup } = await setupConfigDir(true);

  try {
    const fakeLoadConfig = async () => ({
      config: {
        version: 1,
        workflow: { requireRetrospective: true, requireDraftFirst: true, devModeDefault: true },
        autonomy: { stopAt: ["merge", "pre-approval"] },
        gates: { draft: { requireCi: false }, preApproval: { requireCi: true } },
      },
      warnings: [],
      errors: [],
    });

    const result = await runConductor(
      { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false },
      { env: process.env, ghCommand: "gh", repoRoot, loadConfigImpl: fakeLoadConfig },
    );

    assert.equal(result.config.requireRetrospective, true);
    assert.deepEqual(result.config.autonomyStopAt, ["merge", "pre-approval"]);
    assert.equal(result.config.gateConfig.draft.requireCi, false);
    assert.equal(result.config.gateConfig.preApproval.requireCi, true);
  } finally {
    await cleanup();
  }
});

test("runConductor handles config load failure gracefully with safe defaults", async () => {
  const fakeLoadConfig = async () => { throw new Error("Config file corrupted"); };

  const result = await runConductor(
    { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false },
    { env: process.env, ghCommand: "gh", repoRoot: process.cwd(), loadConfigImpl: fakeLoadConfig },
  );

  assert.equal(result.config.requireRetrospective, false);
  assert.deepEqual(result.config.autonomyStopAt, ["merge"]);
  assert.equal(result.config.configErrors, 1);
  assert.equal(result.monitor, null);
  assert.ok(result.cycle !== null);
});

// ---------------------------------------------------------------------------
// Unit: runConductor with real gh unavailable (graceful degradation)
// ---------------------------------------------------------------------------

test("runConductor degrades gracefully with cycle-only", async () => {
  const result = await runConductor(
    { repo: "test/repo", cycleOnly: true, monitorOnly: false, autoResume: false },
    {
      env: process.env,
      ghCommand: "gh",
      repoRoot: process.cwd(),
    },
  );

  assert.equal(result.monitor, null);
  assert.ok(result.cycle !== null);
  assert.ok("ok" in result.cycle || "error" in (result.cycle ?? {}));
});

test("runConductor degrades gracefully with monitor-only", async () => {
  const result = await runConductor(
    { repo: "test/repo", cycleOnly: false, monitorOnly: true, autoResume: false },
    {
      env: process.env,
      ghCommand: "gh",
      repoRoot: process.cwd(),
    },
  );

  assert.equal(result.cycle, null);
  assert.ok(result.monitor !== null);
});

// ---------------------------------------------------------------------------
// CLI: gh stub integration (cycle-only to avoid parallel gh consumption)
// ---------------------------------------------------------------------------

test("conductor --cycle-only CLI reports empty queue when no open PRs exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-cycle-only-"));

  try {
    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }]);

    const { code, stdout, stderr } = await runNode(["--repo", "owner/repo", "--cycle-only"], { env });

    assert.equal(code, 0);
    assert.equal(stderr, "");

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.monitor, null);
    assert.equal(payload.cycle.prCount, 0);
    assert.deepEqual(payload.cycle.actions, []);
    assert.equal(payload.summary.totalPrs, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor --monitor-only CLI reports queue_complete when no open PRs exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-monitor-only-"));

  try {
    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }]);

    const { code, stdout, stderr } = await runNode(["--repo", "owner/repo", "--monitor-only"], { env });

    assert.equal(code, 0);
    assert.equal(stderr, "");

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.cycle, null);
    assert.equal(payload.monitor.queueStatus, "queue_complete");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("conductor --require-retrospective CLI blocks when checkpoint is pending", async () => {
  const { repoRoot, cleanup } = await setupConfigDir(false);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-require-retro-"));

  try {
    const piDir = path.join(repoRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      path.join(piDir, "dev-loop-retrospective-checkpoint.json"),
      JSON.stringify({ state: "required", triggeredAt: "2026-06-05T00:00:00.000Z" }),
    );

    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }]);

    const { code, stdout, stderr } = await runNode(
      ["--repo", "owner/repo", "--cycle-only", "--require-retrospective"],
      { env, cwd: repoRoot },
    );

    assert.equal(code, 1);
    assert.equal(stdout, "");
    const payload = JSON.parse(stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.blockedByRetrospective, true);
    assert.match(payload.error, /Retrospective checkpoint pending/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("conductor CLI with both cycle and monitor uses repeat-last for sequential gh calls", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-conductor-both-"));

  try {
    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }], { repeatLastOnOverflow: true });

    const { code, stdout, stderr } = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(code, 0);
    assert.equal(stderr, "");

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.cycle.prCount, 0);
    assert.equal(payload.cycle.actions.length, 0);
    assert.equal(payload.monitor.queueStatus, "queue_complete");
    assert.equal(payload.monitor.prCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
