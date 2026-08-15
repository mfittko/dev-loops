import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  resolveHumanMergeOnly,
  resolveEffectiveMergeAuthorized,
  resolveEffectiveMergeAuthorizedFromLoad,
  resolveRefinementConfig,
  resolveRefinement,
  resolveGateConfig,
  resolveGateAngles,
  resolveGateAngleContract,
  resolveRejectForeignAngles,
  resolveGateAnglesDynamic,
  resolveGateTier,
  resolveAnglePool,
  resolveWorkflowConfig,
  resolveLightMode,
  resolveIssuelessEnabled,
  resolveGateDispatchMode,
  resolveFanoutGroups,
  resolveMaxAnglesPerGroup,
  resolveFanoutMaxConcurrent,
  resolveFanoutSequential,
  resolveFanoutEffectiveConcurrency,
  DEFAULT_MAX_ANGLES_PER_GROUP,
  DEFAULT_FANOUT_MAX_CONCURRENT,
  DEFAULT_FANOUT_SEQUENTIAL,
  resolveGateAngleScope,
  resolveEffectiveCopilotRoundCap,
  GATE_FULL_LABEL,
  resolveRequireFanoutEvidence,
  resolveRequireFanoutProvenance,
  FANOUT_PROVENANCE_MIN_REVIEWERS,
  resolveGatePostFindingsComments,
  resolveRoleModel,
  resolveBaseBranch,
  resolveTrackerProvider,
  resolveTrackerBoard,
} from "../src/config/config.mjs";
// #1592: a few fixtures below deliberately keep pre-rename severity spellings
// ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.
// ============================================================================
// Schema validation tests (S1–S26)
// ============================================================================

