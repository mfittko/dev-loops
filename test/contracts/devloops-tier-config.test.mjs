import assert from "node:assert/strict";
import { test } from "bun:test";

import { loadDevLoopConfig, resolveGateAngleContract, resolveGateConfig, resolveGateTier, resolveRoleModel } from "@dev-loops/core/config";

// ---------------------------------------------------------------------------
// gates.<gate>.tiers (GATE-EXEC-DIFF-CLASS-TIER) is a plain string array of
// angle names, checked against the gate's angle pool only at RESOLVE time.
// A typo'd angle name silently voids the whole tier match
// (resolveGateTier's angle_outside_pool reason) rather than erroring at
// config-load time. This test loads THIS repo's own merged config (.devloops
// at the worktree root, merged with the shipped extension defaults) and pins
// every configured tier angle against the real resolved pool, so a typo
// fails here rather than silently degrading a gate round to "no tier match"
// at gate time.
// ---------------------------------------------------------------------------

const GATE_KEYS = ["draft", "preApproval"];

test("every configured tier angle is inside its gate's resolved angle pool", async () => {
  const { config, errors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);

  for (const gate of GATE_KEYS) {
    const { tiers } = resolveGateConfig(config, gate);
    const { pool } = resolveGateAngleContract(config, gate);
    assert.ok(Array.isArray(tiers) && tiers.length > 0, `gates.${gate}.tiers must be configured for this pin to be meaningful`);
    for (const tier of tiers) {
      for (const angle of tier.angles) {
        assert.ok(
          pool === null || pool.includes(angle),
          `gates.${gate}.tiers["${tier.name}"].angles includes "${angle}", which is outside the resolved ${gate} pool ${JSON.stringify(pool)}`,
        );
      }
    }
  }
});

// Pre-PR review phase (issue #2305): the reviewer model is config-resolved and
// harness-agnostic — never hardcoded. THIS repo opts the Claude-Code harness's
// pre-push-reviewer role into Opus 5.5 and the Pi harness into the Codex child model.
// Pins the real merged .devloops so the opt-in cannot silently drift.
test("this repo's .devloops resolves the pre-push-reviewer to Opus on Claude and the Codex child model on Pi (issue #2305)", async () => {
  const { config, errors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);

  assert.equal(
    resolveRoleModel(config, { role: "pre-push-reviewer", harness: "claude" }),
    "opus",
    "Claude-Code harness pre-push-reviewer must resolve to the Opus model token via .devloops",
  );
  assert.equal(
    resolveRoleModel(config, { role: "pre-push-reviewer", harness: "pi" }),
    "openai-codex/gpt-6.1-sol",
    "Pi harness pre-push-reviewer must resolve to the configured Codex child model",
  );
  // The rename leaves no alias: the old role key is gone from the repo config.
  assert.equal(config.models.roleTiers["pre-PR-reviewer"], undefined);
});

// Regular vs. strong split: routine roles run on the regular tier (sonnet on
// Claude; on Pi the regular tier carries the operator's free model); review,
// refiner, the pre-push reviewer and every gate angle stay on opus.
test("this repo's .devloops resolves the regular tier to sonnet and the strong roles to opus", async () => {
  const { config, errors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);

  // The regular tier's Pi model is an operator opt-in for the free
  // Ollama-hosted model; the Claude side of the same tier stays on sonnet.
  // The id is pinned rather than read back from the config under test, so a
  // wrong or paid model id in `.devloops` fails here instead of passing by
  // self-consistency.
  assert.equal(
    config.models.tiers.low.pi,
    "ollama-cloud/minimax-m3.1-flash",
    "the regular tier's Pi model must stay the operator's free Ollama-hosted model",
  );
  for (const role of ["developer", "fixer", "docs", "quality"]) {
    assert.equal(resolveRoleModel(config, { role, harness: "claude" }), "sonnet", `${role} on claude`);
    assert.equal(
      resolveRoleModel(config, { role, harness: "pi" }),
      "ollama-cloud/minimax-m3.1-flash",
      `${role} on pi`,
    );
  }
  assert.equal(config.models.tiers.high.pi, "openai-codex/gpt-6.1-sol", "the strong tier's Pi model must be the Codex model, never the free model");
  // `judge` has no built-in tier (it pins `opus` on Claude via `claudeModel` frontmatter), so it is not asserted here.
  for (const role of ["review", "refiner", "pre-push-reviewer"]) {
    assert.equal(resolveRoleModel(config, { role, harness: "claude" }), "opus", `${role} on claude`);
    assert.equal(resolveRoleModel(config, { role, harness: "pi" }), "openai-codex/gpt-6.1-sol", `${role} on pi`);
  }

  for (const gate of GATE_KEYS) {
    const { pool } = resolveGateAngleContract(config, gate);
    assert.ok(Array.isArray(pool) && pool.length > 0, `gates.${gate} must resolve a non-empty angle pool`);
    for (const angle of pool) {
      assert.equal(resolveRoleModel(config, { role: angle, harness: "claude", kind: "angle" }), "opus", `${gate} angle ${angle} on claude`);
      assert.equal(resolveRoleModel(config, { role: angle, harness: "pi", kind: "angle" }), "openai-codex/gpt-6.1-sol", `${gate} angle ${angle} on pi`);
    }
  }
});

test("a synthetic matching diff resolves a non-empty tier angle set including the gate's mandatory angles", async () => {
  const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });

  for (const gate of GATE_KEYS) {
    const gateConfig = resolveGateConfig(config, gate);
    const [firstTier] = gateConfig.tiers;
    assert.ok(firstTier, `gates.${gate}.tiers must have at least one configured tier`);

    // Build a synthetic changed-file list that matches the first tier's kind
    // whitelist (one fabricated path per whitelisted kind) and stays under
    // any maxFiles/maxLines bound.
    const kinds = firstTier.match.kinds ?? ["docs"];
    const extensionByKind = { docs: "README.md", test: "example.test.mjs", config: "some.config.yaml", code: "some.mjs", ci: ".github/workflows/ci.yml" };
    const changedFiles = kinds.map((kind, i) => `synthetic-${i}-${extensionByKind[kind] ?? "file.txt"}`);
    const filesChanged = Math.min(changedFiles.length, firstTier.match.maxFiles ?? changedFiles.length);
    const linesChanged = Math.min(1, firstTier.match.maxLines ?? 1);

    const result = resolveGateTier(config, gate, { changedFiles, filesChanged, linesChanged, hasFullLabel: false });
    assert.equal(result.reason, "tier_match", `${gate} synthetic diff should match a configured tier; got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.angles) && result.angles.length > 0, `${gate} tier match must resolve a non-empty angle set`);

    for (const mandatoryAngle of gateConfig.mandatoryAngles) {
      assert.ok(
        result.angles.includes(mandatoryAngle),
        `${gate} tier-resolved angles must include mandatory angle "${mandatoryAngle}"; got ${JSON.stringify(result.angles)}`,
      );
    }
  }
});
