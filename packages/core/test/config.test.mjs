import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  DevLoopConfigSchema,
  FileConfigSchema,
  BUILT_IN_DEFAULTS,
} from "../src/config/config.mjs";
import {
  resolveConductorModel,
  resolveAutonomyStopAt,
  resolveRefinementConfig,
  resolveRefinement,
  resolveGateConfig,
  resolveGateAngles,
  resolveGateAnglesDynamic,
  resolveWorkflowConfig,
  resolveLightMode,
} from "../src/config/config.mjs";
// ============================================================================
// Schema validation tests (S1–S26)
// ============================================================================

describe("schema validation", () => {
  test("S1: full valid config parses successfully", () => {
    const input = {
      version: 1,
      strategy: { default: "local-first" },
      models: { conductor: "gpt-5", roles: { security: "gpt-5" } },
      refinement: { fanOut: 5, mode: "sequential", roles: ["security"] },
      gates: {
        draft: { angles: ["style", "correctness"], required: true, requireCi: true },
        preApproval: { angles: ["dry", "kiss", "yagni"], required: false, requireCi: true },
      },
      autonomy: { stopAt: ["draft-pr", "merge"] },
      workflow: {
        asyncStartMode: "required",
        requireRetrospective: true,
        requireRetrospectiveGate: false,
        requireDraftFirst: false,
        devModeDefault: true,
      },
    };
    const result = DevLoopConfigSchema.safeParse(input);
    assert.ok(result.success, "full config should parse");
    assert.equal(result.data.version, 1);
  });

  test("S2: minimal config (only version: 1) parses successfully", () => {
    const result = DevLoopConfigSchema.safeParse({ version: 1 });
    assert.ok(result.success);
    assert.equal(result.data.version, 1);
    // Optional families are undefined — BUILT_IN_DEFAULTS fills gaps at load time
    assert.equal(result.data.strategy, undefined);
    assert.equal(result.data.refinement, undefined);
  });

  test("S3: missing version field", () => {
    const result = DevLoopConfigSchema.safeParse({});
    assert.ok(!result.success);
  });

  test("S4: wrong version (version: 2)", () => {
    const result = DevLoopConfigSchema.safeParse({ version: 2 });
    assert.ok(!result.success);
  });

  test("S5: unknown top-level key rejected", () => {
    const result = DevLoopConfigSchema.safeParse({ version: 1, unknownKey: true });
    assert.ok(!result.success);
  });

  test("S6: unknown nested key inside strategy rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      strategy: { default: "github-first", unknownKey: true },
    });
    assert.ok(!result.success);
  });

  test("S7: unknown nested key inside models rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { conductor: "gpt-5", unknownKey: true },
    });
    assert.ok(!result.success);
  });

  test("S8: unknown nested key inside refinement rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 3, unknownKey: true },
    });
    assert.ok(!result.success);
  });

  test("S9: unknown nested key inside gates rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      gates: { unknownKey: true },
    });
    assert.ok(!result.success);
  });

  test("S10: unknown nested key inside autonomy rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      autonomy: { stopAt: ["merge"], unknownKey: true },
    });
    assert.ok(!result.success);
  });

  test("S10b: workflow family parses when all supported keys are present", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      workflow: {
        asyncStartMode: "required",
        requireRetrospective: true,
        requireRetrospectiveGate: false,
        requireDraftFirst: false,
        devModeDefault: true,
      },
    });
    assert.ok(result.success);
    assert.equal(result.data.workflow.asyncStartMode, "required");
    assert.equal(result.data.workflow.requireRetrospective, true);
    assert.equal(result.data.workflow.requireRetrospectiveGate, false);
    assert.equal(result.data.workflow.requireDraftFirst, false);
    assert.equal(result.data.workflow.devModeDefault, true);
  });

  test("S10c: unknown nested key inside workflow rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      workflow: {
        asyncStartMode: "required",
        requireRetrospective: true,
        requireRetrospectiveGate: false,
        requireDraftFirst: false,
        devModeDefault: true,
        unknownKey: true,
      },
    });
    assert.ok(!result.success);
  });

  test("S11: strategy.default bad enum", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      strategy: { default: "neither" },
    });
    assert.ok(!result.success);
  });

  test("S11b: inputSource.default bad enum", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      inputSource: { default: "local-docs" },
    });
    assert.ok(!result.success);
  });

  test("S12: refinement.mode bad enum", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 3, mode: "async" },
    });
    assert.ok(!result.success);
  });

  test("S13: refinement.fanOut is 0", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 0 },
    });
    assert.ok(!result.success);
  });

  test("S14: refinement.fanOut is 11", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 11 },
    });
    assert.ok(!result.success);
  });

  test("S15: refinement.fanOut is a float", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 2.5 },
    });
    assert.ok(!result.success);
  });

  test("S16: refinement.fanOut is negative", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: -1 },
    });
    assert.ok(!result.success);
  });

  test("S17: refinement.fanOut is a string", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: "three" },
    });
    assert.ok(!result.success);
  });

  test("S17b: refinement.maxCopilotRounds must be a non-negative integer (0 = Copilot gate disabled)", () => {
    // 0 is valid and disables the external Copilot review gate (#832).
    const zero = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 0 },
    });
    assert.ok(zero.success, "maxCopilotRounds: 0 must be accepted (Copilot opt-out)");
    assert.equal(zero.data.refinement.maxCopilotRounds, 0);
    // Negative is still rejected.
    const negative = DevLoopConfigSchema.safeParse({
      version: 1,
      refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: -1 },
    });
    assert.ok(!negative.success);
  });

  test("S18: autonomy.stopAt contains unknown gate name", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      autonomy: { stopAt: ["bad-gate"] },
    });
    assert.ok(!result.success);
  });

  test("S19: autonomy.stopAt is a string instead of array", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      autonomy: { stopAt: "merge" },
    });
    assert.ok(!result.success);
  });

  test("S20: root is null", () => {
    const result = DevLoopConfigSchema.safeParse(null);
    assert.ok(!result.success);
  });

  test("S21: root is array", () => {
    const result = DevLoopConfigSchema.safeParse([{ version: 1 }]);
    assert.ok(!result.success);
  });

  test("S22: root is string", () => {
    const result = DevLoopConfigSchema.safeParse("not-an-object");
    assert.ok(!result.success);
  });

  test("S23: empty object", () => {
    const result = DevLoopConfigSchema.safeParse({});
    assert.ok(!result.success);
  });

  test("S24: strategy.byWorkflow rejected as unknown key", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      strategy: { default: "github-first", byWorkflow: { x: "local-first" } },
    });
    assert.ok(!result.success);
  });

  test("S25: models.roles has empty string value", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { roles: { security: "" } },
    });
    assert.ok(!result.success);
  });

  test("S26: deeply nested unknown key inside gates.draft", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      gates: { draft: { angles: ["style"], unknownNested: true } },
    });
    assert.ok(!result.success);
  });

});

// ============================================================================
// DevLoopConfigSchema.safeParse tests
// ============================================================================

describe("DevLoopConfigSchema.safeParse", () => {
  test("returns { success: true, data } for valid config", () => {
    const result = DevLoopConfigSchema.safeParse({ version: 1 });
    assert.ok(result.success);
  });

  test("returns { success: false, error } for invalid config", () => {
    const result = DevLoopConfigSchema.safeParse({});
    assert.ok(!result.success);
    assert.ok(result.error !== undefined);
  });
});

// ============================================================================
// BUILT_IN_DEFAULTS tests
// ============================================================================

