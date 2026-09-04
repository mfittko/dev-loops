import assert from "node:assert/strict";
import test from "node:test";

import { loadDevLoopConfig, resolveGateAngleContract, resolveGateConfig, resolveGateTier } from "@dev-loops/core/config";

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