describe("schema validation", () => {
  test("S1: full valid config parses successfully", () => {
    const input = {
      version: 1,
      strategy: "local-first",
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

  test("S6: strategy is a bare enum (flattened, #1404) — an object value is rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      strategy: { default: "tracker-first" },
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
        requireDraftFirst: false,
        devModeDefault: true,
      },
    });
    assert.ok(result.success);
    assert.equal(result.data.workflow.asyncStartMode, "required");
    assert.equal(result.data.workflow.requireRetrospective, true);
    assert.equal(result.data.workflow.requireDraftFirst, false);
    assert.equal(result.data.workflow.devModeDefault, true);
  });

  test("S10c: unknown nested key inside workflow rejected", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      workflow: {
        asyncStartMode: "required",
        requireRetrospective: true,
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
      strategy: "neither",
    });
    assert.ok(!result.success);
  });

  test("S11b: inputSource.default bad enum", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      inputSource: "local-docs",
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

  test("S19b: autonomy.humanMergeOnly accepted as boolean; absent → undefined (issue #910)", () => {
    const set = DevLoopConfigSchema.safeParse({
      version: 1,
      autonomy: { stopAt: [], humanMergeOnly: true },
    });
    assert.ok(set.success, "humanMergeOnly: true should parse");
    assert.equal(set.data.autonomy.humanMergeOnly, true);

    const absent = DevLoopConfigSchema.safeParse({ version: 1, autonomy: { stopAt: ["merge"] } });
    assert.ok(absent.success);
    assert.equal(absent.data.autonomy.humanMergeOnly, undefined);

    const bad = DevLoopConfigSchema.safeParse({
      version: 1,
      autonomy: { stopAt: ["merge"], humanMergeOnly: "yes" },
    });
    assert.ok(!bad.success, "non-boolean humanMergeOnly rejected");
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

  // S24 (strategy.byWorkflow rejected) removed: strategy is now a bare enum
  // (#1404), so "an object under strategy is rejected" is already covered by
  // S6 above — a second object-shape variant added nothing.

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

  test("S27: uiReview.run with a valid readyUrl parses", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { run: { command: "npm start", readyUrl: "http://127.0.0.1:3000/health" } },
    });
    assert.ok(result.success);
  });

  test("S28: uiReview.run.readyUrl rejects a malformed URL", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { run: { command: "npm start", readyUrl: "not-a-url" } },
    });
    assert.ok(!result.success);
  });

  test("S28b: uiReview.run.readyUrl rejects a non-http(s) URL", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { run: { command: "npm start", readyUrl: "ftp://example.com/health" } },
    });
    assert.ok(!result.success);
  });

  test("S28c: uiReview.run.readyUrl accepts https", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { run: { command: "npm start", readyUrl: "https://example.com/health" } },
    });
    assert.ok(result.success);
  });

  test("S29: uiReview.run.migrate.destructivePattern rejects a malformed regex", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: {
        run: {
          command: "npm start",
          readyUrl: "http://127.0.0.1:3000/health",
          migrate: { statusCommand: "s", applyCommand: "a", destructivePattern: "[" },
        },
      },
    });
    assert.ok(!result.success);
  });

  test("S30: uiReview.run.migrate.destructivePattern accepts a valid regex", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: {
        run: {
          command: "npm start",
          readyUrl: "http://127.0.0.1:3000/health",
          migrate: { statusCommand: "s", applyCommand: "a", destructivePattern: "drop|truncate" },
        },
      },
    });
    assert.ok(result.success);
  });

  test("S31: destructivePattern valid bare but invalid under `u` flag is rejected at load", () => {
    // `[a-\d]` compiles as `new RegExp(p)` but throws under `new RegExp(p, "iu")`,
    // the exact flags inspectMigrations uses at the destructive-migration boundary.
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: {
        run: {
          command: "npm start",
          readyUrl: "http://127.0.0.1:3000/health",
          migrate: { statusCommand: "s", applyCommand: "a", destructivePattern: "[a-\\d]" },
        },
      },
    });
    assert.ok(!result.success);
  });

  test("S32: uiReview.login with loginUrl + submit/success selectors parses", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { login: { loginUrl: "http://127.0.0.1:3000/login", submitSelector: "button", successSelector: "#home" } },
    });
    assert.ok(result.success);
  });

  test("S33: uiReview.login.loginUrl rejects a non-http(s) URL", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { login: { loginUrl: "ftp://x/login", submitSelector: "b", successSelector: "#h" } },
    });
    assert.ok(!result.success);
  });

  test("S34: uiReview.login requires submitSelector and successSelector", () => {
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { login: { loginUrl: "http://x/login", successSelector: "#h" } },
    }).success);
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { login: { loginUrl: "http://x/login", submitSelector: "b" } },
    }).success);
  });

  test("S35: uiReview.flows steps require a known action", () => {
    assert.ok(DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "goto", path: "/decks" }] }] },
    }).success);
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "teleport" }] }] },
    }).success);
  });

  test("S35b: a selector-based step action requires a selector; goto does not", () => {
    assert.ok(DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "click", selector: "#save" }] }] },
    }).success);
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "click" }] }] },
    }).success);
  });

  test("S35c: goto requires a path and upload requires a value; both rejected at parse time", () => {
    // goto: accepts with a path, rejects without one (a missing path would drive "/").
    assert.ok(DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "goto", path: "/decks" }] }] },
    }).success);
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "goto" }] }] },
    }).success);
    // upload: accepts with a value (file path), rejects without one (setInputFiles("") throws).
    assert.ok(DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "upload", selector: "#file", value: "fixtures/a.png" }] }] },
    }).success);
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "upload", selector: "#file" }] }] },
    }).success);
  });

  test("S35d: a step may declare a viewport and an interactionState; both are validated", () => {
    assert.ok(DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "goto", path: "/", viewport: { width: 390, height: 844 }, interactionState: "error" }] }] },
    }).success);
    // Non-positive viewport dimensions are rejected (a bad descriptor must fail closed).
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "goto", path: "/", viewport: { width: 0, height: 844 } }] }] },
    }).success);
    // Only the route-named interaction states are accepted.
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { flows: [{ name: "decks", steps: [{ action: "goto", path: "/", interactionState: "wiggle" }] }] },
    }).success);
  });

  test("S36: uiReview.serverLogExceptionPattern rejects a malformed regex", () => {
    assert.ok(!DevLoopConfigSchema.safeParse({
      version: 1,
      uiReview: { serverLogExceptionPattern: "[" },
    }).success);
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

  test("strategy.default is local-first", () => {
    assert.equal(BUILT_IN_DEFAULTS.strategy, "local-first");
  });

  test("inputSource.default is tracker", () => {
    assert.equal(BUILT_IN_DEFAULTS.inputSource, "tracker");
  });

  test("refinement defaults include fanOut 3, mode parallel, maxCopilotRounds 5, and low-signal defaults", () => {
    assert.equal(BUILT_IN_DEFAULTS.refinement.fanOut, 3);
    assert.equal(BUILT_IN_DEFAULTS.refinement.mode, "parallel");
    assert.equal(BUILT_IN_DEFAULTS.refinement.maxCopilotRounds, 5);
    assert.equal(BUILT_IN_DEFAULTS.refinement.lowSignal.enabled, false);
    assert.equal(BUILT_IN_DEFAULTS.refinement.lowSignal.roundThreshold, 3);
    assert.equal(BUILT_IN_DEFAULTS.refinement.lowSignal.maxComments, 2);
  });

  test("autonomy.stopAt is [merge]", () => {
    assert.deepEqual(BUILT_IN_DEFAULTS.autonomy.stopAt, ["merge"]);
  });

  test("autonomy.humanMergeOnly defaults to false", () => {
    assert.equal(BUILT_IN_DEFAULTS.autonomy.humanMergeOnly, false);
  });

  // P5 (#953) AC2: the tracker-first/built-in posture is unchanged by the
  // local-first extension-defaults opinion. These constants are the built-in
  // surface and must stay tracker-first / high-noise-tolerant.
  test("queue.maxAutoFiledIssues built-in default stays 10 (#953 AC2)", () => {
    assert.equal(BUILT_IN_DEFAULTS.queue.maxAutoFiledIssues, 10);
  });

  test("gates.postFindingsComments built-in resolves false (opt-in second surface)", () => {
    // Built-in gates is empty; the consolidated findings comment duplicates the
    // round's verdict review, so it is off until a repo asks for it.
    assert.equal(resolveGatePostFindingsComments(BUILT_IN_DEFAULTS), false);
  });

  test("workflow defaults exist and use required async start with false boolean gates by default", () => {
    assert.deepEqual(BUILT_IN_DEFAULTS.workflow, {
      asyncStartMode: "required",
      requireRetrospective: false,
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

  test("L1-validation: invalid .devloops returns non-empty errors without throwing", async () => {
    // FIX C: loadDevLoopConfig never throws on a validation failure. Callers that
    // previously wrapped it in try/catch expecting a throw must instead treat a
    // non-empty errors array as "config unavailable".
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-invalid-"));
    try {
      // gates.requireFanoutEvidence must be a boolean; a string value fails schema validation.
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\ngates:\n  requireFanoutEvidence: \"yes\"\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      let result;
      await assert.doesNotReject(async () => {
        result = await loadDevLoopConfig({ repoRoot: tmpDir });
      });
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "validation failure should populate errors");
      // config object is still returned (merged), so callers can inspect errors and decide.
      assert.ok(result.config);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // #1578: a config layer carrying raw gates.<gate>.mandatoryAngles/
  // excludeAngles keys is rejected by the strict GateConfig schema. The
  // whole layer is dropped (packaged defaults remain), but the drop MUST NOT
  // be silent — a visible warning naming the offending keys is pushed to the
  // `warnings` channel (consistent with existing config warnings), not just
  // the `errors` channel that many consumers ignore.
  test("#1578: a raw-key gate layer is dropped with a visible warning naming the offending keys", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-raw-gate-keys-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        [
          "version: 1",
          "gates:",
          "  preApproval:",
          "    angles: [dry]",
          "    mandatoryAngles: [pr-checklist-matrix]",
          "    excludeAngles: [yagni]",
          "",
        ].join("\n"),
        "utf8",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      // The layer was rejected — errors is non-empty.
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "raw-key layer should populate errors");
      // A visible warning names the offending keys — not a silent drop.
      // Assert the full prefixed key paths appear (e.g.
      // gates.preApproval.mandatoryAngles) — the migration hint uses the
      // placeholder form gates.<gate>.mandatoryAngles, so matching the real
      // gate name proves the key-extraction worked, not the boilerplate. (#1578)
      assert.ok(
        result.warnings.some((w) =>
          /Offending key\(s\):/.test(w) &&
          /gates\.preApproval\.mandatoryAngles/.test(w) &&
          /gates\.preApproval\.excludeAngles/.test(w),
        ),
        "warnings should name the offending raw keys with their full path in the Offending key(s) segment",
      );
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
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L1b2: a plain consumer (no .devloops) ships grouped fan-out dispatch with a default grouping table (AC6)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-fanout-default-"));
    try {
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.gates.fanout.mode, "grouped");
      assert.ok(Array.isArray(result.config.gates.fanout.groups) && result.config.gates.fanout.groups.length > 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L1c: a consumer can opt INTO the retrospective gate via .devloops (#841)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-retro-on-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\nworkflow:\n  requireRetrospective: true\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.workflow.requireRetrospective, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L1d: a plain consumer (no .devloops) defaults devModeDefault OFF (#846)", async () => {
    // Dev mode is the dev-loop self-improvement mode (it edits the loop's own skill/agent prompts
    // after a phase); shipped defaults must not force it on consumers' ordinary product phases.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-devmode-off-"));
    try {
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.workflow.devModeDefault, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("L1e: a consumer can opt INTO dev mode via .devloops (#846)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-devmode-on-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\nworkflow:\n  devModeDefault: true\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.workflow.devModeDefault, true);
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
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy, "local-first");
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
        JSON.stringify({ version: 1, strategy: "local-first", refinement: { fanOut: 5 } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, strategy: "tracker-first" }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      // overrides.json beats defaults.json for strategy, but refinement falls through
      assert.equal(result.config.strategy, "tracker-first");
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
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      await writeFile(path.join(piDir, "overrides.json"), "broken json [[[");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy, "local-first");
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
        "strategy: local-first",
        "gates:",
        "  draft:",
        "    angles:",
        "      - name: scope",
        "        persona: review",
        "        prompt: Check scope",
        "    required: true",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy, "local-first");
      // Angle arrays merge BY NAME across layers (D3): this repo-defaults.yaml
      // layer overrides just the "scope" entry's prompt without restating the
      // packaged extension-defaults angle list.
      const scopeEntry = result.config.gates.draft.angles.find((a) => a.name === "scope");
      assert.equal(scopeEntry.prompt, "Check scope");
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
        "strategy: local-first",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy, "local-first");
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
        "strategy: tracker-first",
      ].join("\n"));
      await writeFile(path.join(piDir, "overrides.yaml"), [
        "version: 1",
        "strategy: local-first",
      ].join("\n"));
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy, "tracker-first");
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
      const { loadDevLoopConfig, resolveGateAngles } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      const angleNames = resolveGateAngles(result.config, "draft");
      assert.ok(angleNames.includes("scope"), "scope angle preserved");
      assert.ok(angleNames.includes("coverage"), "coverage angle preserved");
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
        JSON.stringify({ version: 1, strategy: "tracker-first" }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy, "tracker-first");
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
        JSON.stringify({ version: 1, strategy: "local-first" }));
      await writeFile(path.join(piDir, "defaults.yml"),
        "version: 1\nstrategy: tracker-first");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy, "tracker-first", ".yml should take priority over JSON");
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
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, unknownKey: true }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.strategy, "local-first");
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
      assert.equal(result.config.strategy, "local-first");
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
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, refinement: { fanOut: 7 } }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      assert.equal(result.config.refinement.fanOut, 7);
      assert.equal(result.config.strategy, "local-first");
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
      assert.equal(result.config.strategy, "local-first");
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
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 2, strategy: "tracker-first" }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.ok(result.config);
      // overrides.json rejected, defaults.json applied
      assert.equal(result.config.strategy, "local-first");
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
      assert.equal(result.config.strategy, "local-first");
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
        JSON.stringify({ version: 1, strategy: "local-first" }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy, "local-first");
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

  test("M7: overriding just an angle's persona preserves its prompt (D3 per-entry merge, not a whole-array restate)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-M7-"));
    try {
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({
          version: 1,
          gates: { draft: { angles: [{ name: "dry", persona: "review", prompt: "Built-in DRY prompt" }] } },
        }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({
          version: 1,
          gates: { draft: { angles: [{ name: "dry", persona: "custom-dry-reviewer" }] } },
        }),
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      const dryEntry = result.config.gates.draft.angles.find((a) => a.name === "dry");
      assert.equal(dryEntry.persona, "custom-dry-reviewer");
      // The overriding layer only restated `persona` — merge-by-name (D3)
      // shallow-merges the rest of the entry, so `prompt` from the base layer
      // survives rather than being dropped by a whole-array replace.
      assert.equal(dryEntry.prompt, "Built-in DRY prompt");
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
        requireDraftFirst: false,
        devModeDefault: true,
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// tracker: config block + deprecated aliases (issue #1408, the
// tracker-agnostic seam)
// ============================================================================

describe("tracker config (#1408)", () => {
  test("BUILT_IN_DEFAULTS.tracker.provider is github", () => {
    assert.equal(BUILT_IN_DEFAULTS.tracker.provider, "github");
  });

  test("resolveTrackerProvider defaults to github when unset", () => {
    assert.equal(resolveTrackerProvider({}), "github");
    assert.equal(resolveTrackerProvider({ tracker: { provider: "jira" } }), "jira");
  });

  test("resolveTrackerBoard prefers tracker.board over the deprecated queue.board", () => {
    assert.equal(resolveTrackerBoard({}), null);
    assert.deepEqual(resolveTrackerBoard({ queue: { board: { title: "Q" } } }), { title: "Q" });
    assert.deepEqual(resolveTrackerBoard({ tracker: { board: { number: 3 } } }), { number: 3 });
    assert.deepEqual(
      resolveTrackerBoard({ queue: { board: { title: "Q" } }, tracker: { board: { number: 3 } } }),
      { number: 3 },
    );
  });

  test("tracker.provider accepts any non-empty string (schema does not preclude an external provider)", () => {
    const result = FileConfigSchema.safeParse({ version: 1, tracker: { provider: "jira" } });
    assert.ok(result.success);
  });

  test("tracker has no fieldMappings key — the github provider's logical-column mapping is queue.statusColumns", () => {
    const result = FileConfigSchema.safeParse({
      version: 1,
      tracker: { fieldMappings: { next_up: "Ready" } },
    });
    assert.ok(!result.success);
  });

  test("tracker.board validation error names tracker.board, not queue.board", () => {
    const result = FileConfigSchema.safeParse({ version: 1, tracker: { board: {} } });
    assert.ok(!result.success);
    assert.ok(result.error.issues.some((i) => i.message === "tracker.board must set number or title"));
  });

  test("queue.board validation error still names queue.board", () => {
    const result = FileConfigSchema.safeParse({ version: 1, queue: { board: {} } });
    assert.ok(!result.success);
    assert.ok(result.error.issues.some((i) => i.message === "queue.board must set number or title"));
  });

  test("strategy: \"github-first\" is accepted as a deprecated alias for tracker-first, with a warning", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-tracker-alias-strategy-"));
    try {
      await writeFile(path.join(tmpDir, ".devloops"), "version: 1\nstrategy: github-first\n");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.equal(result.config.strategy, "tracker-first");
      assert.ok(result.warnings.some((w) => /strategy: "github-first" is a deprecated alias/.test(w)));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("gates.primeSharedPrefix (removed #1462) is stripped with a warning, not a hard fail", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-prime-removed-"));
    try {
      await writeFile(path.join(tmpDir, ".devloops"), "version: 1\ngates:\n  primeSharedPrefix: false\n  maxFanoutReviewers: 4\n");
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, [], "stale key must not drop the gates layer");
      assert.equal(result.config.gates.maxFanoutReviewers, 4, "rest of the gates layer still loads");
      assert.equal("primeSharedPrefix" in result.config.gates, false, "removed key does not survive into resolved config");
      assert.ok(result.warnings.some((w) => /gates\.primeSharedPrefix is removed/.test(w)));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("queue.board is accepted as a deprecated alias for tracker.board, with a warning", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-tracker-alias-board-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\nqueue:\n  board:\n    title: Legacy Board\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.config.tracker.board, { title: "Legacy Board" });
      assert.deepEqual(result.config.queue.board, { title: "Legacy Board" });
      assert.ok(result.warnings.some((w) => /queue\.board is a deprecated alias for tracker\.board/.test(w)));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("tracker.board set directly is not flagged as using the deprecated alias", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-tracker-board-canonical-"));
    try {
      await writeFile(
        path.join(tmpDir, ".devloops"),
        "version: 1\ntracker:\n  board:\n    title: New Board\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.config.tracker.board, { title: "New Board" });
      assert.equal(result.warnings.some((w) => /deprecated alias/.test(w)), false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// mergeConfigLayers — angle arrays merge BY NAME across layers (D3)
//
// gates.<gate>.angles is the one place `mergeConfigLayers` does NOT wholesale-
// replace an array across layers: entries merge by `name`, so a later layer
// can add a new angle or disable/override an existing one without restating
// the whole upstream list — the ergonomic mandatoryAngles/excludeAngles used
// to provide via separate flat keys.
// ============================================================================

describe("mergeConfigLayers — angle arrays merge by name (D3)", () => {
  // These tests override extensionDefaultsBasePath with a minimal stub layer
  // (no gates) so the shipped extension-defaults.yaml angle set never merges
  // in and interferes with the layering assertions below.
  async function stubExtensionDefaults(tmpDir) {
    const extDir = path.join(tmpDir, "stub-extension");
    await mkdir(extDir, { recursive: true });
    await writeFile(path.join(extDir, "extension-defaults.yaml"), "version: 1\n");
    return path.join(extDir, "extension-defaults");
  }

  test("a later layer ADDS a new angle without restating the base list", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-angle-add-"));
    try {
      const extensionDefaultsBasePath = await stubExtensionDefaults(tmpDir);
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, gates: { draft: { angles: ["scope", "coverage"] } } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        // Adds "custom-lens" only — does not restate scope/coverage.
        JSON.stringify({ version: 1, gates: { draft: { angles: ["custom-lens"] } } }),
      );
      const { loadDevLoopConfig, resolveGateAngles } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir, extensionDefaultsBasePath });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(resolveGateAngles(result.config, "draft"), ["scope", "coverage", "custom-lens"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("a later layer DISABLES a base angle (enabled: false) without restating the base list", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-angle-disable-"));
    try {
      const extensionDefaultsBasePath = await stubExtensionDefaults(tmpDir);
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({ version: 1, gates: { draft: { angles: ["scope", "coverage", "correctness"] } } }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        // Drops "coverage" only — does not restate scope/correctness.
        JSON.stringify({ version: 1, gates: { draft: { angles: [{ name: "coverage", enabled: false }] } } }),
      );
      const { loadDevLoopConfig, resolveGateAngles } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir, extensionDefaultsBasePath });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(resolveGateAngles(result.config, "draft"), ["scope", "correctness"]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("a later layer overrides one angle's flags (mandatory) while a sibling angle's persona/prompt survive untouched", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-angle-override-"));
    try {
      const extensionDefaultsBasePath = await stubExtensionDefaults(tmpDir);
      const piDir = path.join(tmpDir, ".pi", "dev-loop");
      await mkdir(piDir, { recursive: true });
      await writeFile(
        path.join(piDir, "defaults.json"),
        JSON.stringify({
          version: 1,
          gates: {
            draft: {
              angles: [
                { name: "scope", persona: "review", prompt: "Check scope" },
                "coverage",
              ],
            },
          },
        }),
      );
      await writeFile(
        path.join(piDir, "overrides.json"),
        JSON.stringify({ version: 1, gates: { draft: { angles: [{ name: "coverage", mandatory: true }] } } }),
      );
      const { loadDevLoopConfig, resolveGateConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir, extensionDefaultsBasePath });
      assert.deepEqual(result.errors, []);
      const gateConfig = resolveGateConfig(result.config, "draft");
      assert.deepEqual(gateConfig.mandatoryAngles, ["coverage"]);
      const scopeEntry = result.config.gates.draft.angles.find((a) => a.name === "scope");
      assert.equal(scopeEntry.persona, "review");
      assert.equal(scopeEntry.prompt, "Check scope");
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
      // Extension defaults intend local-first; built-in defaults are tracker-first.
      assert.equal(result.config.strategy, "local-first");
      assert.equal(result.config.workflow.requireDraftFirst, true);
      assert.equal(result.config.localImplementation.lightMode.enabled, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("E1b: shipped extension defaults yield the local-first low-noise posture (#953 AC1)", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-E1b-"));
    try {
      const { loadDevLoopConfig, resolveGatePostFindingsComments } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      // Local-first never auto-merges; a human always merges.
      assert.equal(result.config.autonomy.humanMergeOnly, true);
      // PR-first means auto-filing issues is near-zero; keep the cap minimal.
      assert.equal(result.config.queue.maxAutoFiledIssues, 1);
      // Gate findings already live on the PR as the round's verdict review, so
      // the consolidated second comment stays off.
      assert.equal(result.config.gates.postFindingsComments, false);
      assert.equal(resolveGatePostFindingsComments(result.config), false);
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
        "version: 1\nstrategy: tracker-first\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy, "tracker-first");
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
        "version: 1\nstrategy: tracker-first\n",
      );
      const { loadDevLoopConfig } = await import("../src/config/config.mjs");
      const result = await loadDevLoopConfig({ repoRoot: tmpDir });
      assert.equal(result.config.strategy, "tracker-first");
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
          "strategy: local-first",
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
      assert.equal(result.config.strategy, "local-first");
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
      { gates: { draft: { angles: [{ name: "style", model: "gpt-5" }] } } },
      "style",
    );
    assert.equal(result.persona, "default-reviewer");
    assert.equal(result.model, "gpt-5");
    assert.equal(result.fallback, true);
  });

  test("R4: unknown angle with model override", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "unknown", model: "claude-opus" }] } } },
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

  test("R6: absent gate config", () => {
    const result = resolveReviewerRole({ gates: {} }, "security");
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
      { gates: { draft: { angles: [{ name: "security", model: "" }] } } },
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
      { gates: { draft: { angles: [{ name: "dry", model: "gpt-5" }] } } },
      "dry",
    );
    assert.equal(result.persona, "review");
    assert.equal(result.model, "gpt-5");
    assert.equal(result.fallback, false);
  });

  // --- Config-driven persona overrides (now per-gate angle entries, D4) ---

  test("R14: config angle entry overrides built-in persona for same angle", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "dry", persona: "custom-dry-reviewer" }] } } },
      "dry",
    );
    assert.equal(result.persona, "custom-dry-reviewer");
    assert.equal(result.fallback, false);
  });

  test("R15: config angle entry adds new angle not in built-in registry", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "security", persona: "security-reviewer", model: "claude-opus" }] } } },
      "security",
    );
    assert.equal(result.persona, "security-reviewer");
    assert.equal(result.model, "claude-opus");
    assert.equal(result.fallback, false);
  });

  test("R16: angle entry model wins over persona (single source now, no separate defaultModel layer)", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "dry", persona: "review", model: "gpt-5" }] } } },
      "dry",
    );
    assert.equal(result.persona, "review");
    assert.equal(result.model, "gpt-5");
  });

  test("R17: unknown angle without a config entry still falls back to BUILTIN_PERSONAS", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [] } } },
      "scope",
    );
    assert.equal(result.persona, "review");
    assert.equal(result.fallback, false);
  });

  test("R18: consumer overrides built-in persona and sets a model", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "correctness", persona: "my-correctness-agent", model: "claude-sonnet" }] } } },
      "correctness",
    );
    assert.equal(result.persona, "my-correctness-agent");
    assert.equal(result.model, "claude-sonnet");
    assert.equal(result.fallback, false);
  });

  test("R19: built-in fallback returns null prompt when no config entry is present", () => {
    const result = resolveReviewerRole({}, "dry");
    assert.equal(result.persona, "review");
    assert.equal(result.prompt, null, "prompt should be null when the angle has no config entry");
    assert.equal(result.fallback, false);
  });

  test("R20: config angle entry provides a prompt; fallback does not duplicate it", () => {
    // Without config: persona resolves, prompt is null (lives in config only)
    const noConfig = resolveReviewerRole({}, "dry");
    assert.equal(noConfig.prompt, null);
    // With config: persona resolves with prompt from the angle entry
    const withConfig = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "dry", persona: "review", prompt: "Check duplication" }] } } },
      "dry",
    );
    assert.equal(withConfig.prompt, "Check duplication");
    assert.equal(withConfig.fallback, false);
  });

  test("R21: config angle entry prompt overrides built-in prompt", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "dry", persona: "review", prompt: "Custom DRY prompt for this project" }] } } },
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

  test("R23: config angle entry without a prompt resolves with null prompt", () => {
    const result = resolveReviewerRole(
      { gates: { draft: { angles: [{ name: "dry", persona: "custom-dry-reviewer" }] } } },
      "dry",
    );
    assert.equal(result.persona, "custom-dry-reviewer");
    assert.equal(result.prompt, null);
    assert.equal(result.fallback, false);
  });

  test("R24: an angle disabled on one gate does NOT shadow its real, enabled override on another gate (the shipped renderer-security case)", () => {
    // Mirrors this repo's own shipped .devloops: draft disables
    // renderer-security (a phantom enabled:false placeholder, no persona/
    // prompt) while preApproval configures it as a real, enabled angle with
    // its own persona/prompt. findAngleEntry searches draft first — if it
    // returned the disabled draft placeholder instead of skipping it, this
    // would resolve fallback:true / prompt:null instead of the real override.
    const config = {
      gates: {
        draft: { angles: ["scope", { name: "renderer-security", enabled: false }] },
        preApproval: { angles: ["dry", { name: "renderer-security", persona: "review", prompt: "Check renderer security." }] },
      },
    };
    const role = resolveReviewerRole(config, "renderer-security");
    assert.equal(role.persona, "review", "must resolve preApproval's real persona, not fall back");
    assert.equal(role.prompt, "Check renderer security.", "must resolve preApproval's real prompt");
    assert.equal(role.fallback, false, "must not report a fallback — a real override exists on preApproval");

    // The disabled placeholder must still do its OWN job: dropping
    // renderer-security from draft's own resolved angle list.
    const draftAngles = resolveGateAngles(config, "draft");
    assert.ok(!draftAngles.includes("renderer-security"), "renderer-security must stay excluded from draft's resolved angles");
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

    // humanMergeOnly — fixed, non-overridable human-merge rule (issue #910)
    test("resolveHumanMergeOnly defaults to false when absent", () => {
      assert.equal(resolveHumanMergeOnly({ version: 1 }), false);
      assert.equal(resolveHumanMergeOnly({ version: 1, autonomy: { stopAt: ["merge"] } }), false);
    });

    test("resolveHumanMergeOnly is true when set", () => {
      assert.equal(
        resolveHumanMergeOnly({ version: 1, autonomy: { stopAt: [], humanMergeOnly: true } }),
        true
      );
    });

    test("resolveAutonomyStopAt always includes 'merge' when humanMergeOnly true (even with stopAt: [])", () => {
      const result = resolveAutonomyStopAt({
        version: 1,
        autonomy: { stopAt: [], humanMergeOnly: true },
      });
      assert.ok(result.includes("merge"), "merge must be a forced human stop");
    });

    test("resolveAutonomyStopAt does not duplicate 'merge' when already present + humanMergeOnly", () => {
      const result = resolveAutonomyStopAt({
        version: 1,
        autonomy: { stopAt: ["merge"], humanMergeOnly: true },
      });
      assert.deepEqual(result, ["merge"]);
    });

    test("resolveEffectiveMergeAuthorized returns false when humanMergeOnly true even if mergeAuthorized true", () => {
      const config = { version: 1, autonomy: { stopAt: ["merge"], humanMergeOnly: true } };
      assert.equal(resolveEffectiveMergeAuthorized(true, config), false);
      assert.equal(resolveEffectiveMergeAuthorized(false, config), false);
    });

    test("resolveEffectiveMergeAuthorized honors mergeAuthorized when humanMergeOnly false/absent", () => {
      assert.equal(resolveEffectiveMergeAuthorized(true, { version: 1 }), true);
      assert.equal(resolveEffectiveMergeAuthorized(false, { version: 1 }), false);
      // fail closed on a non-boolean signal
      assert.equal(resolveEffectiveMergeAuthorized("yes", { version: 1 }), false);
    });

    test("resolveEffectiveMergeAuthorizedFromLoad fails closed when the config load has errors", () => {
      // The .devloops that would declare humanMergeOnly may be the very file that
      // failed to load — never grant merge authorization from an unverified config.
      assert.equal(
        resolveEffectiveMergeAuthorizedFromLoad(true, { config: { version: 1 }, errors: [new Error("invalid YAML")] }),
        false,
      );
    });

    test("resolveEffectiveMergeAuthorizedFromLoad honors the gate when load is clean", () => {
      // clean load, no humanMergeOnly → honors the flag
      assert.equal(resolveEffectiveMergeAuthorizedFromLoad(true, { config: { version: 1 }, errors: [] }), true);
      // clean load, humanMergeOnly → still false
      assert.equal(
        resolveEffectiveMergeAuthorizedFromLoad(true, { config: { version: 1, autonomy: { humanMergeOnly: true } }, errors: [] }),
        false,
      );
      // missing errors array treated as clean
      assert.equal(resolveEffectiveMergeAuthorizedFromLoad(true, { config: { version: 1 } }), true);
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
      assert.equal(result.preApprovalRequireCi, true);
    });

    test("resolveRefinement centralizes preApprovalRequireCi (#1337) from gates.preApproval.requireCi", () => {
      // Default true; explicit false is surfaced so every interpretLoopState caller
      // that builds refinement from resolveRefinement(config) honors the opt-out.
      assert.equal(resolveRefinement({ version: 1 }).preApprovalRequireCi, true);
      assert.equal(
        resolveRefinement({ version: 1, gates: { preApproval: { requireCi: false } } }).preApprovalRequireCi,
        false,
      );
      assert.equal(
        resolveRefinement({ version: 1, gates: { preApproval: { requireCi: true } } }).preApprovalRequireCi,
        true,
      );
    });

    test("resolveRefinement returns configured values", () => {
      const result = resolveRefinement({
        version: 1,
        refinement: { fanOut: 5, mode: "sequential", maxCopilotRounds: 7, lowSignal: { enabled: true, roundThreshold: 5, maxComments: 1 }, roles: ["security", "style"] }
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
        refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 5, lowSignal: { enabled: true, roundThreshold: 4, maxComments: 1 } },
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
        dynamicAngles: true,
        additiveAngles: false,
        blockCleanOnFindingSeverities: ["high"],
        mediumFixWindow: 3,
        tiers: [],
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
        dynamicAngles: true,
        additiveAngles: false,
        blockCleanOnFindingSeverities: ["high"],
        mediumFixWindow: 3,
        tiers: [],
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
            angles: ["scope", "coverage", "correctness", { name: "dry", enabled: false }],
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
            angles: ["dry", { name: "kiss", enabled: false }, "yagni", "deep", { name: "docs", enabled: false }],
          },
        },
      };
      const result = resolveGateAngles(config, "preApproval");
      assert.deepEqual(result, ["dry", "yagni", "deep"]);
    });

    test("resolveGateAngles with no disabled angles returns all angles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage"],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["scope", "coverage"]);
    });

    test("resolveGateAngles with all angles disabled returns empty array", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [{ name: "scope", enabled: false }, { name: "coverage", enabled: false }],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, []);
    });

    test("resolveGateAngles handles non-string/malformed entries gracefully", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", 42, null, "coverage", { name: "scope", enabled: false }],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      // Non-strings/malformed entries are dropped; the later `{name: "scope",
      // enabled: false}` entry merges by name with the earlier bare "scope",
      // disabling it.
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
      // The array key is present (not absent), so an all-garbage array still
      // resolves to an explicit empty list, not the "unconfigured" null.
      assert.deepEqual(result, []);
    });

    test("resolveGateAngles trims whitespace from angle names", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [{ name: " scope ", enabled: false }, "  coverage  ", "correctness"],
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
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["high"]);
    });

    test("resolveGateConfig returns configured blockCleanOnFindingSeverities", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            blockCleanOnFindingSeverities: ["high", "medium"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["high", "medium"]);
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
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["high"]);
    });

    test("resolveGateConfig blockCleanOnFindingSeverities returns a copy, not reference", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            blockCleanOnFindingSeverities: ["high", "medium"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      result.blockCleanOnFindingSeverities.push("defer");
      assert.deepEqual(config.gates.draft.blockCleanOnFindingSeverities, ["high", "medium"]);
    });

    test("resolveGateConfig returns blockCleanOnFindingSeverities for preApproval gate", () => {
      const config = {
        version: 1,
        gates: {
          preApproval: {
            angles: ["dry"],
            blockCleanOnFindingSeverities: ["high", "medium", "defer"],
          },
        },
      };
      const result = resolveGateConfig(config, "preApproval");
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["high", "medium", "low"]);
    });

    test("resolveGateConfig normalizes and dedupes legacy blockCleanOnFindingSeverities spellings", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope"],
            blockCleanOnFindingSeverities: ["must-fix", "nice-to-have", "defer"],
          },
        },
      };
      const result = resolveGateConfig(config, "draft");
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["high", "low"]);
    });

    // Backward compatibility (#1592): every pre-rename spelling still resolves
    // to its canonical replacement, so a live PR / unmigrated config carrying
    // the old vocabulary keeps behaving identically.
    test("resolveGateConfig normalizes a fully legacy-spelled blockCleanOnFindingSeverities list", () => {
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
      assert.deepEqual(result.blockCleanOnFindingSeverities, ["high", "medium"]);
    });

    test("resolveGateConfig honors the deprecated worthFixingNowFixWindow alias when mediumFixWindow is absent", () => {
      const config = {
        version: 1,
        gates: { draft: { worthFixingNowFixWindow: 5 } },
      };
      assert.equal(resolveGateConfig(config, "draft").mediumFixWindow, 5);
    });

    test("resolveGateConfig prefers mediumFixWindow over the deprecated worthFixingNowFixWindow alias when both are set", () => {
      const config = {
        version: 1,
        gates: { draft: { mediumFixWindow: 2, worthFixingNowFixWindow: 5 } },
      };
      assert.equal(resolveGateConfig(config, "draft").mediumFixWindow, 2);
    });

    // The canonical key must round-trip through the REAL loader (per-layer
    // FileConfigSchema parse + mergeGateObject), not just a hand-built plain
    // object — every prior test in this describe block only exercised the
    // alias, never this key, through loadDevLoopConfig.
    test("loadDevLoopConfig + resolveGateConfig honor a real .devloops file's canonical mediumFixWindow", async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-mediumfixwindow-"));
      try {
        await writeFile(
          path.join(tmpDir, ".devloops"),
          "version: 1\ngates:\n  draft:\n    mediumFixWindow: 7\n",
        );
        const { loadDevLoopConfig } = await import("../src/config/config.mjs");
        const { config, errors } = await loadDevLoopConfig({ repoRoot: tmpDir });
        assert.deepEqual(errors, []);
        assert.equal(resolveGateConfig(config, "draft").mediumFixWindow, 7);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    // This is the test that actually catches a schema-level `.default()` on
    // `mediumFixWindow` poisoning the deprecated-alias fallback: a layer that
    // sets ONLY the alias. Each config layer is parsed independently through
    // the FULL schema before merging (applyLayer → FileConfigSchema.safeParse
    // per layer), so a `.default(3)` on `mediumFixWindow` would fill it on
    // THIS layer's own parse even though the raw YAML never mentions it —
    // permanently shadowing the real `worthFixingNowFixWindow: 5` override the
    // test above alone would never expose (it never omits the canonical key).
    test("loadDevLoopConfig + resolveGateConfig honor a real .devloops file setting ONLY the deprecated worthFixingNowFixWindow alias", async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-wfn-alias-only-"));
      try {
        await writeFile(
          path.join(tmpDir, ".devloops"),
          "version: 1\ngates:\n  draft:\n    worthFixingNowFixWindow: 5\n",
        );
        const { loadDevLoopConfig } = await import("../src/config/config.mjs");
        const { config, errors } = await loadDevLoopConfig({ repoRoot: tmpDir });
        assert.deepEqual(errors, []);
        assert.equal(resolveGateConfig(config, "draft").mediumFixWindow, 5);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("FileConfigSchema accepts every canonical and legacy DEFECT severity spelling, plus the deprecated worthFixingNowFixWindow alias", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            blockCleanOnFindingSeverities: ["high", "medium", "low", "must-fix", "worth-fixing-now", "nice-to-have", "defer"],
            worthFixingNowFixWindow: 5,
          },
        },
      };
      assert.equal(FileConfigSchema.safeParse(config).success, true);
    });

    // #1592 follow-up: question/nit never block by severity — a config
    // blocking on either would fight the disposition pass, which
    // simultaneously auto-resolves them (question: answered/never-deferred;
    // nit: deferred immediately) regardless of what blocks a clean verdict.
    test("GateConfig rejects question/nit in blockCleanOnFindingSeverities (non-defect categories never block by severity)", () => {
      for (const severity of ["question", "nit"]) {
        const result = FileConfigSchema.safeParse({
          version: 1,
          gates: { draft: { blockCleanOnFindingSeverities: [severity] } },
        });
        assert.equal(result.success, false, severity);
      }
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

    test("GateConfig accepts a mandatory angle entry (was mandatoryAngles)", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", { name: "pr-description", mandatory: true }, { name: "correctness", mandatory: true }],
          },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, true);
    });

    test("GateConfig rejects an angle entry with an empty name", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [{ name: "", mandatory: true }],
          },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, false);
    });

    test("GateConfig accepts angles as optional (absent)", () => {
      const config = {
        version: 1,
        gates: {
          draft: { required: true },
        },
      };
      const result = FileConfigSchema.safeParse(config);
      assert.equal(result.success, true);
    });

    // --- mandatoryAngles (now a per-entry `mandatory: true`, folded off gates.<gate>.angles) ---
    test("resolveGateConfig returns mandatoryAngles", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: ["scope", "coverage", { name: "pr-description", mandatory: true }, { name: "correctness", mandatory: true }],
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
            angles: ["scope", "coverage", { name: "pr-description", mandatory: true }, { name: "correctness", mandatory: true }],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "correctness", "scope", "coverage"]);
    });

    test("resolveGateAngles excludes mandatoryAngles matching a disabled entry", () => {
      const config = {
        version: 1,
        gates: {
          draft: {
            angles: [
              "scope",
              { name: "pr-description", mandatory: true },
              { name: "correctness", mandatory: true, enabled: false },
              { name: "gate-evidence", mandatory: true },
            ],
          },
        },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "gate-evidence", "scope"]);
    });

    test("resolveGateAngles returns null when angles absent", () => {
      const config = {
        version: 1,
        gates: { draft: {} },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, null);
    });

    test("resolveGateAngles returns only mandatoryAngles when angles configured with only mandatory entries", () => {
      const config = {
        version: 1,
        gates: { draft: { angles: [{ name: "pr-description", mandatory: true }, { name: "correctness", mandatory: true }] } },
      };
      const result = resolveGateAngles(config, "draft");
      assert.deepEqual(result, ["pr-description", "correctness"]);
    });

    test("resolveGateConfig default booleans include empty mandatoryAngles", () => {
      const result = resolveGateConfig({ version: 1 }, "draft");
      assert.deepEqual(result.mandatoryAngles, []);
    });

    // extraAngles (#1392) removed: D3's merge-by-name lets a later config layer
    // add a plain (non-mandatory) angle to gates.<gate>.angles directly, without
    // restating the list — the exact "add without restating" ergonomic
    // extraAngles used to provide at the single-layer level. See the
    // "mergeConfigLayers — angle arrays merge by name (D3)" describe block for
    // the layering-level add/disable-without-restate contract tests.

        test("resolveRefinement returns new roles array (not reference to config)", () => {
      const config = { version: 1, refinement: { fanOut: 2, mode: "parallel", roles: ["security"] } };
      const result = resolveRefinement(config);
      result.roles.push("style");
      assert.deepEqual(config.refinement.roles, ["security"]);
    });

    test("resolveWorkflowConfig returns built-in defaults when workflow family is absent", () => {
      assert.equal(resolveWorkflowConfig({ version: 1 }, "asyncStartMode"), "required");
      assert.equal(resolveWorkflowConfig({ version: 1 }, "requireRetrospective"), false);
      assert.equal(resolveWorkflowConfig({ version: 1 }, "requireDraftFirst"), false);
      assert.equal(resolveWorkflowConfig({ version: 1 }, "devModeDefault"), false);
    });

    test("resolveWorkflowConfig returns configured workflow values", () => {
      const config = {
        version: 1,
        workflow: {
          asyncStartMode: "allowed",
          requireRetrospective: true,
          requireDraftFirst: true,
          devModeDefault: false,
        },
      };
      assert.equal(resolveWorkflowConfig(config, "asyncStartMode"), "allowed");
      assert.equal(resolveWorkflowConfig(config, "requireRetrospective"), true);
      assert.equal(resolveWorkflowConfig(config, "requireDraftFirst"), true);
      assert.equal(resolveWorkflowConfig(config, "devModeDefault"), false);
    });

    test("resolveWorkflowConfig falls through to built-in false when an individual key is absent", () => {
      const config = { version: 1, workflow: { requireDraftFirst: true } };
      assert.equal(resolveWorkflowConfig(config, "asyncStartMode"), "required");
      assert.equal(resolveWorkflowConfig(config, "requireRetrospective"), false);
      assert.equal(resolveWorkflowConfig(config, "requireDraftFirst"), true);
      assert.equal(resolveWorkflowConfig(config, "devModeDefault"), false);
    });

    test("resolveWorkflowConfig throws on unknown key", () => {
      assert.throws(() => resolveWorkflowConfig({ version: 1 }, "unknownKey"), /Unknown workflow config key/);
    });
  });

});

