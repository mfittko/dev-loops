import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { resolveGateConfig, loadDevLoopConfig } from "../src/config/config.mjs";

describe("relaxed spike gate profile (config)", () => {
  test("resolveGateConfig accepts the spike profile and resolves configured angles", () => {
    const config = {
      version: 1,
      gates: { spike: { angles: ["scope"], required: false, requireCi: false } },
    };
    const result = resolveGateConfig(config, "spike");
    assert.deepEqual(result.angles, ["scope"]);
    assert.equal(result.required, false);
    assert.equal(result.requireCi, false);
  });

  test("resolveGateConfig defaults are stable when the spike profile is absent", () => {
    const result = resolveGateConfig({ version: 1 }, "spike");
    assert.equal(result.angles, null);
  });

  test("shipped extension defaults: spike profile is relaxed (lighter than draft/preApproval)", async () => {
    // Point repoRoot at an empty dir so no repo-level config layers in — we are
    // asserting the shipped extension-defaults layer alone.
    const emptyRepo = await mkdtemp(path.join(os.tmpdir(), "spike-gate-"));
    let config;
    try {
      ({ config } = await loadDevLoopConfig({ repoRoot: emptyRepo }));
    } finally {
      await rm(emptyRepo, { recursive: true, force: true });
    }
    const spike = resolveGateConfig(config, "spike");
    const draft = resolveGateConfig(config, "draft");
    const preApproval = resolveGateConfig(config, "preApproval");

    // Relaxed: not a required gate and no CI prerequisite — a spike's deliverable
    // is a findings doc, not production code.
    assert.equal(spike.required, false);
    assert.equal(spike.requireCi, false);

    // Lighter than production: fewer angles than draft, and far fewer than
    // draft + preApproval combined.
    assert.ok(Array.isArray(spike.angles) && spike.angles.length > 0);
    assert.ok(
      spike.angles.length < (draft.angles?.length ?? 0),
      `spike (${spike.angles.length}) should be lighter than draft (${draft.angles?.length})`,
    );

    // Production posture is UNCHANGED: draft/preApproval stay required.
    assert.equal(draft.required, true);
    assert.equal(draft.requireCi, true);
    assert.equal(preApproval.required, true);
  });
});