describe("BUILT_IN_DEFAULTS", () => {
  test("is frozen", () => {
    assert.throws(() => { BUILT_IN_DEFAULTS.version = 2; }, TypeError);
  });

  test("has version 1", () => {
    assert.equal(BUILT_IN_DEFAULTS.version, 1);
  });

  test("strategy.default is github-first", () => {
    assert.equal(BUILT_IN_DEFAULTS.strategy.default, "github-first");
  });

  test("inputSource.default is tracker", () => {
    assert.equal(BUILT_IN_DEFAULTS.inputSource.default, "tracker");
  });

  test("refinement defaults include fanOut 3, mode parallel, maxCopilotRounds 5, and low-signal defaults", () => {
    assert.equal(BUILT_IN_DEFAULTS.refinement.fanOut, 3);
    assert.equal(BUILT_IN_DEFAULTS.refinement.mode, "parallel");
    assert.equal(BUILT_IN_DEFAULTS.refinement.maxCopilotRounds, 5);
    assert.equal(BUILT_IN_DEFAULTS.refinement.stopOnLowSignal, false);
    assert.equal(BUILT_IN_DEFAULTS.refinement.lowSignalRoundThreshold, 3);
    assert.equal(BUILT_IN_DEFAULTS.refinement.lowSignalMaxComments, 2);
  });

  test("autonomy.stopAt is [merge]", () => {
    assert.deepEqual(BUILT_IN_DEFAULTS.autonomy.stopAt, ["merge"]);
  });

  test("workflow defaults exist and use required async start with false boolean gates by default", () => {
    assert.deepEqual(BUILT_IN_DEFAULTS.workflow, {
      asyncStartMode: "required",
      requireRetrospective: false,
      requireRetrospectiveGate: false,
      requireDraftFirst: false,
      devModeDefault: false,
    });
  });
});

// ============================================================================
// Loader — graceful degradation tests (L1–L17)
// ============================================================================