// ============================================================================
// Byte-identical shipped-config parity guard (post #1404 config-schema
// redesign): D3's merge-by-name change means gates.<gate>.angles no longer
// wholesale-replaces the extension-defaults angle list across layers — a
// consumer .devloops must now explicitly disable a shipped angle it doesn't
// want (enabled: false), or the angle silently merges back in by name. Pins
// this repo's own shipped .devloops + extension-defaults.yaml against the
// exact angle sets / mandatory sets the pre-redesign flat-key config
// resolved (blockCleanOnFindingSeverities is pinned to the current shipped
// baseline instead — see CURRENT_BLOCK_CLEAN below), so a future edit can't
// silently regrow (or shrink) the effective gate-review surface.
// ============================================================================

describe("shipped .devloops + extension-defaults.yaml resolve byte-identically to pre-#1404 for angle/mandatory sets; blockCleanOnFindingSeverities tracks the current shipped baseline for draft/preApproval and stays pinned to pre-#1404 for spike (D3 regression guard)", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

  // The exact sets origin/main (pre-#1404, flat mandatoryAngles/excludeAngles
  // keys, wholesale-replace merge) resolved for this repo's own shipped
  // .devloops + extension-defaults.yaml. Order is NOT pinned — resolveGateAngles
  // never documented a specific order, and D3's merge-by-name (target-then-
  // append) inherently can't preserve a later layer's reordering of names the
  // base layer already declared; only set membership is a real contract.
  const PRE_1404_ANGLE_SETS = {
    draft: [
      "scope", "coverage", "correctness", "ci-guard", "contract-surface",
      "input-validation", "determinism", "no-op", "link-check",
      "packaging-runtime", "state-concurrency", "config-drift", "gate-evidence",
      "pr-description", "pr-comments", "contradiction-lens", "code-conformance",
      "semantic-drift",
    ],
    preApproval: [
      "dry", "kiss", "yagni", "srp", "soc", "deep", "docs", "ocp", "lsp", "isp",
      "dip", "renderer-security", "pr-checklist-matrix", "acceptance-criteria",
      "contradiction-lens", "correctness-final", "ui-validation",
    ],
    spike: ["scope", "docs"],
  };
  const PRE_1404_MANDATORY_SETS = {
    draft: ["pr-description"],
    preApproval: ["pr-checklist-matrix", "acceptance-criteria", "yagni", "contradiction-lens"],
    spike: [],
  };
  // draft's and preApproval's blocking sets are NOT the pre-#1404 baseline:
  // both were deliberately narrowed to high only (see the .devloops
  // gates.draft and gates.preApproval comments / issue #1527) because
  // medium churns every gate round on a non-trivial change and
  // never converges. spike is still pinned to its pre-#1404 value — draft's
  // and preApproval's entries here track the current shipped baseline
  // rather than the pre-#1404 one.
  const CURRENT_BLOCK_CLEAN = {
    draft: ["high"],
    preApproval: ["high"],
    spike: ["high"],
  };

  const sortedSet = (arr) => [...new Set(arr)].sort();

  for (const gate of /** @type {const} */ (["draft", "preApproval", "spike"])) {
    test(`${gate} gate: resolved angle set and mandatory set match pre-#1404; blockCleanOnFindingSeverities matches the current shipped baseline for draft/preApproval and the pre-#1404 baseline for spike (see CURRENT_BLOCK_CLEAN comment above)`, async () => {
      const { loadDevLoopConfig, resolveGateAngles, resolveGateConfig } = await import("../src/config/config.mjs");
      const { config, errors } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
      assert.deepEqual(errors, []);
      const angles = resolveGateAngles(config, gate);
      const gateConfig = resolveGateConfig(config, gate);
      assert.deepEqual(sortedSet(angles), sortedSet(PRE_1404_ANGLE_SETS[gate]), `${gate} angle set`);
      assert.deepEqual(sortedSet(gateConfig.mandatoryAngles), sortedSet(PRE_1404_MANDATORY_SETS[gate]), `${gate} mandatory set`);
      assert.deepEqual(sortedSet(gateConfig.blockCleanOnFindingSeverities), sortedSet(CURRENT_BLOCK_CLEAN[gate]), `${gate} blockCleanOnFindingSeverities`);
    });
  }

  // Every angle that had a real config.personas[angle] entry pre-#1404 (a
  // persona + a written prompt, not just a BUILTIN_PERSONAS fallback) must
  // still resolve to the SAME persona and a prompt with the same recognizable
  // opening text now that the override lives on the gate's own angle entry.
  // A dropped prompt (persona still matching by coincidence, e.g. both
  // resolve to the generic "review" persona, while the prompt silently goes
  // null) is exactly the class of regression this guards — acceptance-criteria
  // was found missing its prompt this way during review.
  const PRE_1404_PERSONA_PROMPTS = {
    scope: ["review", "Check whether every changed file belongs in this PR"],
    coverage: ["review", "Check whether tests cover the changed behavior adequately"],
    correctness: ["review", "Check whether the implementation matches the acceptance criteria"],
    "ci-guard": ["review", "Audit CI/workflow semantics for reproducibility"],
    "contract-surface": ["review", "Review this change for public contract-surface drift"],
    "input-validation": ["review", "Review this change for input-validation drift"],
    determinism: ["review", "Review this change for determinism"],
    "no-op": ["review", "Flag workflow or tool invocations that are effectively no-ops"],
    "link-check": ["review", "Validate link and path correctness"],
    "packaging-runtime": ["review", "Review this change for packaging/runtime asset contract gaps"],
    "state-concurrency": ["review", "Review this change for state concurrency and locking risks"],
    "config-drift": ["review", "Cross-check config, schema, and documentation for contract drift"],
    "gate-evidence": ["review", "Verify that required workflow checkpoint evidence is present"],
    "pr-description": ["review", "Review the PR description for completeness"],
    "pr-comments": ["review", "Scan PR comments for unresolved issues"],
    dry: ["review", "Flag duplicated logic, repeated patterns"],
    kiss: ["review", "Flag over-engineering and unnecessary complexity"],
    yagni: ["review", "Flag speculative features, future-proofing"],
    srp: ["review", "Single Responsibility Principle"],
    soc: ["review", "Separation of Concerns"],
    deep: ["review", "Perform a structural code quality audit"],
    docs: ["docs", "Review documentation correctness"],
    ocp: ["review", "Open/Closed Principle"],
    lsp: ["review", "Liskov Substitution Principle"],
    isp: ["review", "Interface Segregation Principle"],
    dip: ["review", "Dependency Inversion Principle"],
    "renderer-security": ["review", "Review this change for renderer security"],
    "pr-checklist-matrix": ["review", "Verify before approval that the PR checklist"],
    "acceptance-criteria": ["review", "Verify that each acceptance criterion and definition-of-done item"],
  };
  // Angles used by the shipped gates that never had a personas[angle] entry
  // pre-#1404 — must keep falling back to default-reviewer with a null prompt.
  const FALLBACK_ANGLES = ["contradiction-lens", "code-conformance", "semantic-drift", "correctness-final", "ui-validation"];

  test("every pre-#1404 personas[angle] entry still resolves the same persona + prompt from its gate entry", async () => {
    const { loadDevLoopConfig, resolveReviewerRole } = await import("../src/config/config.mjs");
    const { config, errors } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    assert.deepEqual(errors, []);
    for (const [angle, [persona, promptStart]] of Object.entries(PRE_1404_PERSONA_PROMPTS)) {
      const role = resolveReviewerRole(config, angle);
      assert.equal(role.persona, persona, `${angle} persona`);
      assert.ok(role.prompt && role.prompt.startsWith(promptStart), `${angle} prompt should start with ${JSON.stringify(promptStart)}, got ${JSON.stringify(role.prompt?.slice(0, 60))}`);
    }
    for (const angle of FALLBACK_ANGLES) {
      const role = resolveReviewerRole(config, angle);
      assert.equal(role.persona, "default-reviewer", `${angle} persona`);
      assert.equal(role.prompt, null, `${angle} prompt`);
    }

    // "threat-model" is genuinely disabled (dropped) from every one of this
    // repo's shipped gates, same as pre-#1404 (it was likewise absent from
    // every resolved angle pool there — its old top-level personas[angle]
    // entry was reachable ONLY because that registry was global and
    // independent of any gate's angle list, a property D3's per-gate angle
    // entries deliberately don't reproduce for a name disabled everywhere:
    // findAngleEntry has no live caller that queries a name outside some
    // gate's enabled, resolved angle list). It still resolves via
    // BUILTIN_PERSONAS (persona "review", no prompt there either) rather
    // than the generic default-reviewer fallback, since it IS a known builtin
    // persona name — just with no reachable prompt override anymore.
    const threatModel = resolveReviewerRole(config, "threat-model");
    assert.equal(threatModel.persona, "review");
    assert.equal(threatModel.prompt, null);
    assert.equal(threatModel.fallback, false);
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

      const roles = {};
      for (const angle of requiredAngles) {
        const role = resolveReviewerRole(result.config, angle);
        roles[angle] = role;
        assert.equal(role.persona, "review", `${angle} should use review persona`);
        assert.equal(role.fallback, false, `${angle} should resolve from persona registry`);
        assert.doesNotMatch(role.prompt, /mfittko\/dev-loops|issue #?\d+|tmp\/investigation|uncategorized-clusters/i, `${angle} prompt should stay repo-agnostic`);
      }

      assert.match(roles["contract-surface"].prompt, /schema fields, state\/sentinel names, runtime values, tests, and CLI output agree/i);
      assert.match(roles["input-validation"].prompt, /repo slug, issue number, host, SHA, whitespace, and sentinel normalization/i);
      assert.match(roles["packaging-runtime"].prompt, /installed packages, extensions, or runtime bundles/i);
      assert.match(roles["state-concurrency"].prompt, /state-file read\/modify\/write paths/i);
      assert.match(roles["renderer-security"].prompt, /HTML text escaping, URL encoding, attribute encoding/i);
      assert.match(roles.determinism.prompt, /ordering, tie-breakers, localeCompare use/i);
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
      assert.equal(docsRole.persona, "docs");
      assert.match(docsRole.prompt, /Review documentation correctness/i);
      assert.equal(deepRole.persona, "review");
      assert.match(deepRole.prompt, /Perform a structural code quality audit of this PR/i);
      assert.match(deepRole.prompt, /deslop audit/i);
      assert.ok(preApprovalAngles.includes("docs"), "docs must be enabled by default for pre-approval");
      assert.ok(preApprovalAngles.includes("deep"), "deep must run by default for pre-approval");
      assert.equal(docsRole.fallback, false);
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
      assert.equal(prDescRole.persona, "review");
      assert.match(prDescRole.prompt, /Summary section/i);
      assert.match(prDescRole.prompt, /Validation command section/i);
      assert.match(prDescRole.prompt, /Do not block on formatting/i);
      assert.match(prDescRole.prompt, /linked issue acceptance criteria/i);
      assert.match(prDescRole.prompt, /single sentence/i);
      assert.match(prDescRole.prompt, /Closes #N/i);
      assert.match(prDescRole.prompt, /operator-intended close target/i);
      assert.match(prDescRole.prompt, /Scope and context section/i);
      // The File-by-file requirement was removed: GitHub's Files-changed tab already
      // lists touched files, and mandating the section churned gate findings every fix
      // round. The angle must neither require it nor be worded to flag its absence.
      assert.doesNotMatch(prDescRole.prompt, /File-by-file/i);
      assert.match(prDescRole.prompt, /Definition of done section/i);
      assert.match(prDescRole.prompt, /Non-goals section/i);
      assert.ok(draftAngles.includes("pr-description"), "pr-description must be in draft gate angles after settings opt-in");
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
      assert.equal(checklistRole.persona, "review");
      assert.match(checklistRole.prompt, /checkbox/i);
      assert.match(checklistRole.prompt, /AC\/DoD\/non-goals matrix/i);
      assert.match(checklistRole.prompt, /markdown table/i);
      assert.match(checklistRole.prompt, /unchecked/i);
      assert.ok(preApprovalAngles.includes("pr-checklist-matrix"), "pr-checklist-matrix must be in pre-approval gate angles after settings opt-in");
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
        angles: ["deep", { name: "dry", enabled: false }, "scope"],
      },
    },
  };
  const angles = resolveGateAngles(config, "preApproval");
  assert.deepStrictEqual(angles, ["deep", "scope"]);
  // "dry" should be excluded
  assert.ok(!angles.includes("dry"));
});
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

