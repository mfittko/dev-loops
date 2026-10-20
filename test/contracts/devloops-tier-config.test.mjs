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
// pre-push-reviewer role into Opus 5.5 and the Pi harness into the review tier.
// Pins the real merged .devloops so the opt-in cannot silently drift.
//
// The concrete Pi model id is the OPERATOR's choice, not the repo's: it is read
// from the tier the config under test declares, never pinned as a literal, so
// switching the model needs a `.devloops` edit only. The repo owns the tier
// STRUCTURE — which role maps to which tier, and which harness key carries a
// concrete model — and that structure is asserted against literals below.
test("this repo's .devloops resolves the pre-push-reviewer to Opus on Claude and to the review tier's Pi model (issue #2305)", async () => {
  const { config, errors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);

  assert.equal(
    resolveRoleModel(config, { role: "pre-push-reviewer", harness: "claude" }),
    "opus",
    "Claude-Code harness pre-push-reviewer must resolve to the Opus model token via .devloops",
  );
  // Structure: the pre-push reviewer runs on its own strong tier, and that tier
  // carries a concrete Pi model. A wrong role->tier mapping, a missing tier or
  // a missing harness key fails here; a different model id does not.
  assert.equal(
    config.models.roleTiers["pre-push-reviewer"],
    "pre-pr-strong",
    "the pre-push-reviewer role must map to the pre-pr-strong tier",
  );
  assert.equal(
    config.models.roleTiers["pre-PR-reviewer"],
    undefined,
    "the rename leaves no alias: the old role key is gone from the repo config",
  );
  const prePrStrongPi = config.models.tiers["pre-pr-strong"]?.pi;
  assert.ok(
    typeof prePrStrongPi === "string" && prePrStrongPi.length > 0,
    "the pre-pr-strong tier must carry a concrete Pi model id in .devloops",
  );
  assert.ok(
    prePrStrongPi.includes("/") && !/^(sonnet|opus|haiku|fable)$/i.test(prePrStrongPi),
    `the pre-pr-strong tier's Pi model must be a concrete provider-qualified id, got ${prePrStrongPi}`,
  );
  assert.equal(
    resolveRoleModel(config, { role: "pre-push-reviewer", harness: "pi" }),
    prePrStrongPi,
    "Pi harness pre-push-reviewer must resolve to the pre-pr-strong tier's configured Pi model",
  );
});

// Regular vs. strong split: routine roles run on the regular tier (sonnet on
// Claude; on Pi the regular tier carries the operator's cheap model); review,
// refiner, the pre-push reviewer and every gate angle stay on opus.
test("this repo's .devloops resolves the regular tier to sonnet and the strong roles to opus", async () => {
  const { config, errors } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);

  // The STRUCTURE is the repo's invariant and is asserted against literals:
  // which role maps to which tier, and which harness key carries a concrete
  // model. The concrete Pi model ids are the operator's choice, so they are
  // read from the tier the config under test declares — a model switch needs a
  // `.devloops` edit only, while a wrong tier mapping, a wrong role mapping or
  // a missing harness key still fails here.
  assert.equal(
    config.models.roleTiers.developer,
    "low",
    "the developer role must map to the regular tier",
  );
  assert.equal(
    config.models.roleTiers.fixer,
    "low",
    "the fixer role must map to the regular tier",
  );
  assert.equal(
    config.models.roleTiers.judge,
    "high",
    "the judge role must map to the strong tier",
  );
  const lowPi = config.models.tiers.low?.pi;
  const highPi = config.models.tiers.high?.pi;
  assert.ok(
    typeof lowPi === "string" && lowPi.length > 0,
    "the regular tier must carry a concrete Pi model id in .devloops",
  );
  assert.ok(
    typeof highPi === "string" && highPi.length > 0,
    "the strong tier must carry a concrete Pi model id in .devloops",
  );
  // Non-vacuity: the review tier must be a DISTINCT model from the cheap tier
  // the reviewers check, and a real provider-qualified id rather than a Claude
  // token or a built-in fallback. A config with no Pi opt-in at all (both ids
  // null, or the review tier reusing the cheap model) fails here instead of
  // passing by reading the expected value back out of the config under test.
  assert.notEqual(
    highPi,
    lowPi,
    "the strong tier's Pi model must be the review model, never the cheap tier's model",
  );
  assert.ok(
    !/^(sonnet|opus|haiku|fable)$/i.test(highPi),
    `the strong tier's Pi model must be a concrete provider-qualified id, not a Claude token (got ${highPi})`,
  );
  assert.ok(
    highPi.includes("/"),
    `the strong tier's Pi model must be a provider-qualified id, got ${highPi}`,
  );

  for (const role of ["developer", "fixer", "docs", "quality"]) {
    assert.equal(resolveRoleModel(config, { role, harness: "claude" }), "sonnet", `${role} on claude`);
    assert.equal(
      resolveRoleModel(config, { role, harness: "pi" }),
      lowPi,
      `${role} on pi`,
    );
  }
  for (const role of ["review", "refiner", "judge"]) {
    assert.equal(resolveRoleModel(config, { role, harness: "claude" }), "opus", `${role} on claude`);
    assert.equal(resolveRoleModel(config, { role, harness: "pi" }), highPi, `${role} on pi`);
  }

  for (const gate of GATE_KEYS) {
    const { pool } = resolveGateAngleContract(config, gate);
    assert.ok(Array.isArray(pool) && pool.length > 0, `gates.${gate} must resolve a non-empty angle pool`);
    for (const angle of pool) {
      assert.equal(resolveRoleModel(config, { role: angle, harness: "claude", kind: "angle" }), "opus", `${gate} angle ${angle} on claude`);
      assert.equal(resolveRoleModel(config, { role: angle, harness: "pi", kind: "angle" }), highPi, `${gate} angle ${angle} on pi`);
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