describe("loader — graceful degradation", () => {
  /** @type {import("../src/config/config.mjs").loadDevLoopConfig} */
  let loadDevLoopConfig;

  test("loader module imports without I/O", async () => {
    // Schema module must not throw on import
    const schema = await import("../src/config/config.mjs");
    assert.ok(schema.DevLoopConfigSchema);
  });

  test("L1: both config files missing", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L1-"));
    try {
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.ok(result.warnings.length > 0, "should warn about missing config");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L1b: a plain consumer (no .devloops) defaults the retrospective gate OFF (#841)", async () => {
    // The retrospective is a dev-loop-development artifact; shipped defaults must be permissive so
    // an ordinary consumer's product PRs do not carry the meta-process gate. extension-defaults
    // must not force it on (this asserts the resolved/merged value, not just the code default).
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-retro-off-"));
    try {
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.workflow.requireRetrospective, false);
      assert.equal(result.config.workflow.requireRetrospectiveGate, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L1c: a consumer can opt INTO the retrospective gate via .devloops (#841)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-retro-on-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\nworkflow:\n  requireRetrospective: true\n  requireRetrospectiveGate: true\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.workflow.requireRetrospective, true);
      assert.equal(result.config.workflow.requireRetrospectiveGate, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L2: only defaults.json present, valid", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L2-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy.default, "local-first");
      assert.equal(result.warnings.length, 0);
      assert.equal(result.errors.length, 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L3: both files present, valid", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L3-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" }, refinement: { fanOut: 5 } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, strategy: { default: "github-first" } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      // overrides.json beats defaults.json for strategy, but refinement falls through
      assert.equal(result.config.strategy.default, "github-first");
      assert.equal(result.config.refinement.fanOut, 5);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L4: defaults.json exists but is not valid JSON", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L4-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.json"), "not json {{{");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.ok(result.errors.length > 0, "should have errors for invalid JSON");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L5: defaults.json is valid JSON but fails schema", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L5-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, unknownKey: true }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.ok(result.errors.length > 0, "should error for schema violation");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L6: overrides.json exists but is not valid JSON", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L6-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      await writeFile(path.join(piDir, "overrides.json"), "broken json [[[");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy.default, "local-first");
      assert.ok(result.errors.length > 0, "should error for broken overrides");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1: defaults.yaml loads with YAML comments and parses correctly", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L7-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), [
        "version: 1",
        "# This is a comment",
        "strategy:",
        "  default: local-first",
        "gates:",
        "  draft:",
        "    angles:",
        "      - scope",
        "      - coverage",
        "    required: true",
        "personas:",
        "  scope:",
        "    persona: review",
        "    prompt: Check scope",
        "    defaultModel: null",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy.default, "local-first");
      assert.deepEqual(result.config.gates.draft.angles, ["scope", "coverage"]);
      assert.equal(result.config.personas.scope.prompt, "Check scope");
      assert.equal(result.config.refinement.maxCopilotRounds, 5);
      assert.equal(result.warnings.length, 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1b: loader fills default maxCopilotRounds when refinement omits it", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-max-rounds-default-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), [
        "version: 1",
        "refinement:",
        "  fanOut: 2",
        "  mode: parallel",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.errors.length, 0);
      assert.equal(result.config.refinement.maxCopilotRounds, 5);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1c: workflow family merges correctly from defaults.yaml and settings.yaml", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-workflow-yaml-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), [
        "version: 1",
        "workflow:",
        "  asyncStartMode: required",
        "  requireRetrospective: true",
        "  requireRetrospectiveGate: false",
        "  requireDraftFirst: false",
        "  devModeDefault: false",
      ].join("\n"));
      await writeFile(path.join(piDir, "settings.yaml"), [
        "version: 1",
        "workflow:",
        "  requireDraftFirst: true",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.config.workflow, {
        asyncStartMode: "required",
        requireRetrospective: true,
        requireRetrospectiveGate: false,
        requireDraftFirst: true,
        devModeDefault: false,
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1d: loader falls back to legacy overrides.yaml when settings.yaml is absent", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-legacy-overrides-yaml-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "overrides.yaml"), [
        "version: 1",
        "strategy:",
        "  default: local-first",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy.default, "local-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1e: settings.yaml takes precedence over legacy overrides.yaml", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-settings-preferred-yaml-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "settings.yaml"), [
        "version: 1",
        "strategy:",
        "  default: github-first",
      ].join("\n"));
      await writeFile(path.join(piDir, "overrides.yaml"), [
        "version: 1",
        "strategy:",
        "  default: local-first",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy.default, "github-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1g: settings.yaml can override only gates.draft.requireCi without losing default draft angles", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-gate-require-ci-yaml-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), [
        "version: 1",
        "gates:",
        "  draft:",
        "    angles:",
        "      - scope",
        "      - coverage",
        "    required: true",
        "    requireCi: true",
      ].join("\n"));
      await writeFile(path.join(piDir, "settings.yaml"), [
        "version: 1",
        "gates:",
        "  draft:",
        "    requireCi: false",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.config.gates?.draft?.angles, ["scope", "coverage"]);
      assert.equal(result.config.gates?.draft?.requireCi, false);
      assert.equal(result.config.gates?.draft?.required, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y1f: settings.json takes precedence over legacy overrides.json", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-settings-preferred-json-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "settings.json"),
        JSON.stringify({ version: 1, strategy: { default: "github-first" } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy.default, "github-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Y2: YAML (.yml) preferred over JSON when both exist", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L8-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }));
      await writeFile(path.join(piDir, "defaults.yml"),
        "version: 1\nstrategy:\n  default: github-first");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy.default, "github-first", ".yml should take priority over JSON");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L7: overrides.json is valid JSON but fails schema", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L7-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, unknownKey: true }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy.default, "local-first");
      assert.ok(result.errors.length > 0, "should error for bad overrides schema");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L8: defaults.json is a directory (EISDIR)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L8-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      // create a directory where defaults.json should be
      await mkdir(path.join(piDir, "defaults.json"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.ok(result.errors.length > 0, "should error for EISDIR");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L10: defaults.json is empty file", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L10-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.json"), "");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.ok(result.errors.length > 0, "empty JSON should error");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L12: defaults.json has only version: 1 — all else defaulted", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L12-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.json"), JSON.stringify({ version: 1 }));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy.default, "local-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L13: overrides.json has only refinement.fanOut: 7", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L13-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, refinement: { fanOut: 7 } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.refinement.fanOut, 7);
      assert.equal(result.config.strategy.default, "local-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L14: both files invalid — still returns extension defaults", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L14-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.json"), "bad json");
      await writeFile(path.join(piDir, "overrides.json"), "also bad");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.equal(result.config.strategy.default, "local-first");
      assert.ok(result.errors.length >= 2, "should have errors for both files");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L15: defaults.json has version: 1 but overrides.json has version: 2", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L15-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 2, strategy: { default: "github-first" } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      // overrides.json rejected, defaults.json applied
      assert.equal(result.config.strategy.default, "local-first");
      assert.ok(result.errors.length > 0, "should error for version mismatch");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L16: .pi/ exists but no dev-loop/ subdirectory", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L16-"));
    try {
      await mkdir(path.join(tmpDir, ".pi"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.version, 1);
      assert.ok(result.warnings.length > 0, "should warn about missing defaults");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L17: defaults.json with only version: 1 — all families from extension defaults", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-L17-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.json"), JSON.stringify({ version: 1 }));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy.default, "local-first");
      assert.equal(result.config.refinement.fanOut, 3);
      assert.equal(result.config.refinement.mode, "parallel");
      assert.deepEqual(result.config.autonomy.stopAt, ["merge"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Loader — precedence tests (M1–M6)
// ============================================================================

describe("loader — precedence", () => {
  test("M1: defaults.json overrides built-in strategy.default", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M1-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, strategy: { default: "local-first" } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy.default, "local-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M2: overrides.json beats defaults.json", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M2-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, refinement: { fanOut: 5 } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, refinement: { fanOut: 7 } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.refinement.fanOut, 7);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M3: missing key in overrides falls through to defaults", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M3-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, refinement: { fanOut: 5, mode: "sequential" } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, refinement: { fanOut: 7 } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.refinement.fanOut, 7);
      assert.equal(result.config.refinement.mode, "sequential");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M4: missing key in both falls through to built-in", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M4-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1 }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.config.autonomy.stopAt, ["merge"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M5: overrides.json sets a key defaults.json doesn't mention", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M5-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1 }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, models: { conductor: "gpt-5" } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.models.conductor, "gpt-5");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M6: shallow merge — models.roles in overrides replaces entire models.roles", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M6-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({
          version: 1,
          models: { roles: { security: "gpt-5", style: "claude" } },
        }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({
          version: 1,
          models: { roles: { correctness: "gpt-4" } },
        }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      const roles = result.config.models.roles;
      // Shallow merge: overrides replaces entire models.roles
      assert.ok(roles.correctness, "should have correctness from overrides");
      assert.ok(!roles.security, "should NOT have security (replaced by shallow merge)");
      assert.ok(!roles.style, "should NOT have style (replaced by shallow merge)");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M7: persona override may omit prompt without failing merged validation", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M7-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({
          version: 1,
          personas: {
            dry: { persona: "review", prompt: "Built-in DRY prompt", defaultModel: null },
          },
        }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({
          version: 1,
          personas: {
            dry: { persona: "custom-dry-reviewer" },
          },
        }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.personas.dry.persona, "custom-dry-reviewer");
      assert.equal(result.config.personas.dry.prompt, undefined);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("M8: workflow family merges correctly from defaults.json and overrides.json", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M8-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({
          version: 1,
          workflow: {
            asyncStartMode: "allowed",
            requireRetrospective: false,
            requireRetrospectiveGate: false,
            requireDraftFirst: false,
            devModeDefault: true,
          },
        }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({
          version: 1,
          workflow: {
            asyncStartMode: "required",
            requireRetrospective: true,
          },
        }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.config.workflow, {
        asyncStartMode: "required",
        requireRetrospective: true,
        requireRetrospectiveGate: false,
        requireDraftFirst: false,
        devModeDefault: true,
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Extension defaults precedence tests (E1–E4)
// ============================================================================

describe("extension defaults", () => {
  test("E1: extension defaults are loaded from the installed package", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-E1-"));
    try {
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      // Extension defaults intend local-first; built-in defaults are github-first.
      assert.equal(result.config.strategy.default, "local-first");
      assert.equal(result.config.workflow.requireDraftFirst, true);
      assert.equal(result.config.localImplementation.lightMode.enabled, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("E2: repo .pi/dev-loop/defaults.* overrides extension defaults", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-E2-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.yaml"),
        "version: 1\nstrategy:\n  default: github-first\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy.default, "github-first");
      // Workflow still comes from extension defaults because repo defaults did not set it.
      assert.equal(result.config.workflow.requireDraftFirst, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("E3: .devloops overrides extension defaults", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-E3-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\nstrategy:\n  default: github-first\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy.default, "github-first");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("E4: extension defaults merge from a mock extension directory", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-E4-"));
    try {
      const extDir = path.join(tmpDir, "mock-extension");
      await mkdir(extDir, { recursive: true });
      await writeFile(
        path.join(extDir, "extension-defaults.yaml"),
        [
          "version: 1",
          "strategy:",
          "  default: local-first",
          "refinement:",
          "  fanOut: 7",
          "  mode: sequential",
        ].join("\n"),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({
        repoRoot: tmpDir,
        extensionDefaultsBasePath: path.join(extDir, "extension-defaults"),
      });
      assert.equal(result.config.strategy.default, "local-first");
      assert.equal(result.config.refinement.fanOut, 7);
      assert.equal(result.config.refinement.mode, "sequential");
      // Missing keys still fall through to built-in defaults.
      assert.equal(result.config.refinement.maxCopilotRounds, 5);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Role resolution tests (R1–R9)
// ============================================================================

describe("role resolution", () => {
  /** @type {import("../src/config/config.mjs").resolveReviewerRole} */
  let resolveReviewerRole;

  test("roles module imports without error", async () => {
    const mod = await import("../src/config/config.mjs");
    resolveReviewerRole = mod.resolveReviewerRole;
    assert.ok(typeof resolveReviewerRole === "function");
  });

  test("R1: all angles fall back when registry is empty", () => {
    const result = resolveReviewerRole({}, "security");
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.fallback, true);
  });

  test("R2: unknown angle falls back", () => {
    const result = resolveReviewerRole({}, "custom-lens");
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.fallback, true);
  });

  test("R3: angle with model override applies override even when falling back", () => {
    const result = resolveReviewerRole(
      { models: { roles: { style: "gpt-5" } } },
      "style",
    );
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.model, "gpt-5");
    assert.equal(result.fallback, true);
  });

  test("R4: unknown angle with model override", () => {
    const result = resolveReviewerRole(
      { models: { roles: { unknown: "claude-opus" } } },
      "unknown",
    );
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.model, "claude-opus");
    assert.equal(result.fallback, true);
  });

  test("R5: empty config — all angles resolve to built-in defaults (fallback)", () => {
    const result = resolveReviewerRole({}, "security");
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.model, null);
    assert.equal(result.fallback, true);
  });

  test("R6: missing models.roles in config", () => {
    const result = resolveReviewerRole({ models: {} }, "security");
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.model, null);
  });

  test("R7: null or undefined angle returns fallback", () => {
    const r1 = resolveReviewerRole({}, null);
    assert.equal(r1.persona, "default-reviewer");
    assert.equal(r1.fallback, true);

    const r2 = resolveReviewerRole({}, undefined);
    assert.equal(r2.persona, "default-reviewer");
    assert.equal(r2.fallback, true);
  });

  test("R9: model override with empty string ignored", () => {
    const result = resolveReviewerRole(
      { models: { roles: { security: "" } } },
      "security",
    );
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.model, null);
  });

  // --- Known angles (populated registry) ---

  test("R10: known draft-gate angle resolves to review persona", () => {
    const result = resolveReviewerRole({}, "scope");
    assert.equal(result.persona, "review");
    assert.equal(result.model, null);
    assert.equal(result.fallback, false);
  });

  test("R11: known pre-approval angle resolves to review persona", () => {
    const result = resolveReviewerRole({}, "dry");
    assert.equal(result.persona, "review");
    assert.equal(result.model, null);
    assert.equal(result.fallback, false);
  });

  test("R11b: known opt-in docs angle resolves to docs persona", () => {
    const result = resolveReviewerRole({}, "docs");
    assert.equal(result.persona, "docs");
    assert.equal(result.model, null);
    assert.equal(result.fallback, false);
  });

  test("R11c: known opt-in deep angle resolves to review persona", () => {
    const result = resolveReviewerRole({}, "deep");
    assert.equal(result.persona, "review");
    assert.equal(result.model, null);
    assert.equal(result.fallback, false);
  });

  test("R12: all 20 known angles resolve without fallback", () => {
    const expectedPersonas = {
      scope: "review",
      coverage: "review",
      correctness: "review",
      docs: "docs",
      deep: "review",
      dry: "review",
      kiss: "review",
      srp: "review",
      ocp: "review",
      lsp: "review",
      isp: "review",
      dip: "review",
      soc: "review",
      yagni: "review",
      "contract-surface": "review",
      "input-validation": "review",
      "packaging-runtime": "review",
      "state-concurrency": "review",
      "renderer-security": "review",
      determinism: "review",
    };

    for (const [angle, expectedPersona] of Object.entries(expectedPersonas)) {
      const result = resolveReviewerRole({}, angle);
      assert.equal(result.persona, expectedPersona, `angle ${angle}`);
      assert.equal(result.fallback, false, `angle ${angle}`);
    }
  });

  test("R13: known angle with model override applies override", () => {
    const result = resolveReviewerRole(
      { models: { roles: { dry: "gpt-5" } } },
      "dry",
    );
    assert.equal(result.persona, "review");
    assert.equal(result.model, "gpt-5");
    assert.equal(result.fallback, false);
  });

  // --- Config-driven persona overrides ---

  test("R14: config personas override built-in persona for same angle", () => {
    const result = resolveReviewerRole(
      { personas: { dry: { persona: "custom-dry-reviewer", defaultModel: null } } },
      "dry",
    );
    assert.equal(result.persona, "custom-dry-reviewer");
    assert.equal(result.fallback, false);
  });

  test("R15: config personas add new angle not in built-in registry", () => {
    const result = resolveReviewerRole(
      { personas: { security: { persona: "security-reviewer", defaultModel: "claude-opus" } } },
      "security",
    );
    assert.equal(result.persona, "security-reviewer");
    assert.equal(result.model, "claude-opus");
    assert.equal(result.fallback, false);
  });

  test("R16: model override in models.roles takes priority over config persona defaultModel", () => {
    const result = resolveReviewerRole(
      {
        personas: { dry: { persona: "review", defaultModel: "gpt-4" } },
        models: { roles: { dry: "gpt-5" } },
      },
      "dry",
    );
    assert.equal(result.persona, "review");
    assert.equal(result.model, "gpt-5");
  });

  test("R17: unknown angle without config personas still falls back to BUILTIN_PERSONAS", () => {
    // Empty personas map — should fall back to built-in for known angles
    const result = resolveReviewerRole(
      { personas: {} },
      "scope",
    );
    assert.equal(result.persona, "review");
    assert.equal(result.fallback, false);
  });

  test("R18: consumer overrides built-in persona and replaces model", () => {
    const result = resolveReviewerRole(
      {
        personas: { correctness: { persona: "my-correctness-agent", defaultModel: "claude-sonnet" } },
      },
      "correctness",
    );
    assert.equal(result.persona, "my-correctness-agent");
    assert.equal(result.model, "claude-sonnet");
    assert.equal(result.fallback, false);
  });

  test("R19: built-in fallback returns null prompt when config personas absent", () => {
    const result = resolveReviewerRole({}, "dry");
    assert.equal(result.persona, "review");
    assert.equal(result.prompt, null, "prompt should be null when config.personas is absent");
    assert.equal(result.fallback, false);
  });

  test("R20: config personas provide prompts; fallback does not duplicate them", () => {
    // Without config: persona resolves, prompt is null (lives in config only)
    const noConfig = resolveReviewerRole({}, "dry");
    assert.equal(noConfig.prompt, null);
    // With config: persona resolves with prompt from config
    const withConfig = resolveReviewerRole(
      { personas: { dry: { persona: "review", prompt: "Check duplication" } } },
      "dry",
    );
    assert.equal(withConfig.prompt, "Check duplication");
    assert.equal(withConfig.fallback, false);
  });

  test("R21: config persona prompt overrides built-in prompt", () => {
    const result = resolveReviewerRole(
      { personas: { dry: { persona: "review", prompt: "Custom DRY prompt for this project" } } },
      "dry",
    );
    assert.equal(result.prompt, "Custom DRY prompt for this project");
    assert.equal(result.fallback, false);
  });

  test("R22: fallback angles return null prompt", () => {
    const result = resolveReviewerRole({}, "unknown-angle");
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.prompt, null);
    assert.equal(result.fallback, true);
  });

  test("R23: config persona without prompt resolves with null prompt", () => {
    const result = resolveReviewerRole(
      { personas: { dry: { persona: "custom-dry-reviewer" } } },
      "dry",
    );
    assert.equal(result.persona, "custom-dry-reviewer");
    assert.equal(result.prompt, null);
    assert.equal(result.fallback, false);
  });

  describe("model and config resolution", () => {
    test("resolveConductorModel returns model when present in config", () => {
      const result = resolveConductorModel({ version: 1, models: { conductor: "gpt-5" } });
      assert.equal(result, "gpt-5");
    });

    test("resolveConductorModel returns null when models key is missing", () => {
      const result = resolveConductorModel({ version: 1 });
      assert.equal(result, null);
    });

    test("resolveConductorModel returns null when models.conductor is absent", () => {
      const result = resolveConductorModel({ version: 1, models: { roles: { security: "gpt-5" } } });
      assert.equal(result, null);
    });

    test("resolveConductorModel returns null for empty string", () => {
      const result = resolveConductorModel({ version: 1, models: { conductor: "" } });
      assert.equal(result, null);
    });

    test("resolveConductorModel returns null for whitespace-only string", () => {
      const result = resolveConductorModel({ version: 1, models: { conductor: "   " } });
      assert.equal(result, null);
    });

    test("resolveConductorModel returns trimmed value for whitespace-padded string", () => {
      const result = resolveConductorModel({ version: 1, models: { conductor: "  gpt-5  " } });
      assert.equal(result, "gpt-5");
    });


    test("resolveConductorModel returns null when models is empty object", () => {
      const result = resolveConductorModel({ version: 1, models: {} });
      assert.equal(result, null);
    });

    // Autonomy stop-at resolution
    test("resolveAutonomyStopAt returns configured gates when present", () => {
      const result = resolveAutonomyStopAt({ version: 1, autonomy: { stopAt: ["draft-pr", "merge"] } });
      assert.deepEqual(result, ["draft-pr", "merge"]);
    });

    test("resolveAutonomyStopAt defaults to ['merge'] when autonomy key is missing", () => {
      const result = resolveAutonomyStopAt({ version: 1 });
      assert.deepEqual(result, ["merge"]);
    });

    test("resolveAutonomyStopAt returns empty array when stopAt is explicitly empty", () => {
      const result = resolveAutonomyStopAt({ version: 1, autonomy: { stopAt: [] } });
      assert.deepEqual(result, []);
    });

    test("resolveAutonomyStopAt returns new array (not reference to config)", () => {
      const config = { version: 1, autonomy: { stopAt: ["merge"] } };
      const result = resolveAutonomyStopAt(config);
      result.push("draft-pr");
      assert.deepEqual(config.autonomy.stopAt, ["merge"]);
    });

    test("resolveAutonomyStopAt returns all four gates when configured", () => {
      const result = resolveAutonomyStopAt({
        version: 1,
        autonomy: { stopAt: ["refinement", "draft-pr", "pre-approval", "merge"] },
      });
      assert.deepEqual(result, ["refinement", "draft-pr", "pre-approval", "merge"]);
    });

    // Refinement resolution
    test("resolveRefinement returns defaults when config is absent", () => {
      const result = resolveRefinement({ version: 1 });
      assert.equal(result.fanOut, 3);
      assert.equal(result.mode, "parallel");
      assert.equal(result.roles, null);
      assert.equal(result.maxCopilotRounds, 5);
      assert.equal(result.stopOnLowSignal, false);
      assert.equal(result.lowSignalRoundThreshold, 3);
      assert.equal(result.lowSignalMaxComments, 2);
    });

    test("resolveRefinement returns configured values", () => {
      const result = resolveRefinement({
        version: 1,
        refinement: { fanOut: 5, mode: "sequential", maxCopilotRounds: 7, stopOnLowSignal: true, lowSignalRoundThreshold: 5, lowSignalMaxComments: 1, roles: ["security", "style"] }
      });
      assert.equal(result.fanOut, 5);
      assert.equal(result.mode, "sequential");
      assert.equal(result.maxCopilotRounds, 7);
      assert.equal(result.stopOnLowSignal, true);
      assert.equal(result.lowSignalRoundThreshold, 5);
      assert.equal(result.lowSignalMaxComments, 1);
      assert.deepEqual(result.roles, ["security", "style"]);
    });

    test("resolveRefinement returns empty roles array when explicitly empty", () => {
      const result = resolveRefinement({ version: 1, refinement: { fanOut: 2, mode: "parallel", roles: [] } });
      assert.deepEqual(result.roles, []);
    });

    test("resolveRefinementConfig resolves maxCopilotRounds with a default of 5", () => {
      assert.equal(resolveRefinementConfig({ version: 1 }, "maxCopilotRounds"), 5);
      assert.equal(resolveRefinementConfig({
        version: 1,
        refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 9 },
      }, "maxCopilotRounds"), 9);
    });

    test("resolveRefinementConfig resolves low-signal keys with defaults", () => {
      assert.equal(resolveRefinementConfig({ version: 1 }, "stopOnLowSignal"), false);
      assert.equal(resolveRefinementConfig({ version: 1 }, "lowSignalRoundThreshold"), 3);
      assert.equal(resolveRefinementConfig({ version: 1 }, "lowSignalMaxComments"), 2);
    });

    test("resolveRefinementConfig resolves low-signal keys from config", () => {
      const config = {
        version: 1,
        refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 5, stopOnLowSignal: true, lowSignalRoundThreshold: 4, lowSignalMaxComments: 1 },
      };
      assert.equal(resolveRefinementConfig(config, "stopOnLowSignal"), true);
      assert.equal(resolveRefinementConfig(config, "lowSignalRoundThreshold"), 4);
      assert.equal(resolveRefinementConfig(config, "lowSignalMaxComments"), 1);
    });

    // Gate angles resolution
    test("resolveGateAngles returns null when gates config is absent", () => {
      const result = resolveGateAngles({ version: 1 }, "draft");
      assert.deepEqual(result, null);
    });

    test("resolveGateAngles returns configured draft angles", () => {
      const result = resolveGateAngles({
        version: 1,
        gates: { draft: { angles: ["scope", "coverage"], required: true, requireCi: false } }
      }, "draft");
      assert.deepEqual(result, ["scope", "coverage"]);
    });

    test("resolveGateConfig returns default booleans when gates config is absent", () => {
      const result = resolveGateConfig({ version: 1 }, "draft");
      assert.deepEqual(result, {
        angles: null,
        excludeAngles: [],
        mandatoryAngles: [],
        required: true,
        requireCi: true,
        dynamicAngles: false,
        blockCleanOnFindingSeverities: ["must-fix"],
      });
    });

    test("resolveGateConfig returns configured gate booleans and cloned angles", () => {
      const config = {
        version: 1,
        gates: { draft: { angles: ["scope", "coverage"], required: false, requireCi: false } },
      };
      const result = resolveGateConfig(config, "draft");
      result.angles.push("correctness");
      assert.deepEqual(result, {
        angles: ["scope", "coverage", "correctness"],
        excludeAngles: [],
        mandatoryAngles: [],
        required: false,
        requireCi: false,
        dynamicAngles: false,
        blockCleanOnFindingSeverities: ["must-fix"],
      });
      assert.deepEqual(config.gates.draft.angles, ["scope", "coverage"]);
    });

    test("resolveGateAngles returns configured preApproval angles", () => {
      const result = resolveGateAngles({
        version: 1,
        gates: { preApproval: { angles: ["dry", "kiss"], required: false } }
      }, "preApproval");
      assert.deepEqual(result, ["dry", "kiss"]);
    });

    test("resolveGateAngles returns null for missing gate config", () => {
      const result = resolveGateAngles({
        version: 1,
        gates: { draft: { angles: ["scope"], required: true } }
      }, "preApproval");
      assert.deepEqual(result, null);
    });

    test("resolveGateAngles returns empty array when angles explicitly empty", () => {
      const result = resolveGateAngles({
        version: 1,
        gates: { draft: { angles: [], required: true } }
      }, "draft");
      assert.deepEqual(result, []);
    });

    test("resolveGateAngles returns new array (not reference to config)", () => {
      const config = { version: 1, gates: { draft: { angles: ["scope"] } } };
      const result = resolveGateAngles(config, "draft");
      result.push("coverage");
      assert.deepEqual(config.gates.draft.angles, ["scope"]);
    });

    test("resolveGateAngles filters excluded angles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage", "correctness", "dry"],
            excludeAngles: ["dry"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["scope", "coverage", "correctness"]);
    });

    test("resolveGateAngles filters multiple excluded angles", () => {
      const config = {
        version: 1,
        gates: {
          preApproval: {
            angles: ["dry", "kiss", "yagni", "deep", "docs"],
            excludeAngles: ["docs", "kiss"],
          },
        },
      };
      const result = resolveGateAngles(config, "preApproval");
      assert.deepEqual(result, ["dry", "yagni", "deep"]);
    });

    test("resolveGateAngles with empty excludeAngles returns all angles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage"],
            excludeAngles: [],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["scope", "coverage"]);
    });

    test("resolveGateAngles with all angles excluded returns empty array", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage"],
            excludeAngles: ["scope", "coverage"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, []);
    });

    test("resolveGateAngles handles non-string entries gracefully", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", 42, null, "coverage"],
            excludeAngles: [true, "scope"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      // Non-strings are coerced to "" and filtered out; "scope" excluded
      assert.deepEqual(result, ["coverage"]);
    });

    test("resolveGateAngles handles all non-string angles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [null, 123, undefined],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, []);
    });

    test("resolveGateAngles trims whitespace from angles and excludeAngles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [" scope ", "  coverage  ", "correctness"],
            excludeAngles: [" scope  "],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["coverage", "correctness"]);
    });

    test("resolveGateConfig trims whitespace and filters empty strings from angles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [" scope ", "  ", "coverage"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.angles, ["scope", "coverage"]);
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["must-fix"]);
    });

    test("resolveGateConfig returns configured blockCleanOnFindingSeverities", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["must-fix", "worth-fixing-now"]);
    });

    test("resolveGateConfig returns default blockCleanOnFindingSeverities for missing field", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            required: true,
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["must-fix"]);
    });

    test("resolveGateConfig blockCleanOnFindingSeverities returns a copy, not reference", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      result.blockCleanOnFindingSeverities.push("defer");
      assert.deepEqual(config.gates.draft.blockCleanOnFindingSeverities, ["must-fix", "worth-fixing-now"]);
    });

    test("resolveGateConfig returns blockCleanOnFindingSeverities for preApproval gate", () => {
      const config = {
        version: 1,
        gates: {
          preApproval: {
            angles: ["dry"],
            blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now", "defer"],
          },
        },
      };
      const result = resolveGateConfig(config, "preApproval");
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["must-fix", "worth-fixing-now", "defer"]);
    });

    test("GateConfig rejects invalid blockCleanOnFindingSeverities tokens", () => {
      const invalid = {
        version: 1,
        gates: {
          draft: {
            blockCleanOnFindingSeverities: ["invalid-severity"],
          },
        },
      };
      const result = FileConfigSchema.safeParse(invalid);
      assert.equal(result.success, false);
    });

    test("GateConfig rejects empty blockCleanOnFindingSeverities (min 1)", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            blockCleanOnFindingSeverities: [],
          },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, false);
    });

    test("GateConfig accepts valid mandatoryAngles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            mandatoryAngles: ["pr-description", "correctness"],
          },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, true);
    });

    test("GateConfig rejects mandatoryAngles with empty strings", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            mandatoryAngles: [""],
          },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, false);
    });

    test("GateConfig accepts mandatoryAngles as optional (absent)", () => {
      const config = {
        version: 1,
        gates: {
          draft: { angles: ["scope"] },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, true);
    });

        test("resolveGateAngles filters when excludeAngles has angles not in angles list", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage"],
            excludeAngles: ["dry", "kiss"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["scope", "coverage"]);
    });

    // --- mandatoryAngles ---
    test("resolveGateConfig returns mandatoryAngles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage"],
            mandatoryAngles: ["pr-description", "correctness"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.mandatoryAngles, ["pr-description", "correctness"]);
    });

    test("resolveGateConfig returns empty mandatoryAngles when absent", () => {
      const config = {
        version: 1,
        gates: { draft: { angles: ["scope"] } },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.mandatoryAngles, []);
    });

    test("resolveGateAngles merges mandatoryAngles with regular angles (no duplicates)", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage"],
            mandatoryAngles: ["pr-description", "correctness"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "correctness", "scope", "coverage"]);
    });

    test("resolveGateAngles deduplicates overlap between mandatory and regular angles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage", "pr-description"],
            mandatoryAngles: ["pr-description", "correctness"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "correctness", "scope", "coverage"]);
    });

    test("resolveGateAngles excludes mandatoryAngles matching excludeAngles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            mandatoryAngles: ["pr-description", "correctness", "gate-evidence"],
            excludeAngles: ["correctness"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "gate-evidence", "scope"]);
    });

    test("resolveGateAngles returns null when both angles and mandatoryAngles empty", () => {
      const config = {
        version: 1,
        gates: { draft: { mandatoryAngles: [] } },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, null);
    });

    test("resolveGateAngles returns only mandatoryAngles when angles not configured", () => {
      const config = {
        version: 1,
        gates: { draft: { mandatoryAngles: ["pr-description", "correctness"] } },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "correctness"]);
    });

    test("resolveGateConfig default booleans include empty mandatoryAngles", () => {
      const result = resolveGateConfig({ version: 1 }, "draft");
      assert.deepEqual(result.mandatoryAngles, []);
    });

        test("resolveRefinement returns new roles array (not reference to config)", () => {
      const config = { version: 1, refinement: { fanOut: 2, mode: "parallel", roles: ["security"] } };
      const result = resolveRefinement(config);
      result.roles.push("style");
      assert.deepEqual(config.refinement.roles, ["security"]);
    });

    test("resolveWorkflowConfig returns built-in defaults when workflow family is absent", () => {
      assert.equal(resolveWorkflowConfig({ version: 1 }, "asyncStartMode"), "required");
      assert.equal(resolveWorkflowConfig({ version: 1 }, "requireRetrospective"), false);
      assert.equal(resolveWorkflowConfig({ version: 1 }, "requireRetrospectiveGate"), false);
      assert.equal(resolveWorkflowConfig({ version: 1 }, "requireDraftFirst"), false);
      assert.equal(resolveWorkflowConfig({ version: 1 }, "devModeDefault"), false);
    });

    test("resolveWorkflowConfig returns configured workflow values", () => {
      const config = {
        version: 1,
        workflow: {
          asyncStartMode: "allowed",
          requireRetrospective: true,
          requireRetrospectiveGate: true,
          requireDraftFirst: true,
          devModeDefault: false,
        },
      };
      assert.equal(resolveWorkflowConfig(config, "asyncStartMode"), "allowed");
      assert.equal(resolveWorkflowConfig(config, "requireRetrospective"), true);
      assert.equal(resolveWorkflowConfig(config, "requireRetrospectiveGate"), true);
      assert.equal(resolveWorkflowConfig(config, "requireDraftFirst"), true);
      assert.equal(resolveWorkflowConfig(config, "devModeDefault"), false);
    });

    test("resolveWorkflowConfig falls through to built-in false when an individual key is absent", () => {
      const config = { version: 1, workflow: { requireDraftFirst: true } };
      assert.equal(resolveWorkflowConfig(config, "asyncStartMode"), "required");
      assert.equal(resolveWorkflowConfig(config, "requireRetrospective"), false);
      assert.equal(resolveWorkflowConfig(config, "requireRetrospectiveGate"), false);
      assert.equal(resolveWorkflowConfig(config, "requireDraftFirst"), true);
      assert.equal(resolveWorkflowConfig(config, "devModeDefault"), false);
    });

    test("resolveWorkflowConfig throws on unknown key", () => {
      assert.throws(() => resolveWorkflowConfig({ version: 1 }, "unknownKey"), /Unknown workflow config key/);
    });
  });

});