// ── LocalImplementation issue-less PR-first opt-in (#1349) ────────────────

test("resolveIssuelessEnabled is false when issueless is absent", () => {
  assert.equal(resolveIssuelessEnabled({ version: 1 }), false);
  assert.equal(resolveIssuelessEnabled({ version: 1, localImplementation: {} }), false);
});

test("resolveIssuelessEnabled is false when enabled=false or malformed", () => {
  assert.equal(resolveIssuelessEnabled({ version: 1, localImplementation: { issueless: false } }), false);
  assert.equal(resolveIssuelessEnabled({ version: 1, localImplementation: { issueless: "yes" } }), false);
});

test("resolveIssuelessEnabled is true when enabled", () => {
  assert.equal(resolveIssuelessEnabled({ version: 1, localImplementation: { issueless: true } }), true);
});

test("schema accepts localImplementation.issueless as a bare boolean (flattened, #1404)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-issueless-"));
  try {
    await writeFile(
      path.join(tmpDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  issueless: true\n",
      "utf8",
    );
    const { loadDevLoopConfig: load } = await import("../src/config/config.mjs");
    const result = await load({ repoRoot: tmpDir });
    assert.deepStrictEqual(result.errors, []);
    assert.equal(result.config.localImplementation.issueless, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("schema rejects a non-boolean issueless value at config load", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-issueless-type-"));
  try {
    await writeFile(
      path.join(tmpDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  issueless: \"yes\"\n",
      "utf8",
    );
    const { loadDevLoopConfig: load } = await import("../src/config/config.mjs");
    const result = await load({ repoRoot: tmpDir });
    assert.ok(result.errors.length > 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("schema rejects an object under localImplementation.issueless (flattened to a bare boolean)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-issueless-bad-"));
  try {
    await writeFile(
      path.join(tmpDir, ".devloops"),
      "version: 1\nlocalImplementation:\n  issueless:\n    enabled: true\n",
      "utf8",
    );
    const { loadDevLoopConfig: load } = await import("../src/config/config.mjs");
    const result = await load({ repoRoot: tmpDir });
    assert.ok(result.errors.length > 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("resolveGateDispatchMode: over-threshold stays full_fanout regardless of issueless.enabled (#1349 no-conflation)", () => {
  const config = {
    version: 1,
    localImplementation: {
      lightMode: { enabled: true, maxFiles: 3, maxLines: 200 },
      issueless: { enabled: true },
    },
  };
  const result = resolveGateDispatchMode(config, "draft", { scope: { filesChanged: 10, linesChanged: 999 } });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "over_threshold");
});

// ── Effective Copilot round cap composition (#1210) ───────────────────────

test("resolveEffectiveCopilotRoundCap: full PR (lightweight=false) uses maxCopilotRounds unchanged", () => {
  const config = { version: 1, refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 5 } };
  assert.equal(resolveEffectiveCopilotRoundCap(config), 5);
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: false }), 5);
});

test("resolveEffectiveCopilotRoundCap: lightweight with no lightMode.maxCopilotRounds override defaults to 1", () => {
  const config = { version: 1, refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 5 } };
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: true }), 1);
});

test("resolveEffectiveCopilotRoundCap: lightweight respects an explicit lightMode.maxCopilotRounds override", () => {
  const config = {
    version: 1,
    refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 5 },
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20, maxCopilotRounds: 3 } },
  };
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: true }), 3);
});

test("resolveEffectiveCopilotRoundCap: maxCopilotRounds=0 disables Copilot rounds everywhere, including lightweight", () => {
  const config = {
    version: 1,
    refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 0 },
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20, maxCopilotRounds: 3 } },
  };
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: true }), 0);
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: false }), 0);
});

test("resolveEffectiveCopilotRoundCap: lightweight cap composes as min(lightCap, maxCopilotRounds), not lightCap alone", () => {
  const config = {
    version: 1,
    refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: 2 },
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20, maxCopilotRounds: 10 } },
  };
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: true }), 2);
});

test("resolveEffectiveCopilotRoundCap: negative caps from programmatically-built configs clamp to 0", () => {
  const config = {
    version: 1,
    refinement: { fanOut: 3, mode: "parallel", maxCopilotRounds: -3 },
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20, maxCopilotRounds: -1 } },
  };
  assert.equal(resolveEffectiveCopilotRoundCap(config), 0);
  assert.equal(resolveEffectiveCopilotRoundCap(config, { lightweight: true }), 0);
});

test("resolveEffectiveCopilotRoundCap: schema default supplies lightMode.maxCopilotRounds=1 when parsed", () => {
  const parsed = DevLoopConfigSchema.parse({
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20 } },
  });
  assert.equal(parsed.localImplementation.lightMode.maxCopilotRounds, 1);
});

// ── Gate dispatch mode ───────────────────────────────────────────────────

const lightConfig = (over = {}) => ({
  version: 1,
  localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20, ...over } },
  gates: {
    preApproval: { blockCleanOnFindingSeverities: ["high", "medium"] },
  },
});

