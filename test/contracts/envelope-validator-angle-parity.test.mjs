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
// code paths and asserts they resolve to the identical angle vocabulary per
// gate, so a future change that reintroduces divergence fails here.
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

test("envelope gateConfig.angles set-equals the fan-out validator's resolveGateAngleContract pool, per configured gate", async () => {
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

    assert.deepEqual(
      new Set(envelopeGateConfig.angles),
      new Set(validatorPool),
      `${gateKey}: envelope gateConfig.angles must set-equal resolveGateAngleContract's pool (the SAME angle vocabulary the fan-out verdict validator enforces)`,
    );

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