describe("shipped defaults docs and deep angle wiring", () => {

  test("D2: shipped defaults wire contract-surface by default and expose cluster-derived opt-in prompts", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-D2-cluster-prompts-"));
    try {
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const sourceDefaults = await readFile(path.join(repoRoot, "packages", "core", "src", "config", "extension-defaults.yaml"), "utf8");
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), sourceDefaults);

      const { loadDevLoopConfig, resolveReviewerRole } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      const draftAngles = resolveGateAngles(result.config, "draft");
      const requiredAngles = [
        "contract-surface",
        "input-validation",
        "packaging-runtime",
        "state-concurrency",
        "renderer-security",
        "determinism",
      ];

      assert.deepEqual(result.errors, []);
      assert.ok(draftAngles.includes("contract-surface"), "contract-surface should run in draft gate by default");

      for (const angle of requiredAngles) {
        const role = resolveReviewerRole(result.config, angle);
        assert.equal(role.persona, "review", `${angle} should use review persona`);
        assert.equal(role.fallback, false, `${angle} should resolve from persona registry`);
        assert.equal(role.prompt, result.config.personas[angle].prompt, `${angle} prompt should come from config`);
        assert.doesNotMatch(role.prompt, /mfittko\/dev-loops|issue #?\d+|tmp\/investigation|uncategorized-clusters/i, `${angle} prompt should stay repo-agnostic`);
      }

      assert.match(result.config.personas["contract-surface"].prompt, /schema fields, state\/sentinel names, runtime values, tests, and CLI output agree/i);
      assert.match(result.config.personas["input-validation"].prompt, /repo slug, issue number, host, SHA, whitespace, and sentinel normalization/i);
      assert.match(result.config.personas["packaging-runtime"].prompt, /installed packages, extensions, or runtime bundles/i);
      assert.match(result.config.personas["state-concurrency"].prompt, /state-file read\/modify\/write paths/i);
      assert.match(result.config.personas["renderer-security"].prompt, /HTML text escaping, URL encoding, attribute encoding/i);
      assert.match(result.config.personas.determinism.prompt, /ordering, tie-breakers, localeCompare use/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
  test("D1: shipped defaults keep docs opt-in, deep enabled by default, and resolve packaged persona prompts", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-D1-"));
    try {
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const sourceDefaults = await readFile(path.join(repoRoot, "packages", "core", "src", "config", "extension-defaults.yaml"), "utf8");
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), sourceDefaults);

      const { loadDevLoopConfig, resolveReviewerRole } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      const preApprovalAngles = resolveGateAngles(result.config, "preApproval");
      const docsRole = resolveReviewerRole(result.config, "docs");
      const deepRole = resolveReviewerRole(result.config, "deep");

      assert.deepEqual(result.errors, []);
      assert.equal(result.config.personas.docs.persona, "docs");
      assert.match(result.config.personas.docs.prompt, /Review documentation correctness/i);
      assert.equal(result.config.personas.deep.persona, "review");
      assert.match(result.config.personas.deep.prompt, /Perform a structural code quality audit of this PR/i);
      assert.match(result.config.personas.deep.prompt, /deslop audit/i);
      assert.ok(preApprovalAngles.includes("docs"), "docs must be enabled by default for pre-approval");
      assert.ok(preApprovalAngles.includes("deep"), "deep must run by default for pre-approval");
      assert.equal(docsRole.persona, "docs");
      assert.equal(docsRole.prompt, result.config.personas.docs.prompt);
      assert.equal(docsRole.fallback, false);
      assert.equal(deepRole.persona, "review");
      assert.equal(deepRole.prompt, result.config.personas.deep.prompt);
      assert.equal(deepRole.fallback, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("D3: pr-description persona resolves and appears in draft gate angles after settings opt-in", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-D3-"));
    try {
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const sourceDefaults = await readFile(path.join(repoRoot, "packages", "core", "src", "config", "extension-defaults.yaml"), "utf8");
      const sourceSettings = await readFile(path.join(repoRoot, ".devloops"), "utf8");
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), sourceDefaults);
      await writeFile(path.join(tmpDir, ".devloops"), sourceSettings);

      const { loadDevLoopConfig, resolveReviewerRole, resolveGateAngles } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });

      const prDescRole = resolveReviewerRole(result.config, "pr-description");
      const draftAngles = resolveGateAngles(result.config, "draft");

      assert.deepEqual(result.errors, []);
      assert.equal(result.config.personas["pr-description"].persona, "review");
      assert.match(result.config.personas["pr-description"].prompt, /Summary section/i);
      assert.match(result.config.personas["pr-description"].prompt, /Validation command section/i);
      assert.match(result.config.personas["pr-description"].prompt, /Do not block on formatting/i);
      assert.match(result.config.personas["pr-description"].prompt, /linked issue acceptance criteria/i);
      assert.match(result.config.personas["pr-description"].prompt, /single sentence/i);
      assert.match(result.config.personas["pr-description"].prompt, /Closes #N/i);
      assert.match(result.config.personas["pr-description"].prompt, /operator-intended close target/i);
      assert.match(result.config.personas["pr-description"].prompt, /Scope and context section/i);
      assert.match(result.config.personas["pr-description"].prompt, /File-by-file changes section/i);
      assert.match(result.config.personas["pr-description"].prompt, /Definition of done section/i);
      assert.match(result.config.personas["pr-description"].prompt, /Non-goals section/i);
      assert.ok(draftAngles.includes("pr-description"), "pr-description must be in draft gate angles after settings opt-in");
      assert.equal(prDescRole.persona, "review");
      assert.equal(prDescRole.fallback, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("D4: pr-checklist-matrix persona resolves and appears in pre-approval gate angles after settings opt-in", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-D4-"));
    try {
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const sourceDefaults = await readFile(path.join(repoRoot, "packages", "core", "src", "config", "extension-defaults.yaml"), "utf8");
      const sourceSettings = await readFile(path.join(repoRoot, ".devloops"), "utf8");
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(path.join(piDir, "defaults.yaml"), sourceDefaults);
      await writeFile(path.join(tmpDir, ".devloops"), sourceSettings);

      const { loadDevLoopConfig, resolveReviewerRole, resolveGateAngles } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });

      const checklistRole = resolveReviewerRole(result.config, "pr-checklist-matrix");
      const preApprovalAngles = resolveGateAngles(result.config, "preApproval");

      assert.deepEqual(result.errors, []);
      assert.equal(result.config.personas["pr-checklist-matrix"].persona, "review");
      assert.match(result.config.personas["pr-checklist-matrix"].prompt, /checkbox/i);
      assert.match(result.config.personas["pr-checklist-matrix"].prompt, /AC\/DoD\/non-goals matrix/i);
      assert.match(result.config.personas["pr-checklist-matrix"].prompt, /markdown table/i);
      assert.match(result.config.personas["pr-checklist-matrix"].prompt, /unchecked/i);
      assert.ok(preApprovalAngles.includes("pr-checklist-matrix"), "pr-checklist-matrix must be in pre-approval gate angles after settings opt-in");
      assert.equal(checklistRole.persona, "review");
      assert.equal(checklistRole.fallback, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
// ── Integration: config wiring into actual consumers ──────────────────────

test("print-gates uses resolveGateAngles (not raw gateConfig.angles)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../scripts/loop/print-gates.mjs", import.meta.url),
    "utf8"
  );
  // Must import resolveGateAngles
  assert.match(source, /resolveGateAngles/);
  // Must use resolveGateAngles to get angles, not gateConfig.angles directly
  assert.match(source, /resolveGateAngles\(config,\s*gate\)/);
  // Negative: gateConfig.angles must not be used directly
  assert.ok(!/gateConfig\.angles/.test(source), "print-gates.mjs should not use gateConfig.angles directly");
});

test("existing wired scripts: outer-loop uses resolveAutonomyStopAt", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../scripts/loop/outer-loop.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /resolveAutonomyStopAt/);
  assert.match(source, /resolveAutonomyStopAt\(devLoopConfig\)/);
});

test("existing wired scripts: detect-copilot-loop-state uses resolveRefinement", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../scripts/loop/detect-copilot-loop-state.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /resolveRefinement/);
});