test("resolveGateDispatchMode: gate:full label forces full fan-out even when tiny", () => {
  const result = resolveGateDispatchMode(lightConfig(), "preApproval", {
    scope: { filesChanged: 1, linesChanged: 1 },
    hasFullLabel: true,
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "gate_full_label");
});

test("resolveGateDispatchMode: light mode disabled → full fan-out", () => {
  const result = resolveGateDispatchMode(lightConfig({ enabled: false }), "preApproval", {
    scope: { filesChanged: 1, linesChanged: 1 },
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "light_mode_disabled");
});

test("resolveGateDispatchMode: over threshold on files → full fan-out", () => {
  const result = resolveGateDispatchMode(lightConfig(), "preApproval", {
    scope: { filesChanged: 3, linesChanged: 5 },
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "over_threshold");
});

test("resolveGateDispatchMode: over threshold on lines → full fan-out", () => {
  const result = resolveGateDispatchMode(lightConfig(), "preApproval", {
    scope: { filesChanged: 1, linesChanged: 21 },
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "over_threshold");
});

test("resolveGateDispatchMode: missing/empty scope → over_threshold (Infinity fail-safe)", () => {
  const result = resolveGateDispatchMode(lightConfig(), "preApproval", { scope: {} });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "over_threshold");
});

test("resolveGateDispatchMode: under threshold, no findings → inline", () => {
  const config = lightConfig();
  const result = resolveGateDispatchMode(config, "preApproval", {
    scope: { filesChanged: 2, linesChanged: 20 },
  });
  assert.equal(result.mode, "inline");
  assert.equal(result.reason, "under_threshold");
  assert.deepStrictEqual(result.threshold, resolveLightMode(config));
});

test("resolveGateDispatchMode: under threshold + blocking inline finding → escalated", () => {
  const result = resolveGateDispatchMode(lightConfig(), "preApproval", {
    scope: { filesChanged: 1, linesChanged: 5 },
    inlineFindingSeverities: ["medium"],
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "escalated");
});

test("resolveGateDispatchMode: under threshold + only non-blocking finding → inline", () => {
  const result = resolveGateDispatchMode(lightConfig(), "preApproval", {
    scope: { filesChanged: 1, linesChanged: 5 },
    inlineFindingSeverities: ["defer"],
  });
  assert.equal(result.mode, "inline");
  assert.equal(result.reason, "under_threshold");
});

test("resolveGateDispatchMode: draft gate under threshold + medium-only inline finding → stays inline (high-only blocking set)", () => {
  const config = {
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20 } },
    gates: { draft: { blockCleanOnFindingSeverities: ["high"] } },
  };
  const result = resolveGateDispatchMode(config, "draft", {
    scope: { filesChanged: 1, linesChanged: 5 },
    inlineFindingSeverities: ["medium"],
  });
  assert.equal(result.mode, "inline");
  assert.equal(result.reason, "under_threshold");
});

test("resolveGateDispatchMode: draft gate under threshold + high inline finding → escalated", () => {
  const config = {
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20 } },
    gates: { draft: { blockCleanOnFindingSeverities: ["high"] } },
  };
  const result = resolveGateDispatchMode(config, "draft", {
    scope: { filesChanged: 1, linesChanged: 5 },
    inlineFindingSeverities: ["high"],
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "escalated");
});

test("resolveGateDispatchMode: legacy-spelled config blocking list still escalates against a legacy-spelled inline finding (backward compat)", () => {
  const config = {
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20 } },
    gates: { draft: { blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"] } },
  };
  const result = resolveGateDispatchMode(config, "draft", {
    scope: { filesChanged: 1, linesChanged: 5 },
    inlineFindingSeverities: ["worth-fixing-now"],
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "escalated");
});

test("GATE_FULL_LABEL is gate:full", () => {
  assert.equal(GATE_FULL_LABEL, "gate:full");
});

// ── Grouped fan-out dispatch (AC6) ────────────────────────────────────────

function fanoutConfig(groups) {
  return { version: 1, gates: { fanout: { mode: "grouped", groups } } };
}

test("resolveFanoutGroups: grouped default batches resolved angles onto their configured group", () => {
  const config = fanoutConfig([
    { name: "docs-surface", angles: ["docs", "link-check"] },
  ]);
  const result = resolveFanoutGroups(config, "draft", ["docs", "link-check", "correctness"]);
  assert.deepEqual(result, [
    { name: "docs-surface", angles: ["docs", "link-check"] },
    { name: "correctness", angles: ["correctness"] },
  ]);
});

test("resolveFanoutGroups: an ungrouped angle colliding with an emitted group name gets a disambiguated unit name", () => {
  const config = fanoutConfig([{ name: "docs", angles: ["link-check"] }]);
  const result = resolveFanoutGroups(config, "draft", ["link-check", "docs"]);
  assert.deepEqual(result, [
    { name: "docs", angles: ["link-check"] },
    { name: "angle:docs", angles: ["docs"] },
  ]);
  assert.equal(new Set(result.map((g) => g.name)).size, result.length);
});

test("resolveFanoutGroups: an angle not covered by any group forms an implicit singleton group", () => {
  const config = fanoutConfig([{ name: "docs-surface", angles: ["docs"] }]);
  const result = resolveFanoutGroups(config, "draft", ["scope"]);
  assert.deepEqual(result, [{ name: "scope", angles: ["scope"] }]);
});

test("resolveFanoutGroups: a configured group with none of its angles resolved is dropped", () => {
  const config = fanoutConfig([
    { name: "docs-surface", angles: ["docs", "link-check"] },
    { name: "process", angles: ["scope", "pr-description"] },
  ]);
  const result = resolveFanoutGroups(config, "draft", ["scope"]);
  assert.deepEqual(result, [{ name: "process", angles: ["scope"] }]);
});

test("resolveFanoutGroups: mode per-angle opts into one group per angle regardless of the grouping table", () => {
  const config = {
    version: 1,
    gates: { fanout: { mode: "per-angle", groups: [{ name: "docs-surface", angles: ["docs", "link-check"] }] } },
  };
  const result = resolveFanoutGroups(config, "draft", ["docs", "link-check"]);
  assert.deepEqual(result, [
    { name: "docs", angles: ["docs"] },
    { name: "link-check", angles: ["link-check"] },
  ]);
});

test("resolveFanoutGroups: gate:full no longer restores per-angle — dispatches grouped (ADR 0047 superseded by 0048, #1601)", () => {
  const config = fanoutConfig([{ name: "docs-surface", angles: ["docs", "link-check"] }]);
  const result = resolveFanoutGroups(config, "draft", ["docs", "link-check"], { fullLabel: true });
  // gate:full forces the full angle set UPSTREAM (resolveGateTier); dispatch
  // shape is GROUPED here — the configured group wins, no per-angle restoration.
  assert.deepEqual(result, [
    { name: "docs-surface", angles: ["docs", "link-check"] },
  ]);
});

test("resolveFanoutGroups: gate:full dispatches grouped with auto-chunked leftovers (#1601)", () => {
  // gate:full + no configured groups: the full angle set is auto-chunked into
  // units of ≤ maxAnglesPerGroup (default 3) — NOT per-angle singletons.
  const result = resolveFanoutGroups({ version: 1 }, "draft", ["a", "b", "c", "d"], { fullLabel: true });
  assert.deepEqual(result, [
    { name: "group:a+b+c", angles: ["a", "b", "c"] },
    { name: "d", angles: ["d"] },
  ]);
});

test("resolveFanoutGroups: absent gates.fanout config auto-chunks ungrouped angles into ≤maxAnglesPerGroup units (default 3, #1601)", () => {
  const result = resolveFanoutGroups({ version: 1 }, "draft", ["scope", "docs"]);
  // No configured groups → both angles are leftovers, chunked into one unit of 2 (≤3).
  assert.deepEqual(result, [
    { name: "group:scope+docs", angles: ["scope", "docs"] },
  ]);
});

test("resolveFanoutGroups: duplicate resolvedAngles entries dedupe before auto-chunking (#1601)", () => {
  const result = resolveFanoutGroups({ version: 1 }, "draft", ["docs", "docs", "scope"]);
  // dedupe → ["docs", "scope"], then auto-chunked into one unit (≤3).
  assert.deepEqual(result, [
    { name: "group:docs+scope", angles: ["docs", "scope"] },
  ]);
});

test("resolveFanoutGroups: maxAnglesPerGroup chunks leftovers into units of ≤N (#1601 determinism)", () => {
  const config = { version: 1, gates: { fanout: { maxAnglesPerGroup: 2 } } };
  // 5 leftover angles, N=2 → 3 units [a,b],[c,d],[e]. Deterministic order, stable names.
  assert.deepEqual(resolveFanoutGroups(config, "draft", ["a", "b", "c", "d", "e"]), [
    { name: "group:a+b", angles: ["a", "b"] },
    { name: "group:c+d", angles: ["c", "d"] },
    { name: "e", angles: ["e"] },
  ]);
});

test("resolveFanoutGroups: maxAnglesPerGroup: 1 and mode: per-angle both yield singletons with NO configured groups (#1601)", () => {
  // With no configured groups, both produce one singleton unit per angle.
  const n1 = resolveFanoutGroups({ version: 1, gates: { fanout: { maxAnglesPerGroup: 1 } } }, "draft", ["scope", "docs"]);
  const pa = resolveFanoutGroups({ version: 1, gates: { fanout: { mode: "per-angle" } } }, "draft", ["scope", "docs"]);
  assert.deepEqual(n1, [
    { name: "scope", angles: ["scope"] },
    { name: "docs", angles: ["docs"] },
  ]);
  assert.deepEqual(pa, [
    { name: "scope", angles: ["scope"] },
    { name: "docs", angles: ["docs"] },
  ]);
});

test("resolveFanoutGroups: per-angle and maxAnglesPerGroup: 1 DIVERGE when a configured multi-angle group matches (#1601 — not exact equivalents)", () => {
  // per-angle bypasses configured groups (pure singletons); N=1 honors configured
  // groups (matched first, never split) then singletons the leftovers. They are
  // NOT equivalent when a configured multi-angle group matches a resolved angle.
  const groups = [{ name: "docs-surface", angles: ["docs", "link-check"] }];
  const pa = resolveFanoutGroups({ version: 1, gates: { fanout: { mode: "per-angle", groups } } }, "draft", ["docs", "link-check", "scope"]);
  const n1 = resolveFanoutGroups({ version: 1, gates: { fanout: { maxAnglesPerGroup: 1, groups } } }, "draft", ["docs", "link-check", "scope"]);
  // per-angle: 3 singletons (configured group bypassed).
  assert.deepEqual(pa.map((g) => g.angles.length), [1, 1, 1]);
  // N=1: configured group intact (2 angles, 1 unit) + leftover singleton.
  assert.deepEqual(n1, [
    { name: "docs-surface", angles: ["docs", "link-check"] },
    { name: "scope", angles: ["scope"] },
  ]);
});

test("resolveFanoutGroups: configured groups matched first, never split by maxAnglesPerGroup (#1601)", () => {
  // A configured group of 4 angles stays ONE unit even when N=2 (the knob only
  // chunks the leftover ungrouped pool).
  const config = { version: 1, gates: { fanout: { maxAnglesPerGroup: 2, groups: [{ name: "big", angles: ["a", "b", "c", "d"] }] } } };
  const result = resolveFanoutGroups(config, "draft", ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(result, [
    { name: "big", angles: ["a", "b", "c", "d"] },
    { name: "group:e+f", angles: ["e", "f"] },
  ]);
});

test("resolveFanoutGroups: single leftover angle keeps the pre-#1601 singleton name (collision → angle:<name>)", () => {
  const config = fanoutConfig([{ name: "docs", angles: ["link-check"] }]);
  // "docs" is a leftover colliding with the emitted group name "docs".
  const result = resolveFanoutGroups(config, "draft", ["link-check", "docs"]);
  assert.deepEqual(result, [
    { name: "docs", angles: ["link-check"] },
    { name: "angle:docs", angles: ["docs"] },
  ]);
  assert.equal(new Set(result.map((g) => g.name)).size, result.length);
});

test("resolveFanoutGroups: an angle named in two configured groups is claimed by the first (first-group-wins dedup)", () => {
  const config = fanoutConfig([
    { name: "g1", angles: ["docs", "a"] },
    { name: "g2", angles: ["docs", "b"] },
  ]);
  const result = resolveFanoutGroups(config, "draft", ["docs", "a", "b"]);
  assert.deepEqual(result, [
    { name: "g1", angles: ["docs", "a"] },
    { name: "g2", angles: ["b"] },
  ]);
});

test("resolveFanoutGroups: non-array/undefined resolvedAngles resolves to []", () => {
  assert.deepEqual(resolveFanoutGroups({ version: 1 }, "draft", undefined), []);
  assert.deepEqual(resolveFanoutGroups({ version: 1 }, "draft", "not-an-array"), []);
  assert.deepEqual(resolveFanoutGroups({ version: 1 }, "draft", null), []);
});

test("resolveFanoutGroups: empty resolvedAngles resolves to []", () => {
  const config = fanoutConfig([{ name: "docs-surface", angles: ["docs"] }]);
  assert.deepEqual(resolveFanoutGroups(config, "draft", []), []);
});

test("resolveFanoutGroups is defensive against a malformed gates.fanout.groups entry (never zod-validated — a hand-built config, or the raw merged object loadDevLoopConfig returns on ANY validation failure)", () => {
  const angles = ["docs", "scope"];
  // A null entry (e.g. an empty YAML list item) is skipped; "scope" is the sole leftover → singleton.
  assert.deepEqual(
    resolveFanoutGroups({ gates: { fanout: { groups: [{ name: "g", angles: ["docs"] }, null] } } }, "draft", angles),
    [{ name: "g", angles: ["docs"] }, { name: "scope", angles: ["scope"] }],
  );
  // A scalar `angles` (YAML string instead of a list) is treated as empty, dropping the group;
  // both angles fall through to the leftover auto-chunk pool (≤3 → one unit).
  assert.deepEqual(
    resolveFanoutGroups({ gates: { fanout: { groups: [{ name: "g", angles: "docs" }] } } }, "draft", angles),
    [{ name: "group:docs+scope", angles: ["docs", "scope"] }],
  );
  // A missing/blank `name` drops the group; its angles fall through to the auto-chunk pool.
  assert.deepEqual(
    resolveFanoutGroups({ gates: { fanout: { groups: [{ angles: ["docs"] }] } } }, "draft", angles),
    [{ name: "group:docs+scope", angles: ["docs", "scope"] }],
  );
  assert.deepEqual(
    resolveFanoutGroups({ gates: { fanout: { groups: [{ name: "  ", angles: ["docs"] }] } } }, "draft", angles),
    [{ name: "group:docs+scope", angles: ["docs", "scope"] }],
  );
  // A non-array `groups` resolves as if no groups were configured.
  assert.deepEqual(
    resolveFanoutGroups({ gates: { fanout: { groups: "not-an-array" } } }, "draft", angles),
    [{ name: "group:docs+scope", angles: ["docs", "scope"] }],
  );
  // Two groups sharing a name: the second is dropped, "scope" is the sole leftover → singleton.
  assert.deepEqual(
    resolveFanoutGroups({ gates: { fanout: { groups: [{ name: "g", angles: ["docs"] }, { name: "g", angles: ["scope"] }] } } }, "draft", angles),
    [{ name: "g", angles: ["docs"] }, { name: "scope", angles: ["scope"] }],
  );
});

test("resolveMaxAnglesPerGroup / resolveFanoutMaxConcurrent: defaults + config override + defensive fallback (#1601)", () => {
  assert.equal(resolveMaxAnglesPerGroup({ version: 1 }), 3);
  assert.equal(resolveFanoutMaxConcurrent({ version: 1 }), 4);
  assert.equal(resolveMaxAnglesPerGroup({ gates: { fanout: { maxAnglesPerGroup: 5 } } }), 5);
  assert.equal(resolveFanoutMaxConcurrent({ gates: { fanout: { maxConcurrent: 2 } } }), 2);
  // Defensive: non-integer / sub-1 fall back to defaults.
  assert.equal(resolveMaxAnglesPerGroup({ gates: { fanout: { maxAnglesPerGroup: 0 } } }), 3);
  assert.equal(resolveMaxAnglesPerGroup({ gates: { fanout: { maxAnglesPerGroup: 1.5 } } }), 3);
  assert.equal(resolveFanoutMaxConcurrent({ gates: { fanout: { maxConcurrent: 0 } } }), 4);
  assert.equal(resolveFanoutMaxConcurrent({ gates: { fanout: { maxConcurrent: "4" } } }), 4);
});

test("resolveFanoutSequential / resolveFanoutEffectiveConcurrency: serial bound (#1726) with a cross-harness-safe default", () => {
  // Shipped default is false → other harnesses/repos keep maxConcurrent behavior (no regression).
  assert.equal(resolveFanoutSequential({ version: 1 }), false);
  assert.equal(DEFAULT_FANOUT_SEQUENTIAL, false);
  assert.equal(resolveFanoutEffectiveConcurrency({ version: 1 }), 4);
  // Effective concurrency follows maxConcurrent when not sequential.
  assert.equal(resolveFanoutEffectiveConcurrency({ gates: { fanout: { maxConcurrent: 2 } } }), 2);
  assert.equal(resolveFanoutEffectiveConcurrency({ gates: { fanout: { sequential: false, maxConcurrent: 3 } } }), 3);
  // sequential forces one unit per wave regardless of maxConcurrent.
  assert.equal(resolveFanoutSequential({ gates: { fanout: { sequential: true } } }), true);
  assert.equal(resolveFanoutEffectiveConcurrency({ gates: { fanout: { sequential: true } } }), 1);
  assert.equal(resolveFanoutEffectiveConcurrency({ gates: { fanout: { sequential: true, maxConcurrent: 8 } } }), 1);
  // A non-boolean truthy value is NOT honored (strict === true).
  assert.equal(resolveFanoutSequential({ gates: { fanout: { sequential: "yes" } } }), false);
});

test("gates.fanout.groups schema validation: duplicate group names are rejected", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-fanout-dup-"));
  try {
    await writeFile(
      path.join(tmpDir, ".devloops"),
      [
        "version: 1",
        "gates:",
        "  fanout:",
        "    groups:",
        "      - name: dup",
        "        angles: [a]",
        "      - name: dup",
        "        angles: [b]",
        "",
      ].join("\n"),
    );
    const { loadDevLoopConfig } = await import("../src/config/config.mjs");
    const { errors } = await loadDevLoopConfig({ repoRoot: tmpDir });
    assert.ok(errors.length > 0);
    assert.match(errors.map((e) => e.message).join("\n"), /duplicate gates\.fanout\.groups name/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// AC3 (#1572) — per-angle scoped briefings: gates.<gate>.angles[].scope +
// resolveGateAngleScope
// ============================================================================

test("GateAngleEntry schema accepts a valid scope value on an angle entry", () => {
  const result = DevLoopConfigSchema.safeParse({
    version: 1,
    gates: { draft: { angles: [{ name: "docs", scope: "docs-only" }] } },
  });
  assert.equal(result.success, true);
});

test("GateAngleEntry schema rejects an unknown scope value", () => {
  const result = DevLoopConfigSchema.safeParse({
    version: 1,
    gates: { draft: { angles: [{ name: "docs", scope: "everything" }] } },
  });
  assert.equal(result.success, false);
});

test("resolveGateAngleScope: a configured angle scope resolves verbatim", () => {
  const config = { gates: { draft: { angles: [{ name: "link-check", scope: "docs-only" }] } } };
  assert.equal(resolveGateAngleScope(config, "draft", "link-check"), "docs-only");
});

test("resolveGateAngleScope: an angle with no scope field defaults to full", () => {
  const config = { gates: { draft: { angles: [{ name: "scope" }] } } };
  assert.equal(resolveGateAngleScope(config, "draft", "scope"), "full");
});

test("resolveGateAngleScope: an angle absent from the gate's configured angles fails open to full", () => {
  const config = { gates: { draft: { angles: [{ name: "docs", scope: "docs-only" }] } } };
  assert.equal(resolveGateAngleScope(config, "draft", "unconfigured-angle"), "full");
});

test("resolveGateAngleScope: an unknown/malformed scope value is dropped at normalization and fails open to full (hand-built, never-zod-validated config)", () => {
  const config = { gates: { draft: { angles: [{ name: "docs", scope: "everything" }] } } };
  assert.equal(resolveGateAngleScope(config, "draft", "docs"), "full");
});

test("resolveGateAngleScope: a disabled entry's scope is never returned (mirrors findAngleEntry's enabled:false exclusion)", () => {
  const config = { gates: { draft: { angles: [{ name: "docs", scope: "docs-only", enabled: false }] } } };
  assert.equal(resolveGateAngleScope(config, "draft", "docs"), "full");
});

test("resolveGateAngleScope: scope is looked up on the NAMED gate only, unlike findAngleEntry's cross-gate search", () => {
  const config = {
    gates: {
      draft: { angles: [{ name: "docs" }] },
      preApproval: { angles: [{ name: "docs", scope: "docs-only" }] },
    },
  };
  assert.equal(resolveGateAngleScope(config, "draft", "docs"), "full");
  assert.equal(resolveGateAngleScope(config, "preApproval", "docs"), "docs-only");
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
        draft: { angles: ["scope", "coverage", "docs", "deep", "kiss"], dynamic: { subtractive: true } },
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

  test("respects a disabled angle during dynamic resolution", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "docs", { name: "kiss", enabled: false }],
          dynamic: { subtractive: true },
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
          dynamic: { subtractive: true },
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
          angles: [
            "scope",
            "coverage",
            { name: "pr-description", mandatory: true },
            { name: "correctness", mandatory: true },
            { name: "gate-evidence", mandatory: true },
          ],
          dynamic: { subtractive: true },
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
          angles: ["scope", { name: "pr-description", mandatory: true }],
          dynamic: { subtractive: true },
        },
      },
    };
    // no diff → dynamicAnglesActive is false, but mandatoryAngles still in result via resolveGateAngles
    const result = await resolveGateAnglesDynamic(config, "draft");
    assert.equal(result.dynamicAnglesActive, false);
    assert.deepEqual(result.recommendedAngles, ["pr-description", "scope"]);
  });

  test("a plain (non-mandatory) angle appended to angles is present when dynamicAngles is off", async () => {
    // Pre-D3 this required a separate extraAngles list (#1392); D3's
    // merge-by-name lets a config layer add a plain angle to `angles`
    // directly, so a bare additional entry now covers the same case.
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "custom-lens"],
          dynamic: { subtractive: false },
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft");
    assert.equal(result.dynamicAnglesActive, false);
    assert.deepEqual(result.recommendedAngles, ["scope", "custom-lens"]);
  });

  test("a plain (non-mandatory) angle is prunable when dynamicAngles is on — matches other configured angles", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "custom-lens"],
          dynamic: { subtractive: true },
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: {
        nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
      },
    });
    assert.equal(result.dynamicAnglesActive, true);
    // custom-lens is a candidate (like configured angles), not a mandatory
    // floor: an unrecognized custom angle is pruned by the docs-only diff,
    // same as "scope" would be if it weren't relevant.
    assert.ok(result.skippedAngles.includes("custom-lens"));
    assert.ok(!result.recommendedAngles.includes("custom-lens"));
  });

  test("backward compat: no mandatoryAngles = all angles are candidates", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage", "docs"],
          dynamic: { subtractive: true },
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
          angles: ["scope", { name: "pr-description", mandatory: true }, { name: "correctness", mandatory: true }],
          dynamic: { subtractive: true },
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
          angles: [
            "scope",
            { name: "pr-description", mandatory: true },
            { name: "correctness", mandatory: true, enabled: false },
          ],
          dynamic: { subtractive: true },
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

  // --------------------------------------------------------------------
  // Additive angle selection (#1048) — off by default
  // --------------------------------------------------------------------

  test("additiveAngles: false (default) is a byte-identical no-op vs. today's subtractive-only path", async () => {
    const baseGates = {
      draft: {
        angles: ["scope", "coverage", "docs"],
        dynamic: { subtractive: true },
      },
    };
    const diff = { diff: { nameStatusOutput: "A\t.github/workflows/ci.yml" } };

    const withoutAdditive = await resolveGateAnglesDynamic({ version: 1, gates: baseGates }, "draft", diff);
    const withAdditiveUnset = await resolveGateAnglesDynamic(
      { version: 1, gates: { draft: { ...baseGates.draft, dynamic: { subtractive: true, additive: false } } } },
      "draft",
      diff,
    );
    assert.deepEqual(withAdditiveUnset.recommendedAngles, withoutAdditive.recommendedAngles);
    assert.deepEqual(withoutAdditive.addedAngles, []);
    assert.deepEqual(withoutAdditive.addedReasons, {});
    // recommendedAngles stays a subset of mandatoryAngles ∪ configured angles
    const allowed = new Set(["scope", "coverage", "docs"]);
    for (const a of withoutAdditive.recommendedAngles) {
      assert.ok(allowed.has(a), `${a} should be a subset of configured angles when additive is off`);
    }
  });

  test("additiveAngles: true adds a catalog angle recommended by change category but not in the configured pool", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage", "docs"], // ci-guard deliberately omitted
          dynamic: { subtractive: true, additive: true },
        },
        anglePool: ["scope", "coverage", "docs", "ci-guard", "config-drift"],
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "A\t.github/workflows/ci.yml" },
    });
    assert.ok(result.addedAngles.includes("ci-guard"));
    assert.ok(result.recommendedAngles.includes("ci-guard"));
    assert.ok(!config.gates.draft.angles.includes("ci-guard")); // sanity: not in original pool
    assert.equal(result.addedReasons["ci-guard"], "Added: triggered by change category CI_ONLY");
  });

  test("additiveAngles: true, but excludeAngles ceiling still wins over addition", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          // A phantom disabled entry (not otherwise configured) still acts as
          // a hard exclusion ceiling for additive selection.
          angles: ["scope", "coverage", "docs", { name: "ci-guard", enabled: false }],
          dynamic: { subtractive: true, additive: true },
        },
        anglePool: ["scope", "coverage", "docs", "ci-guard", "config-drift"],
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "A\t.github/workflows/ci.yml" },
    });
    assert.ok(!result.addedAngles.includes("ci-guard"));
    assert.ok(!result.recommendedAngles.includes("ci-guard"));
  });

  test("additiveAngles: true still keeps mandatoryAngles floor intact", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: [
            "scope",
            "coverage",
            { name: "pr-description", mandatory: true },
            { name: "correctness", mandatory: true },
            { name: "gate-evidence", mandatory: true },
          ],
          dynamic: { subtractive: true, additive: true },
        },
        anglePool: ["scope", "coverage", "ci-guard"],
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "A\t.github/workflows/ci.yml" },
    });
    assert.ok(result.recommendedAngles.includes("pr-description"));
    assert.ok(result.recommendedAngles.includes("correctness"));
    assert.ok(result.recommendedAngles.includes("gate-evidence"));
  });

  test("additiveAngles: true excludes a mandatory angle from addedAngles/addedReasons even when it also appears in anglePool", async () => {
    // Regression (#1136 gate-review): renderer-security is both mandatory AND
    // in the always-include catalog set, so the additive resolver would
    // otherwise recommend it as "added" — corrupting the audit rationale for
    // an angle that actually runs unconditionally as the mandatory floor.
    const config = {
      version: 1,
      gates: {
        anglePool: ["scope", "correctness", "contract-surface", "docs", "renderer-security"],
        preApproval: {
          angles: ["scope", { name: "renderer-security", mandatory: true }],
          dynamic: { subtractive: true, additive: true },
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "preApproval", {
      diff: { nameStatusOutput: "M\tsrc/main.mjs" },
    });
    assert.ok(result.recommendedAngles.includes("renderer-security")); // mandatory floor still works
    assert.ok(!result.addedAngles.includes("renderer-security")); // not misattributed as "added"
    assert.equal(result.addedReasons["renderer-security"], undefined); // no fabricated rationale
  });

  test("additiveAngles: true with no gates.anglePool falls back to the built-in persona registry catalog", async () => {
    // contract-surface is a LOGIC_CHANGE core-subset angle AND a built-in persona
    // (see BUILTIN_PERSONAS), so it's a valid fallback-catalog addition target.
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage"], // contract-surface omitted; no explicit anglePool
          dynamic: { subtractive: true, additive: true },
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tsrc/main.mjs" },
    });
    assert.ok(result.addedAngles.includes("contract-surface"));
    assert.ok(result.recommendedAngles.includes("contract-surface"));
  });

  test("resolveAnglePool: with no explicit gates.anglePool, includes angles configured on gates.draft that are absent from BUILTIN_PERSONAS", () => {
    // ci-guard has no entry in BUILTIN_PERSONAS (it resolves via the
    // default-reviewer persona fallback at dispatch time), but it is a real,
    // configured angle in this repo's own extension-defaults.yaml draft gate —
    // the fallback catalog must include it, not just the persona registry.
    const config = { version: 1, gates: { draft: { angles: ["scope", "ci-guard"] } } };
    assert.ok(resolveAnglePool(config).includes("ci-guard"));
  });

  test("resolveAnglePool: with no explicit gates.anglePool, still includes BUILTIN_PERSONAS-only angles not configured on any gate", () => {
    // renderer-security is in BUILTIN_PERSONAS but not referenced by any gate
    // in this config — the persona-registry half of the union must still hold.
    const config = { version: 1, gates: { draft: { angles: ["scope"] } } };
    assert.ok(resolveAnglePool(config).includes("renderer-security"));
  });

  test("resolveAnglePool: explicit gates.anglePool override is unaffected by the broadened fallback", () => {
    const config = {
      version: 1,
      gates: {
        anglePool: [" scope ", "coverage", "scope"],
        draft: { angles: ["ci-guard"] },
      },
    };
    // Deduped/trimmed explicit list only — no ci-guard leaking in from draft.angles.
    assert.deepEqual(resolveAnglePool(config), ["scope", "coverage"]);
  });

  test("additiveAngles: true with no gates.anglePool can additively select an angle configured elsewhere in this config's gates but absent from BUILTIN_PERSONAS", async () => {
    // ci-guard is a real draft-gate angle in this repo's extension-defaults.yaml
    // but has no BUILTIN_PERSONAS entry, so the old BUILTIN_PERSONAS-only
    // fallback could never additively select it. Here the gate under test
    // (draft) has a hypothetical narrower angle list that omits ci-guard, but
    // ci-guard is configured on another gate (preApproval) in the same config —
    // the broadened fallback catalog unions across all of this config's own
    // gates, so it should still be additively reachable for draft.
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage", "docs"], // ci-guard deliberately omitted here
          dynamic: { subtractive: true, additive: true },
        },
        preApproval: { angles: ["ci-guard", "link-check"] },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "A\t.github/workflows/ci.yml" },
    });
    assert.ok(result.addedAngles.includes("ci-guard"));
    assert.ok(result.recommendedAngles.includes("ci-guard"));
  });

  test("resolveGateConfig: additiveAngles defaults to false when unset (this repo's own gates are unaffected)", () => {
    const config = { version: 1, gates: { draft: { angles: ["scope"], dynamic: { subtractive: true } } } };
    assert.equal(resolveGateConfig(config, "draft").additiveAngles, false);
  });

  // ── Diff-class angle tiers (issue #1550): resolveGateTier consult at the top
  // of resolveGateAnglesDynamic ──────────────────────────────────────────────

  // Docs-only diff fixture: two markdown files, one changed line each (2 added
  // + 2 deleted = 4 lines total via analyzeT1's real hunk-level count — NOT
  // the fake-zero lineStats analyzeDiff's inferred-category path reports for
  // an unambiguous diff).
  const docsOnlyDiff = {
    nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md",
    diffOutput: [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "@@ -1,1 +1,1 @@",
      "-old guide line",
      "+new guide line",
      "diff --git a/README.md b/README.md",
      "@@ -1,1 +1,1 @@",
      "-old readme line",
      "+new readme line",
    ].join("\n"),
  };

  function draftConfigWithTiers(tiers) {
    return {
      version: 1,
      gates: {
        draft: {
          angles: ["docs", "link-check", "correctness", { name: "pr-description", mandatory: true }],
          // Pin dynamic OFF so these tier-isolation tests are unaffected by the
          // #1579 default flip (they assert static-pool behavior, not dynamic).
          dynamic: { subtractive: false },
          ...(tiers ? { tiers } : {}),
        },
      },
    };
  }

  test("tiers: a docs-only diff matching a configured tier returns the tier's angle set with a tier:<name> rationale", async () => {
    const config = draftConfigWithTiers([
      { name: "docs-only", match: { kinds: ["docs"], maxLines: 300 }, angles: ["docs", "link-check"] },
    ]);
    const result = await resolveGateAnglesDynamic(config, "draft", { diff: docsOnlyDiff });
    assert.equal(result.dynamicAnglesActive, true);
    assert.deepEqual(result.recommendedAngles, ["pr-description", "docs", "link-check"]);
    assert.deepEqual(result.skippedAngles, ["correctness"]);
    assert.deepEqual(result.reasons, { correctness: "tier:docs-only" });
    assert.equal(result.fallbackToAll, false);
    assert.deepEqual(result.addedAngles, []);
    assert.deepEqual(result.addedReasons, {});
  });

  test("tiers: the same diff WITHOUT a configured tier resolves byte-identically to today's static-angle behavior (regression)", async () => {
    const config = draftConfigWithTiers(null);
    const result = await resolveGateAnglesDynamic(config, "draft", { diff: docsOnlyDiff });
    assert.deepEqual(result, {
      recommendedAngles: ["pr-description", "docs", "link-check", "correctness"],
      skippedAngles: [],
      reasons: {},
      fallbackToAll: false,
      dynamicAnglesActive: false,
      addedAngles: [],
      addedReasons: {},
    });
  });

  test("tiers: hasFullLabel true skips tier resolution even when a tier would otherwise match", async () => {
    const config = draftConfigWithTiers([
      { name: "docs-only", match: { kinds: ["docs"], maxLines: 300 }, angles: ["docs", "link-check"] },
    ]);
    const result = await resolveGateAnglesDynamic(config, "draft", { diff: docsOnlyDiff, hasFullLabel: true });
    assert.equal(result.dynamicAnglesActive, false);
    assert.deepEqual(result.recommendedAngles, ["pr-description", "docs", "link-check", "correctness"]);
  });


  // ── #1579: grouped dynamic angles are the default ──────────────────────────

  test("#1579 dynamic subtractive is ON by default (no dynamic key) — a diff narrows the pool", async () => {
    const config = {
      version: 1,
      gates: { draft: { angles: ["scope", "coverage", "docs", "deep", "kiss"] } },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md" },
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.ok(result.recommendedAngles.includes("docs"), "docs lens kept for a docs-only diff");
    assert.ok(result.recommendedAngles.length < 5, "pool narrowed from the full 5");
    assert.ok(result.skippedAngles.includes("coverage"), "non-docs angle pruned by default");
    assert.equal(result.fallbackToAll, false);
  });

  test("#1579 mandatory angle survives dynamic pruning under the default config (no dynamic key)", async () => {
    // coverage is NOT recommended for a docs-only diff, so the classifier
    // WOULD prune it — mandatory:true must keep it on the always-run floor.
    const config = {
      version: 1,
      gates: {
        draft: { angles: ["docs", { name: "coverage", mandatory: true }, "kiss"] },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md" },
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.ok(result.recommendedAngles.includes("coverage"), "mandatory angle survives pruning");
    assert.ok(!result.skippedAngles.includes("coverage"), "mandatory angle never skipped");
    // kiss is non-mandatory and not docs-relevant → pruned (proves the floor
    // is selective, not a blanket keep-all).
    assert.ok(result.skippedAngles.includes("kiss"));
  });

  test("#1579 opt-out: dynamic.subtractive:false restores the full static pool even with a diff", async () => {
    const config = {
      version: 1,
      gates: {
        draft: {
          angles: ["scope", "coverage", "docs", "deep", "kiss"],
          dynamic: { subtractive: false },
        },
      },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md" },
    });
    assert.equal(result.dynamicAnglesActive, false);
    assert.deepEqual(result.recommendedAngles, ["scope", "coverage", "docs", "deep", "kiss"]);
    assert.deepEqual(result.skippedAngles, []);
  });

  test("#1579 default config + no diff falls back to the full static pool (graceful degradation)", async () => {
    // No explicit dynamic key (default ON), but no diff available — the
    // resolver must not prune and must return the full configured pool.
    const config = {
      version: 1,
      gates: { draft: { angles: ["scope", "coverage", "docs", "deep", "kiss"] } },
    };
    const result = await resolveGateAnglesDynamic(config, "draft");
    assert.equal(result.dynamicAnglesActive, false);
    assert.deepEqual(result.recommendedAngles, ["scope", "coverage", "docs", "deep", "kiss"]);
    assert.deepEqual(result.skippedAngles, []);
    assert.equal(result.fallbackToAll, false);
  });

  test("#1579 gate:full label alone does NOT restore the full pool (only per-angle dispatch of the pruned set)", async () => {
    // gate:full bypasses TIER resolution but NOT dynamic pruning: under the
    // default subtractive:true + a diff, hasFullLabel still yields a pruned set
    // (dispatched per-angle via resolveFanoutGroups), not the full static pool.
    const config = {
      version: 1,
      gates: { draft: { angles: ["scope", "coverage", "docs", "deep", "kiss"] } },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md" },
      hasFullLabel: true,
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.ok(result.recommendedAngles.includes("docs"), "docs lens kept for a docs-only diff");
    assert.ok(result.recommendedAngles.length < 5, "pool still pruned — gate:full does not restore the full pool");
    assert.ok(result.skippedAngles.length > 0, "non-docs angles still pruned under gate:full");
    assert.equal(result.fallbackToAll, false);
  });

  test("#1579 default config + ambiguous diff → fallbackToAll restores the full pool (graceful degradation)", async () => {
    // The CHANGELOG pins this as the graceful-degradation route for the new
    // default: an unclassifiable (ambiguous) diff falls back to the full static
    // pool with fallbackToAll:true, dynamicAnglesActive:true.
    const config = {
      version: 1,
      gates: { draft: { angles: ["scope", "coverage", "docs", "deep", "kiss"] } },
    };
    const result = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tsrc/foo.mjs\nM\tdocs/bar.md" },
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.equal(result.fallbackToAll, true);
    assert.deepEqual(result.recommendedAngles, ["scope", "coverage", "docs", "deep", "kiss"]);
    assert.deepEqual(result.skippedAngles, []);
  });
});
describe("resolveGateTier (issue #1550 — diff-class angle tiers)", () => {
  function draftConfigWithTiers(tiers) {
    return {
      version: 1,
      gates: {
        draft: {
          angles: ["docs", "link-check", "correctness", "gate-evidence", { name: "pr-description", mandatory: true }],
          tiers,
        },
      },
    };
  }

  test("gate:full label bypasses tier resolution → gate_full_label", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", {
      changedFiles: ["docs/guide.md"],
      filesChanged: 1,
      linesChanged: 10,
      hasFullLabel: true,
    });
    assert.deepEqual(result, { tier: null, angles: null, reason: "gate_full_label" });
  });

  test("no tiers configured → no_tiers_configured", () => {
    const config = { version: 1, gates: { draft: { angles: ["docs"] } } };
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/guide.md"], filesChanged: 1, linesChanged: 5 });
    assert.deepEqual(result, { tier: null, angles: null, reason: "no_tiers_configured" });
  });

  test("an explicitly-empty tiers array also resolves to no_tiers_configured", () => {
    const config = draftConfigWithTiers([]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/guide.md"], filesChanged: 1, linesChanged: 5 });
    assert.equal(result.reason, "no_tiers_configured");
  });

  test("scope_unavailable: changedFiles omitted", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { filesChanged: 1, linesChanged: 5 });
    assert.equal(result.reason, "scope_unavailable");
  });

  test("scope_unavailable: changedFiles is an empty array", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: [], filesChanged: 0, linesChanged: 0 });
    assert.equal(result.reason, "scope_unavailable");
  });

  test("scope_unavailable: changedFiles is not an array", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: "docs/guide.md", filesChanged: 1, linesChanged: 5 });
    assert.equal(result.reason, "scope_unavailable");
  });

  test("scope_unavailable: filesChanged is non-finite", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/guide.md"], filesChanged: Infinity, linesChanged: 5 });
    assert.equal(result.reason, "scope_unavailable");
  });

  test("scope_unavailable: linesChanged is non-finite", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/guide.md"], filesChanged: 1, linesChanged: NaN });
    assert.equal(result.reason, "scope_unavailable");
  });

  test("config_source_delta: a changed .devloops path fails closed even when a tier would otherwise match", () => {
    const config = draftConfigWithTiers([{ name: "small", match: { kinds: ["docs", "config"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: [".devloops"], filesChanged: 1, linesChanged: 5 });
    assert.equal(result.reason, "config_source_delta");
  });

  test("config_source_delta: the shipped defaults file (the layer that ships the angle pool) fails closed too", () => {
    const config = draftConfigWithTiers([{ name: "small", match: { kinds: ["docs", "config"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", {
      changedFiles: ["packages/core/src/config/extension-defaults.yaml"],
      filesChanged: 1,
      linesChanged: 5,
    });
    assert.equal(result.reason, "config_source_delta");
  });

  test("unclassifiable_file: an unknown-kind changed file fails closed", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["assets/logo.png"], filesChanged: 1, linesChanged: 5 });
    assert.equal(result.reason, "unclassifiable_file");
  });

  test("kinds-only match: every changed file's classifyFile kind must be in the tier's kinds set", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs", "link-check"] }]);
    const matched = resolveGateTier(config, "draft", {
      changedFiles: ["docs/guide.md", "README.md"],
      filesChanged: 2,
      linesChanged: 5000,
    });
    assert.equal(matched.tier, "docs-only");
    assert.equal(matched.reason, "tier_match");
    assert.deepEqual(matched.angles, ["pr-description", "docs", "link-check"]);

    const mixed = resolveGateTier(config, "draft", {
      changedFiles: ["docs/guide.md", "src/main.mjs"],
      filesChanged: 2,
      linesChanged: 5,
    });
    assert.equal(mixed.reason, "no_tier_match");
  });

  test("maxLines-only match: line-count bound applies regardless of kind or file count", () => {
    const config = draftConfigWithTiers([{ name: "small", match: { maxLines: 50 }, angles: ["correctness"] }]);
    const atBound = resolveGateTier(config, "draft", { changedFiles: ["src/a.mjs"], filesChanged: 1, linesChanged: 50 });
    assert.equal(atBound.reason, "tier_match");
    const overBound = resolveGateTier(config, "draft", { changedFiles: ["src/a.mjs"], filesChanged: 1, linesChanged: 51 });
    assert.equal(overBound.reason, "no_tier_match");
  });

  test("combined kinds + maxFiles + maxLines match requires every configured condition", () => {
    const config = draftConfigWithTiers([
      { name: "small-non-code", match: { kinds: ["docs", "test"], maxFiles: 3, maxLines: 50 }, angles: ["correctness"] },
    ]);
    const underBound = resolveGateTier(config, "draft", {
      changedFiles: ["docs/a.md", "test/b.test.mjs"],
      filesChanged: 2,
      linesChanged: 40,
    });
    assert.equal(underBound.reason, "tier_match");
    const overLines = resolveGateTier(config, "draft", {
      changedFiles: ["docs/a.md", "test/b.test.mjs"],
      filesChanged: 2,
      linesChanged: 60,
    });
    assert.equal(overLines.reason, "no_tier_match");
  });

  test("first-match-wins: an earlier tier shadows a later one that would also match", () => {
    const config = draftConfigWithTiers([
      { name: "broad", match: { kinds: ["docs"] }, angles: ["docs"] },
      { name: "narrow", match: { kinds: ["docs"], maxLines: 10 }, angles: ["link-check"] },
    ]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/a.md"], filesChanged: 1, linesChanged: 5 });
    assert.equal(result.tier, "broad");
  });

  test("mandatory angles are always unioned into the matched tier's angle set", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["gate-evidence"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/a.md"], filesChanged: 1, linesChanged: 5 });
    assert.ok(result.angles.includes("pr-description"));
    assert.ok(result.angles.includes("gate-evidence"));
  });

  test("angle_outside_pool: a tier angle absent from the gate's angle pool voids the whole match (no partial intersection)", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs", "typo-angle"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["docs/a.md"], filesChanged: 1, linesChanged: 5 });
    assert.deepEqual(result, { tier: null, angles: null, reason: "angle_outside_pool" });
  });

  test("no_tier_match: no configured tier's conditions hold for this diff", () => {
    const config = draftConfigWithTiers([{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }]);
    const result = resolveGateTier(config, "draft", { changedFiles: ["src/a.mjs"], filesChanged: 1, linesChanged: 5 });
    assert.deepEqual(result, { tier: null, angles: null, reason: "no_tier_match" });
  });

  test("spike gate: a tier configured on gates.spike is accepted", () => {
    const config = {
      version: 1,
      gates: {
        spike: { angles: ["docs"], tiers: [{ name: "docs-only", match: { kinds: ["docs"] }, angles: ["docs"] }] },
      },
    };
    const result = resolveGateTier(config, "spike", { changedFiles: ["docs/a.md"], filesChanged: 1, linesChanged: 5 });
    assert.equal(result.tier, "docs-only");
    assert.equal(result.reason, "tier_match");
  });

  test("zod: an empty match ({}) is rejected at config-parse time", () => {
    const result = DevLoopConfigSchema.safeParse({
      version: 1,
      gates: { draft: { tiers: [{ name: "docs-only", match: {}, angles: ["docs"] }] } },
    });
    assert.equal(result.success, false);
  });

  test("zod: FileConfigSchema also rejects an empty match", () => {
    const result = FileConfigSchema.safeParse({
      version: 1,
      gates: { draft: { tiers: [{ name: "docs-only", match: {}, angles: ["docs"] }] } },
    });
    assert.equal(result.success, false);
  });
});

