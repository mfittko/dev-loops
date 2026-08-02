import assert from "node:assert/strict";
import test from "node:test";

import { loadDevLoopConfig, resolveGateAngleContract } from "@dev-loops/core/config";
import { deriveGateConfig } from "@dev-loops/core/loop/handoff-envelope";

// ---------------------------------------------------------------------------
// Angle-vocabulary parity between the handoff envelope and the fan-out
// verdict validator (#1481).
//
// The handoff envelope (buildDevLoopHandoffEnvelope → deriveGateConfig)
// advertises `gateConfig.angles` — the angle vocabulary a dev-loop orchestrator
// is told to run for a gate's review fan-out. Separately,
// upsert-checkpoint-verdict.mjs validates a posted fanout_fanin verdict's
// per-angle results (via checkFanoutAngleCoverage) against
// `resolveGateAngleContract(config, gateKey).{mandatoryAngles,pool}`. If the
// envelope ever resolved its angle list from a DIFFERENT config path (e.g. a
// hardcoded list, or a raw resolveGateConfig().angles read that skips
// mandatory-merge/additive-pool expansion), an orchestrator could brief
// reviewers with an angle set the validator would then reject/under-enforce —
// a silent contract drift.
//
// This test loads THIS repo's own merged config (.devloops at the worktree
// root, merged with the shipped extension defaults) through BOTH consumer
// code paths and pins the two load-bearing invariants per gate: everything
// the envelope advertises is within the validator pool (no foreign angles),
// and every validator-mandatory angle is advertised. Set-equality with the
// pool is deliberately NOT asserted: the pool is the enforcement ceiling and
// widens under dynamic.additive, while the envelope advertises the run-set.
// ---------------------------------------------------------------------------

const GATE_KEYS = ["draft", "preApproval"];

/**
 * Independently re-derive the mandatory-angle set directly from the merged
 * config's raw `gates.<gate>.angles` array (the unified D3 angle-entry
 * shape), WITHOUT going through any of the resolver functions under test —
 * a genuinely separate path from both deriveGateConfig and
 * resolveGateAngleContract, so a bug shared by both would still surface here.
 * @param {unknown} rawAngles
 * @returns {Set<string>}
 */
function mandatorySetFromRawConfig(rawAngles) {
  const set = new Set();
  if (!Array.isArray(rawAngles)) return set;
  for (const entry of rawAngles) {
    if (!entry || typeof entry !== "object") continue; // string sugar entries are never mandatory
    if (entry.mandatory === true && entry.enabled !== false && typeof entry.name === "string") {
      set.add(entry.name.trim());
    }
  }
  return set;
}

test("envelope gateConfig.angles stays within the validator pool and carries every mandatory angle, per configured gate", async () => {
  const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });

  for (const gateKey of GATE_KEYS) {
    assert.ok(config?.gates?.[gateKey], `expected this repo's config to configure gates.${gateKey}`);

    // Validator side: the exact resolver upsert-checkpoint-verdict.mjs calls.
    const { mandatoryAngles: validatorMandatory, pool: validatorPool } = resolveGateAngleContract(config, gateKey);
    assert.ok(Array.isArray(validatorPool) && validatorPool.length > 0, `${gateKey}: expected a non-empty validator pool`);

    // Envelope side: the exact function buildDevLoopHandoffEnvelope calls
    // (deriveGateConfig), through the subGate spelling the envelope uses.
    const subGate = gateKey === "preApproval" ? "pre-approval" : gateKey;
    const envelopeGateConfig = deriveGateConfig(config, subGate);
    assert.ok(envelopeGateConfig, `${gateKey}: expected deriveGateConfig to produce a gateConfig for this repo`);

    // Subset, not set-equality: the pool is the enforcement CEILING (it
    // deliberately widens to the whole lens catalog under dynamic.additive),
    // while the envelope advertises the RUN-set. The two invariants that
    // matter: nothing advertised is foreign to the validator, and (below)
    // every validator-mandatory angle is advertised.
    for (const angle of envelopeGateConfig.angles) {
      assert.ok(
        validatorPool.includes(angle),
        `${gateKey}: envelope-advertised angle "${angle}" must be within the validator pool (no foreign angles)`,
      );
    }

    // Mandatory-set side: independently re-derived from the raw merged config
    // (not via either resolver under test) must set-equal the validator's
    // mandatoryAngles, AND every mandatory angle must actually be a member of
    // the envelope's advertised pool (the envelope has no separate
    // mandatoryAngles field — membership in `angles` is how it represents
    // "this angle always runs").
    const rawMandatory = mandatorySetFromRawConfig(config.gates[gateKey].angles);
    assert.deepEqual(
      rawMandatory,
      new Set(validatorMandatory),
      `${gateKey}: the raw config's mandatory-angle entries must set-equal resolveGateAngleContract's mandatoryAngles`,
    );
    for (const mandatory of rawMandatory) {
      assert.ok(
        envelopeGateConfig.angles.includes(mandatory),
        `${gateKey}: mandatory angle "${mandatory}" must be present in the envelope's advertised gateConfig.angles`,
      );
    }
  }
});

test("dynamic.additive must not over-broaden the envelope's advertised run-set to the whole lens catalog", async () => {
  const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });
  const synthetic = {
    ...config,
    gates: {
      ...config.gates,
      draft: { angles: ["dry"], dynamic: { additive: true } },
    },
  };
  const envelopeGateConfig = deriveGateConfig(synthetic, "draft");
  const { mandatoryAngles, pool } = resolveGateAngleContract(synthetic, "draft");
  // The pool legitimately widens under additive; the ADVERTISED run-set must
  // stay the configured angles plus mandatory merges — never the widened pool.
  assert.ok(pool.length > 5, "precondition: additive widened the validator pool to the catalog");
  assert.deepEqual(
    new Set(envelopeGateConfig.angles),
    new Set(["dry", ...mandatoryAngles]),
    "advertised run-set must be configured angles + mandatory, not the additive-widened pool",
  );
});