test("existing wired scripts: upsert-checkpoint-verdict uses resolveRefinementConfig", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../scripts/github/upsert-checkpoint-verdict.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /resolveRefinementConfig/);
});

test("existing wired scripts: detect-pr-gate-coordination-state uses resolveRefinementConfig", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../scripts/loop/detect-pr-gate-coordination-state.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /resolveRefinementConfig/);
});

test("existing wired scripts: reconcile-draft-gate imports loadDevLoopConfig", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../../scripts/github/reconcile-draft-gate.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /loadDevLoopConfig/);
});

test("resolveGateAngles filters excluded angles (unit integration)", async () => {
  // Unit-level integration: resolveGateAngles with excludeAngles
  const config = {
    version: 1,
    gates: {
      preApproval: {
        description: "pre-approval gate",
        angles: ["deep", "dry", "scope"],
        excludeAngles: ["dry"],
      },
    },
  };
  const angles = resolveGateAngles(config, "preApproval");
  assert.deepStrictEqual(angles, ["deep", "scope"]);
  // "dry" should be excluded
  assert.ok(!angles.includes("dry"));
// ── LocalImplementation light mode ────────────────────────────────────────

test("resolveLightMode returns null when config has no localImplementation", () => {
  const result = resolveLightMode({ version: 1 });
  assert.equal(result, null);
});

test("resolveLightMode returns null when lightMode.enabled is false", () => {
  const result = resolveLightMode({
    version: 1,
    localImplementation: { lightMode: { enabled: false, maxFiles: 5, maxLines: 100 } },
  });
  assert.equal(result, null);
});

test("resolveLightMode returns null when lightMode is absent", () => {
  const result = resolveLightMode({
    version: 1,
    localImplementation: {},
  });
  assert.equal(result, null);
});

test("resolveLightMode returns threshold when enabled", () => {
  const result = resolveLightMode({
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 5, maxLines: 100 } },
  });
  assert.deepStrictEqual(result, { maxFiles: 5, maxLines: 100 });
});