describe("gates.requireFanoutEvidence", () => {
  test("defaults to true (opt-out) and resolveRequireFanoutEvidence reflects it", () => {
    // Default-on: enforcement is ON unless explicitly disabled. The `!== false`
    // resolver semantics keep opt-out robust for programmatically-built config.
    assert.equal(resolveRequireFanoutEvidence({}), true);
    assert.equal(resolveRequireFanoutEvidence({ gates: {} }), true);
    assert.equal(resolveRequireFanoutEvidence({ gates: { requireFanoutEvidence: true } }), true);
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { draft: {} } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.requireFanoutEvidence, true);
    assert.equal(resolveRequireFanoutEvidence(parsed.data), true);
  });

  test("opt-out: explicit requireFanoutEvidence: false disables enforcement", () => {
    assert.equal(resolveRequireFanoutEvidence({ gates: { requireFanoutEvidence: false } }), false);
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { requireFanoutEvidence: false } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.requireFanoutEvidence, false);
    assert.equal(resolveRequireFanoutEvidence(parsed.data), false);
  });

  test("accepts requireFanoutEvidence: true in full and file schemas", () => {
    const full = DevLoopConfigSchema.safeParse({ version: 1, gates: { requireFanoutEvidence: true } });
    assert.equal(full.success, true);
    assert.equal(full.data.gates.requireFanoutEvidence, true);
    assert.equal(resolveRequireFanoutEvidence(full.data), true);

    const file = FileConfigSchema.safeParse({ version: 1, gates: { requireFanoutEvidence: true } });
    assert.equal(file.success, true);
    assert.equal(file.data.gates.requireFanoutEvidence, true);
  });

  test("rejects non-boolean requireFanoutEvidence", () => {
    const bad = DevLoopConfigSchema.safeParse({ version: 1, gates: { requireFanoutEvidence: "yes" } });
    assert.equal(bad.success, false);
  });
});