test("resolveLightMode uses built-in defaults when enabled with no overrides", () => {
  const result = resolveLightMode({
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 3, maxLines: 200 } },
  });
  assert.deepStrictEqual(result, { maxFiles: 3, maxLines: 200 });
});

test("resolveLightMode with built-in defaults (disabled)", () => {
  const result = resolveLightMode({ version: 1 });
  assert.equal(result, null);
});

// ── Light mode eligibility ───────────────────────────────────────────────

test("detectChangeScope eligible: 2 files, 50 lines ≤ 3/200", async () => {
  const { isEligibleForLightMode } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  assert.equal(
    isEligibleForLightMode(
      { filesChanged: 2, linesChanged: 50 },
      { maxFiles: 3, maxLines: 200 }
    ),
    true
  );
});

test("detectChangeScope not eligible: 4 files, 50 lines (files > 3)", async () => {
  const { isEligibleForLightMode } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  assert.equal(
    isEligibleForLightMode(
      { filesChanged: 4, linesChanged: 50 },
      { maxFiles: 3, maxLines: 200 }
    ),
    false
  );
});

test("detectChangeScope not eligible: 2 files, 250 lines (lines > 200)", async () => {
  const { isEligibleForLightMode } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  assert.equal(
    isEligibleForLightMode(
      { filesChanged: 2, linesChanged: 250 },
      { maxFiles: 3, maxLines: 200 }
    ),
    false
  );
});

test("detectChangeScope eligible at boundary: exactly 3 files, 200 lines", async () => {
  const { isEligibleForLightMode } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  assert.equal(
    isEligibleForLightMode(
      { filesChanged: 3, linesChanged: 200 },
      { maxFiles: 3, maxLines: 200 }
    ),
    true
  );
});

test("detectChangeScope eligible with custom threshold: 5 files ≤ 5/300", async () => {
  const { isEligibleForLightMode } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  assert.equal(
    isEligibleForLightMode(
      { filesChanged: 5, linesChanged: 250 },
      { maxFiles: 5, maxLines: 300 }
    ),
    true
  );
});

// ── parseGitDiffStat ─────────────────────────────────────────────────────

test("parseGitDiffStat: normal output", async () => {
  const { parseGitDiffStat } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  const output = ` file1.js | 10 +++++
 file2.js |  5 -----
 2 files changed, 10 insertions(+), 5 deletions(-)`;
  const result = parseGitDiffStat(output);
  assert.equal(result.filesChanged, 2);
  assert.equal(result.linesChanged, 15);
});

test("parseGitDiffStat: single file", async () => {
  const { parseGitDiffStat } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  const output = ` file1.js | 3 +++
 1 file changed, 3 insertions(+)`;
  const result = parseGitDiffStat(output);
  assert.equal(result.filesChanged, 1);
  assert.equal(result.linesChanged, 3);
});