describe("gates.requireFanoutProvenance", () => {
  test("defaults to false (opt-in) and resolveRequireFanoutProvenance reflects it", () => {
    // Default-OFF: strict === true resolver, so absent/undefined config is false.
    assert.equal(resolveRequireFanoutProvenance({}), false);
    assert.equal(resolveRequireFanoutProvenance({ gates: {} }), false);
    assert.equal(resolveRequireFanoutProvenance({ gates: { requireFanoutProvenance: false } }), false);
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { draft: {} } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.requireFanoutProvenance, false);
    assert.equal(resolveRequireFanoutProvenance(parsed.data), false);
  });

  test("opt-in: explicit requireFanoutProvenance: true enables enforcement", () => {
    assert.equal(resolveRequireFanoutProvenance({ gates: { requireFanoutProvenance: true } }), true);
    const full = DevLoopConfigSchema.safeParse({ version: 1, gates: { requireFanoutProvenance: true } });
    assert.equal(full.success, true);
    assert.equal(full.data.gates.requireFanoutProvenance, true);
    assert.equal(resolveRequireFanoutProvenance(full.data), true);
    const file = FileConfigSchema.safeParse({ version: 1, gates: { requireFanoutProvenance: true } });
    assert.equal(file.success, true);
    assert.equal(file.data.gates.requireFanoutProvenance, true);
  });

  test("rejects non-boolean requireFanoutProvenance", () => {
    const bad = DevLoopConfigSchema.safeParse({ version: 1, gates: { requireFanoutProvenance: "yes" } });
    assert.equal(bad.success, false);
  });

  test("floor constant is 2 (smallest count that is not a single agent)", () => {
    assert.equal(FANOUT_PROVENANCE_MIN_REVIEWERS, 2);
  });
});

describe("gates.rejectForeignAngles (#1196)", () => {
  test("defaults to true (fail-closed) when absent", () => {
    assert.equal(resolveRejectForeignAngles({}), true);
    assert.equal(resolveRejectForeignAngles({ gates: {} }), true);
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { draft: {} } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.rejectForeignAngles, true);
    assert.equal(resolveRejectForeignAngles(parsed.data), true);
  });

  test("opt-out: explicit rejectForeignAngles: false switches to warn-only", () => {
    assert.equal(resolveRejectForeignAngles({ gates: { rejectForeignAngles: false } }), false);
    const full = DevLoopConfigSchema.safeParse({ version: 1, gates: { rejectForeignAngles: false } });
    assert.equal(full.success, true);
    assert.equal(resolveRejectForeignAngles(full.data), false);
  });

  test("rejects non-boolean rejectForeignAngles", () => {
    const bad = DevLoopConfigSchema.safeParse({ version: 1, gates: { rejectForeignAngles: "yes" } });
    assert.equal(bad.success, false);
  });
});

describe("resolveGateAngleContract (#1196 — shared angle enforcement contract)", () => {
  test("returns exclude-filtered mandatory angles + the resolveGateAngles pool by default", () => {
    const config = {
      gates: { preApproval: { angles: ["dry", "kiss", { name: "pr-checklist-matrix", mandatory: true }] } },
    };
    const { mandatoryAngles, pool } = resolveGateAngleContract(config, "preApproval");
    assert.deepEqual(mandatoryAngles, ["pr-checklist-matrix"]);
    assert.deepEqual(pool, ["pr-checklist-matrix", "dry", "kiss"]);
  });

  test("an excluded mandatory angle is dropped from BOTH sides (no missing-mandatory/foreign deadlock)", () => {
    const config = {
      gates: {
        preApproval: {
          angles: [
            "dry",
            "kiss",
            { name: "pr-checklist-matrix", mandatory: true },
            { name: "yagni", mandatory: true, enabled: false },
          ],
        },
      },
    };
    const { mandatoryAngles, pool } = resolveGateAngleContract(config, "preApproval");
    // yagni is neither required (missing-mandatory) nor allowed (foreign):
    // it simply leaves the contract, so a fanout write omitting it passes.
    assert.deepEqual(mandatoryAngles, ["pr-checklist-matrix"]);
    assert.ok(!pool.includes("yagni"));
  });

  test("additiveAngles widens the pool to the global lens catalog, excludeAngles still a hard ceiling", () => {
    const config = {
      gates: {
        anglePool: ["dry", "kiss", "catalog-extra", "catalog-blocked"],
        preApproval: {
          angles: ["dry", { name: "catalog-blocked", enabled: false }],
          dynamic: { additive: true },
        },
      },
    };
    const { pool } = resolveGateAngleContract(config, "preApproval");
    assert.ok(pool.includes("catalog-extra"), "additively-selectable catalog angle must be in the enforcement pool");
    assert.ok(!pool.includes("catalog-blocked"), "excludeAngles caps additive widening");
    // Without additiveAngles the catalog angle stays foreign.
    const strict = resolveGateAngleContract({
      gates: { anglePool: ["dry", "catalog-extra"], preApproval: { angles: ["dry"] } },
    }, "preApproval");
    assert.ok(!strict.pool.includes("catalog-extra"));
  });

  test("null pool passes through when the gate configures no angles at all", () => {
    const { mandatoryAngles, pool } = resolveGateAngleContract({ version: 1 }, "draft");
    assert.deepEqual(mandatoryAngles, []);
    assert.equal(pool, null);
  });
});

describe("gates.maxFanoutReviewers", () => {
  test("defaults to 8 when absent (parsed schema)", () => {
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { draft: {} } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.maxFanoutReviewers, 8);
  });

  test("honors a configured override in full and file schemas", () => {
    const full = DevLoopConfigSchema.safeParse({ version: 1, gates: { maxFanoutReviewers: 4 } });
    assert.equal(full.success, true);
    assert.equal(full.data.gates.maxFanoutReviewers, 4);

    const file = FileConfigSchema.safeParse({ version: 1, gates: { maxFanoutReviewers: 12 } });
    assert.equal(file.success, true);
    assert.equal(file.data.gates.maxFanoutReviewers, 12);
  });

  test("rejects non-positive / non-integer / out-of-range maxFanoutReviewers", () => {
    assert.equal(DevLoopConfigSchema.safeParse({ version: 1, gates: { maxFanoutReviewers: 0 } }).success, false);
    assert.equal(DevLoopConfigSchema.safeParse({ version: 1, gates: { maxFanoutReviewers: 2.5 } }).success, false);
    assert.equal(DevLoopConfigSchema.safeParse({ version: 1, gates: { maxFanoutReviewers: 65 } }).success, false);
  });
});

describe("removed localPlanning key (#1404 — 1.0 hard break)", () => {
  test("a config carrying a localPlanning block is now rejected as an unknown key", () => {
    const input = { version: 1, localPlanning: { plansDir: "docs/phases/" } };
    assert.equal(DevLoopConfigSchema.safeParse(input).success, false);
    assert.equal(FileConfigSchema.safeParse(input).success, false);
  });
});