test("parseGitDiffStat: empty output", async () => {
  const { parseGitDiffStat } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  const result = parseGitDiffStat("");
  assert.equal(result.filesChanged, 0);
  assert.equal(result.linesChanged, 0);
});

test("parseGitDiffStat: only deletions", async () => {
  const { parseGitDiffStat } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  const output = ` file1.js | 10 ----------
 1 file changed, 10 deletions(-)`;
  const result = parseGitDiffStat(output);
  assert.equal(result.filesChanged, 1);
  assert.equal(result.linesChanged, 10);
});

test("parseGitDiffStat: no insertions/deletions summary (binary)", async () => {
  const { parseGitDiffStat } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  const output = ` img.png | Bin 0 -> 1024 bytes`;
  const result = parseGitDiffStat(output);
  assert.equal(result.filesChanged, 1);
  assert.equal(result.linesChanged, 0);
});

test("parseGitDiffStat: whitespace-only output", async () => {
  const { parseGitDiffStat } = await import(
    "../../../scripts/loop/detect-change-scope.mjs"
  );
  const result = parseGitDiffStat("   \n  ");
  assert.equal(result.filesChanged, 0);
  assert.equal(result.linesChanged, 0);
});

// Close the integration tests describe block
});

// ============================================================================
// resolveGateAnglesDynamic tests
// ============================================================================

describe("resolveGateAnglesDynamic", () => {
  test("returns full angle list when dynamicAngles is false", async () => {
    const config = {
      version: 1,
      gates: {
        draft: { angles: ["scope", "coverage", "docs"], dynamicAngles: false },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft");
    assert.deepEqual(result.recommendedAngles, ["scope", "coverage", "docs"]);
    assert.deepEqual(result.skippedAngles, []);
    assert.equal(result.dynamicAnglesActive, false);
    assert.equal(result.fallbackToAll, false);
  });

  test("returns null recommendedAngles when no angles configured", async () => {
    const result = await resolveGateAnglesDynamic({ version: 1 }, "draft");
    assert.equal(result.recommendedAngles, null);
    assert.equal(result.dynamicAnglesActive, false);
  });

  test("returns full angle list when diff is not provided (dynamicAngles true)", async () => {
    const config = {
      version: 1,
      gates: {
        draft: { angles: ["scope", "coverage"], dynamicAngles: true },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft");
    assert.deepEqual(result.recommendedAngles, ["scope", "coverage"]);
    assert.equal(result.dynamicAnglesActive, false); // no diff → not active
  });

  test("activates dynamic resolution when diff provided and dynamicAngles true", async () => {
    const config = {
      version: 1,
      gates: {
        draft: { angles: ["scope", "coverage", "docs", "deep", "kiss"], dynamicAngles: true },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
      },
    });
    assert.equal(result.dynamicAnglesActive, true);
    // allDocs → DOCS_ONLY → relevant angles include docs, link-check, contract-surface, dry
    assert.ok(result.recommendedAngles.length > 0);
    assert.ok(result.recommendedAngles.length < 5); // narrowed from 5
  });

  test("respects excludeAngles during dynamic resolution", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "docs", "kiss"],
          excludeAngles: ["kiss"],
          dynamicAngles: true,
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
      },
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.ok(!result.recommendedAngles.includes("kiss"));
    assert.ok(!result.skippedAngles.includes("kiss")); // excluded before dynamic resolution
  });

  test("returns reasons for skipped angles", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage", "docs", "deep", "kiss", "dry", "srp", "soc"],
          dynamicAngles: true,
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
      },
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.ok(Object.keys(result.reasons).length > 0);
    for (const angle of result.skippedAngles) {
      assert.ok(result.reasons[angle], `reason missing for ${angle}`);
    }
  });

  test("includes mandatoryAngles always regardless of diff analysis", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage"],
          mandatoryAngles: ["pr-description", "correctness", "gate-evidence"],
          dynamicAngles: true,
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
      },
    });
    assert.equal(result.dynamicAnglesActive, true);
    // mandatoryAngles always included
    assert.ok(result.recommendedAngles.includes("pr-description"));
    assert.ok(result.recommendedAngles.includes("correctness"));
    assert.ok(result.recommendedAngles.includes("gate-evidence"));
    // mandatoryAngles never appear in skipped
    assert.ok(!result.skippedAngles.includes("pr-description"));
    assert.ok(!result.skippedAngles.includes("correctness"));
    assert.ok(!result.skippedAngles.includes("gate-evidence"));
  });

  test("mandatoryAngles also included in non-dynamic fallback", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope"],
          mandatoryAngles: ["pr-description"],
          dynamicAngles: true,
        },
      },
    };
    // no diff → dynamicAnglesActive is false, but mandatoryAngles still in result via resolveGateAngles
    const result = await resolveGateAnglesDynamic(config, "draft");
    assert.equal(result.dynamicAnglesActive, false);
    assert.deepEqual(result.recommendedAngles, ["pr-description", "scope"]);
  });

  test("backward compat: no mandatoryAngles = all angles are candidates", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage", "docs"],
          dynamicAngles: true,
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
      },
    });
    assert.equal(result.dynamicAnglesActive, true);
    // No mandatoryAngles config, all angles are candidates for filtering
    // docs change -> docs angle should be recommended
    assert.ok(result.recommendedAngles.includes("docs"));
    assert.ok(result.skippedAngles.includes("scope") || result.recommendedAngles.includes("scope"));
    assert.ok(result.skippedAngles.includes("coverage") || result.recommendedAngles.includes("coverage"));
  });

  test("deduplicates mandatoryAngles and candidate pool recommendations", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "pr-description"],
          mandatoryAngles: ["pr-description", "correctness"],
          dynamicAngles: true,
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tsrc/main.mjs",
      },
    });
    // pr-description is in both mandatory and candidate pool — no duplicate
    const occurrences = result.recommendedAngles.filter(a => a === "pr-description").length;
    assert.equal(occurrences, 1);
    assert.ok(result.recommendedAngles.includes("pr-description"));
  });
  test("excluded mandatoryAngles are NOT reintroduced in dynamic path", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope"],
          mandatoryAngles: ["pr-description", "correctness"],
          excludeAngles: ["correctness"],
          dynamicAngles: true,
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tsrc/main.mjs",
      },
    });
    assert.ok(!result.recommendedAngles.includes("correctness"));
    assert.ok(result.recommendedAngles.includes("pr-description"));
  });

});