describe("gates.postFindingsComments", () => {
  test("defaults to false (opt-in) and resolveGatePostFindingsComments reflects it", () => {
    // Default-off: the comment renders findings the round's verdict review
    // already carries. The `=== true` resolver semantics keep the opt-in robust
    // for programmatically-built config that bypasses schema defaulting.
    assert.equal(resolveGatePostFindingsComments({}), false);
    assert.equal(resolveGatePostFindingsComments({ gates: {} }), false);
    assert.equal(resolveGatePostFindingsComments({ gates: { postFindingsComments: false } }), false);
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { draft: {} } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.postFindingsComments, false);
    assert.equal(resolveGatePostFindingsComments(parsed.data), false);
  });

  test("opt-in: explicit postFindingsComments: true posts the second surface", () => {
    assert.equal(resolveGatePostFindingsComments({ gates: { postFindingsComments: true } }), true);
    const parsed = DevLoopConfigSchema.safeParse({ version: 1, gates: { postFindingsComments: true } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.gates.postFindingsComments, true);
    assert.equal(resolveGatePostFindingsComments(parsed.data), true);
  });

  test("accepts postFindingsComments in full and file schemas", () => {
    const full = DevLoopConfigSchema.safeParse({ version: 1, gates: { postFindingsComments: true } });
    assert.equal(full.success, true);
    assert.equal(full.data.gates.postFindingsComments, true);

    const file = FileConfigSchema.safeParse({ version: 1, gates: { postFindingsComments: false } });
    assert.equal(file.success, true);
    assert.equal(file.data.gates.postFindingsComments, false);
  });

  test("rejects non-boolean postFindingsComments", () => {
    const bad = DevLoopConfigSchema.safeParse({ version: 1, gates: { postFindingsComments: "yes" } });
    assert.equal(bad.success, false);
  });
});

// ============================================================================
// Model-tier resolution — resolveRoleModel (both harnesses)
// ============================================================================

describe("resolveRoleModel — built-in policy, both harnesses", () => {
  // Zero-config resolution table: 7 roles + a critical angle, on claude and pi.
  const cases = [
    // [role, claude, pi]
    ["developer", "sonnet", null],
    ["docs", "sonnet", null],
    ["fixer", "sonnet", null],
    ["quality", "sonnet", null],
    ["refiner", "opus", null],
    ["review", "opus", null],
    ["dev-loop", null, null], // inherit
    // A critical gate angle resolves high via its `review` persona.
    ["correctness", "opus", null],
    ["renderer-security", "opus", null],
  ];
  for (const [role, claude, pi] of cases) {
    test(`${role}: claude=${claude} pi=${pi} (zero config)`, () => {
      assert.equal(resolveRoleModel({}, { role, harness: "claude" }), claude);
      assert.equal(resolveRoleModel({}, { role, harness: "pi" }), pi);
    });
  }

  test("zero-config on Pi is a genuine no-op for every role", () => {
    for (const [role] of cases) {
      assert.equal(resolveRoleModel({}, { role, harness: "pi" }), null, `${role} must be null on pi`);
    }
  });

  test("null/unknown harness and empty role resolve null (fail closed)", () => {
    assert.equal(resolveRoleModel({}, { role: "developer", harness: "openai" }), null);
    assert.equal(resolveRoleModel({}, { role: "developer" }), null);
    assert.equal(resolveRoleModel({}, { role: "", harness: "claude" }), null);
    assert.equal(resolveRoleModel({}), null);
  });

  test("models.roles concrete override beats the tier on both harnesses", () => {
    const config = { models: { roles: { developer: "gpt-5" } } };
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "claude" }), "gpt-5");
    // Precedence holds on Pi even though the built-in Pi tier is null.
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "pi" }), "gpt-5");
  });

  test("models.roleTiers override retargets a role's tier", () => {
    const config = { models: { roleTiers: { developer: "high", review: "low" } } };
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "claude" }), "opus");
    assert.equal(resolveRoleModel(config, { role: "review", harness: "claude" }), "sonnet");
  });

  test("explicit roleTiers can downgrade a critical angle (no silent downgrade otherwise)", () => {
    // Default: correctness stays high.
    assert.equal(resolveRoleModel({}, { role: "correctness", harness: "claude" }), "opus");
    // Explicit opt-in only.
    const config = { models: { roleTiers: { correctness: "low" } } };
    assert.equal(resolveRoleModel(config, { role: "correctness", harness: "claude" }), "sonnet");
  });

  test("operator-set Pi tier ids make Pi resolve concretely", () => {
    const config = { models: { tiers: { low: { claude: "sonnet", pi: "haiku" }, high: { claude: "opus", pi: "sonnet" } } } };
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "pi" }), "haiku");
    assert.equal(resolveRoleModel(config, { role: "review", harness: "pi" }), "sonnet");
    // Claude side unchanged.
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "claude" }), "sonnet");
  });

  test("a partial tier override (pi only) preserves the built-in Claude mapping", () => {
    // Setting only the Pi id for a tier must not erase the built-in Claude id
    // for that tier — the two harness keys are deep-merged per alias.
    const config = { models: { tiers: { low: { pi: "somePiId" } } } };
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "pi" }), "somePiId");
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "claude" }), "sonnet");
  });

  test("inherit tier resolves null on both harnesses", () => {
    const config = { models: { roleTiers: { developer: "inherit" } } };
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "claude" }), null);
    assert.equal(resolveRoleModel(config, { role: "developer", harness: "pi" }), null);
  });
});

describe("resolveRoleModel — angle vs role disambiguation (kind)", () => {
  // The `docs` name is BOTH a registered gate angle (persona `docs`) and a
  // routine role (→ low). Without a discriminator the angle silently inherited
  // the `docs` writer role's low tier; kind:"angle" forces review quality.
  for (const harness of ["claude", "pi"]) {
    test(`docs ANGLE resolves via the review tier (high), not the docs role — ${harness}`, () => {
      const angle = resolveRoleModel({}, { role: "docs", harness, kind: "angle" });
      const reviewTier = resolveRoleModel({}, { role: "review", harness });
      const docsRole = resolveRoleModel({}, { role: "docs", harness });
      assert.equal(angle, reviewTier, "docs angle must match the review (high) tier");
      // Claude: opus (high) not sonnet (low); Pi: null high-tier no-op, still
      // distinct in provenance from the docs role which is also null on Pi.
      if (harness === "claude") assert.notEqual(angle, docsRole);
    });

    test(`docs ROLE still resolves low (unchanged) — ${harness}`, () => {
      assert.equal(
        resolveRoleModel({}, { role: "docs", harness }),
        harness === "claude" ? "sonnet" : null,
      );
    });

    test(`correctness stays high whether dispatched as angle or auto — ${harness}`, () => {
      const expected = harness === "claude" ? "opus" : null;
      assert.equal(resolveRoleModel({}, { role: "correctness", harness, kind: "angle" }), expected);
      assert.equal(resolveRoleModel({}, { role: "correctness", harness }), expected);
    });

    test(`developer ROLE stays low — ${harness}`, () => {
      assert.equal(
        resolveRoleModel({}, { role: "developer", harness }),
        harness === "claude" ? "sonnet" : null,
      );
    });
  }

  test("on Pi with distinct tier ids, the docs ANGLE takes the high tier and the docs ROLE the low tier", () => {
    // Zero-config maps both low and high to null on Pi, so a regression where
    // the angle wrongly took the docs (low) tier would still pass (null===null).
    // Distinct non-null Pi ids per tier make the provenance observable: the
    // angle MUST resolve high and the role low, or this fails.
    const config = { models: { tiers: { low: { pi: "pi-low-model" }, high: { pi: "pi-high-model" } } } };
    assert.equal(
      resolveRoleModel(config, { role: "docs", harness: "pi", kind: "angle" }),
      "pi-high-model",
      "docs angle must resolve via the review (high) tier on Pi",
    );
    assert.equal(
      resolveRoleModel(config, { role: "docs", harness: "pi", kind: "role" }),
      "pi-low-model",
      "docs role must stay on the low tier on Pi",
    );
  });

  test("explicit per-angle `tier` entry beats the review-tier default", () => {
    // `low` is DISTINCT from the angle-path fallback (review → high → opus), so
    // this fails if the entry.tier override is ignored. Angle-level tier
    // overrides now live on the gate's own angle entry (D4), not the removed
    // angle-keyed models.roleTiers map.
    const config = { gates: { draft: { angles: [{ name: "docs", tier: "low" }] } } };
    assert.equal(resolveRoleModel(config, { role: "docs", harness: "claude", kind: "angle" }), "sonnet");
    // The role path is unaffected — models.roleTiers (role-keyed) still governs it,
    // and docs already resolves low there by default.
    assert.equal(resolveRoleModel(config, { role: "docs", harness: "claude", kind: "role" }), "sonnet");
  });
});

describe("models.tiers / models.roleTiers schema validation", () => {
  test("accepts tiers + roleTiers alongside roles + conductor", () => {
    const ok = DevLoopConfigSchema.safeParse({
      version: 1,
      models: {
        conductor: "gpt-5",
        roles: { security: "gpt-5" },
        tiers: { low: { claude: "sonnet", pi: null }, high: { claude: "opus", pi: "sonnet" } },
        roleTiers: { developer: "low", review: "high", "dev-loop": "inherit" },
      },
    });
    assert.equal(ok.success, true, ok.success ? "" : JSON.stringify(ok.error?.issues));
  });

  test("rejects an unknown tier alias referenced by roleTiers", () => {
    const bad = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { roleTiers: { developer: "mid" } },
    });
    assert.equal(bad.success, false);
    assert.match(bad.error.issues.map((i) => i.message).join(" "), /unknown model tier alias "mid"/);
  });

  test("accepts a custom tier alias when defined under models.tiers", () => {
    const ok = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { tiers: { mid: { claude: "sonnet" } }, roleTiers: { developer: "mid" } },
    });
    assert.equal(ok.success, true, ok.success ? "" : JSON.stringify(ok.error?.issues));
  });

  test("rejects an unknown harness key inside a tier mapping", () => {
    const bad = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { tiers: { low: { claude: "sonnet", openai: "gpt-5" } } },
    });
    assert.equal(bad.success, false);
  });

  test("FileConfigSchema validates a partial models.tiers/roleTiers block and rejects bad aliases", () => {
    assert.equal(FileConfigSchema.safeParse({ version: 1, models: { roleTiers: { quality: "high" } } }).success, true);
    assert.equal(FileConfigSchema.safeParse({ version: 1, models: { roleTiers: { quality: "bogus" } } }).success, false);
  });

  test("rejects an empty/all-null tier mapping (silent no-op alias)", () => {
    const empty = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { tiers: { mid: {} } },
    });
    assert.equal(empty.success, false);
    assert.match(empty.error.issues.map((i) => i.message).join(" "), /at least one of claude\/pi/);

    const allNull = DevLoopConfigSchema.safeParse({
      version: 1,
      models: { tiers: { mid: { claude: null, pi: null } } },
    });
    assert.equal(allNull.success, false);
  });

  test("accepts a partial tier mapping with only one harness set", () => {
    assert.equal(
      DevLoopConfigSchema.safeParse({ version: 1, models: { tiers: { mid: { pi: "x" } } } }).success,
      true,
    );
    assert.equal(
      DevLoopConfigSchema.safeParse({ version: 1, models: { tiers: { mid: { claude: "y" } } } }).success,
      true,
    );
  });
});

// ── resolveBaseBranch (#1368) ──────────────────────────────────────────────

/** A real (tiny) git repo with one commit, so origin/HEAD auto-detect works. */
function makeGitRepo({ defaultBranch = "main" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "base-branch-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", defaultBranch);
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(path.join(root, "README"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // A self-referential "origin" makes `origin/HEAD` resolvable offline.
  git("remote", "add", "origin", root);
  git("fetch", "-q", "origin");
  git("remote", "set-head", "origin", defaultBranch);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("resolveBaseBranch (#1368)", () => {
  test("configured workflow.baseBranch wins outright, no git probe needed", () => {
    const config = { version: 1, workflow: { baseBranch: "spike/shakapacker-to-vite" } };
    assert.equal(resolveBaseBranch(config, { cwd: "/nonexistent-path-never-a-repo" }), "spike/shakapacker-to-vite");
  });

  test("trims a configured value with incidental whitespace", () => {
    const config = { version: 1, workflow: { baseBranch: "  develop  " } };
    assert.equal(resolveBaseBranch(config, { cwd: "/nonexistent-path-never-a-repo" }), "develop");
  });

  test("normalizes a configured ref to a bare branch (no origin/origin double-prefix)", () => {
    // A user may put a remote/full ref in config; callers prepend origin/, so it
    // must reduce to a bare name first (origin/main -> main, not origin/origin/main).
    const cwd = "/nonexistent-path-never-a-repo";
    assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "origin/main" } }, { cwd }), "main");
    assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "refs/heads/develop" } }, { cwd }), "develop");
    assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "refs/remotes/origin/release" } }, { cwd }), "release");
    // A branch name that merely contains a slash is left intact.
    assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "spike/vite" } }, { cwd }), "spike/vite");
  });

  test("a prefix-only configured value (normalizes to empty) is treated as unset, never returns \"\"", () => {
    // "origin/" / "refs/heads/" reduce to "" — must fall through to auto-detect
    // (literal "main" fallback on a non-repo cwd), never yield an empty base.
    const cwd = "/nonexistent-path-never-a-repo";
    assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "origin/" } }, { cwd }), "main");
    assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "refs/heads/" } }, { cwd }), "main");
  });

  test("unset config auto-detects the repo's real default branch (main)", () => {
    const repo = makeGitRepo({ defaultBranch: "main" });
    try {
      assert.equal(resolveBaseBranch({ version: 1 }, { cwd: repo.root }), "main");
      assert.equal(resolveBaseBranch(undefined, { cwd: repo.root }), "main");
    } finally {
      repo.cleanup();
    }
  });

  test("unset config auto-detects a non-main default branch (master)", () => {
    const repo = makeGitRepo({ defaultBranch: "master" });
    try {
      assert.equal(resolveBaseBranch({ version: 1 }, { cwd: repo.root }), "master");
    } finally {
      repo.cleanup();
    }
  });

  test("malformed/empty configured value is treated as unset (falls back to auto-detect)", () => {
    const repo = makeGitRepo({ defaultBranch: "main" });
    try {
      assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "" } }, { cwd: repo.root }), "main");
      assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: "   " } }, { cwd: repo.root }), "main");
      assert.equal(resolveBaseBranch({ version: 1, workflow: { baseBranch: null } }, { cwd: repo.root }), "main");
    } finally {
      repo.cleanup();
    }
  });

  test("no resolvable repo at cwd falls back to the literal \"main\" (never throws)", () => {
    assert.equal(resolveBaseBranch({ version: 1 }, { cwd: "/nonexistent-path-never-a-repo" }), "main");
  });

  test("single config value derives both the origin/-prefixed worktree form and the bare gh/PR form", () => {
    const config = { version: 1, workflow: { baseBranch: "spike/shakapacker-to-vite" } };
    const bare = resolveBaseBranch(config, { cwd: "/nonexistent-path-never-a-repo" });
    // Worktree creation prepends origin/ (a remote ref); gh/PR base flags pass
    // the bare name straight through — both derive from this one resolved value.
    assert.equal(`origin/${bare}`, "origin/spike/shakapacker-to-vite");
    assert.equal(bare, "spike/shakapacker-to-vite");
  });
});

test("resolveGateDispatchMode: legacy defer input escalates against a nice-to-have blocking entry (cross-spelling)", () => {
  const config = {
    version: 1,
    localImplementation: { lightMode: { enabled: true, maxFiles: 2, maxLines: 20 } },
    gates: { preApproval: { blockCleanOnFindingSeverities: ["must-fix", "nice-to-have"] } },
  };
  const result = resolveGateDispatchMode(config, "preApproval", {
    scope: { filesChanged: 1, linesChanged: 5 },
    inlineFindingSeverities: ["defer"],
  });
  assert.equal(result.mode, "full_fanout");
  assert.equal(result.reason, "escalated");
});

test("gates.fanout.sequential: a .devloops merging it loads cleanly through the zod schema (#1726)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "devloop-config-fanout-seq-"));
  try {
    await writeFile(
      path.join(tmpDir, ".devloops"),
      [
        "version: 1",
        "gates:",
        "  fanout:",
        "    sequential: true",
        "    maxConcurrent: 8",
        "",
      ].join("\n"),
    );
    const { loadDevLoopConfig } = await import("../src/config/config.mjs");
    const result = await loadDevLoopConfig({ repoRoot: tmpDir });
    assert.equal(result.config.gates.fanout.sequential, true);
    assert.equal(resolveFanoutSequential(result.config), true);
    assert.equal(resolveFanoutEffectiveConcurrency(result.config), 1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
