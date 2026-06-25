import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

import {
  loadDevLoopConfig,
  resolveGateConfig,
  resolveGateAngles,
  resolveGateAnglesDynamic,
} from "../src/config/config.mjs";

// packages/core/test -> repo root is three levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The acceptance-criteria / definition-of-done verification angle must be a
// MANDATORY pre_approval_gate angle so dynamic angle resolution can never drop
// it (epic #867 / #878).
const AC_DOD_ANGLE = "acceptance-criteria";

describe(".devloops mandatory AC/DoD angle (pre_approval_gate)", () => {
  test("is listed in both angles and mandatoryAngles for preApproval", async () => {
    const { config, errors } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    assert.deepEqual(errors, [], `config load errors: ${JSON.stringify(errors)}`);

    const gate = resolveGateConfig(config, "preApproval");
    assert.ok(gate.angles?.includes(AC_DOD_ANGLE), "preApproval.angles must include acceptance-criteria");
    assert.ok(
      gate.mandatoryAngles.includes(AC_DOD_ANGLE),
      "preApproval.mandatoryAngles must include acceptance-criteria",
    );
    // pr-checklist-matrix stays mandatory alongside it.
    assert.ok(gate.mandatoryAngles.includes("pr-checklist-matrix"));
  });

  test("survives static resolveGateAngles", async () => {
    const { config } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    const angles = resolveGateAngles(config, "preApproval");
    assert.ok(Array.isArray(angles));
    assert.ok(angles.includes(AC_DOD_ANGLE));
  });

  test("survives dynamic angle resolution (mandatory floor) for an unrelated change", async () => {
    const { config } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    // Force dynamicAngles on for this gate and feed a docs-only diff that would
    // otherwise drop most code lenses — the mandatory floor must keep AC/DoD.
    const dynConfig = {
      ...config,
      gates: {
        ...config.gates,
        preApproval: { ...config.gates.preApproval, dynamicAngles: true },
      },
    };
    const result = await resolveGateAnglesDynamic(dynConfig, "preApproval", {
      diff: { nameStatusOutput: "M\tREADME.md\n" },
    });
    assert.equal(result.dynamicAnglesActive, true);
    assert.ok(
      result.recommendedAngles.includes(AC_DOD_ANGLE),
      `acceptance-criteria must survive dynamic resolution; got ${JSON.stringify(result.recommendedAngles)}`,
    );
    assert.ok(!result.skippedAngles.includes(AC_DOD_ANGLE));
  });

  test("every configured mandatory angle survives dynamic resolution (fully configurable, not AC/DoD-specific)", async () => {
    const { config } = await loadDevLoopConfig({ repoRoot: REPO_ROOT });
    const gate = resolveGateConfig(config, "preApproval");
    // The mandatory set is config-driven — e.g. it also includes `yagni`.
    assert.ok(gate.mandatoryAngles.includes("yagni"), "yagni should be a configured mandatory angle");
    const dynConfig = {
      ...config,
      gates: { ...config.gates, preApproval: { ...config.gates.preApproval, dynamicAngles: true } },
    };
    const result = await resolveGateAnglesDynamic(dynConfig, "preApproval", {
      diff: { nameStatusOutput: "M\tREADME.md\n" },
    });
    for (const angle of gate.mandatoryAngles) {
      assert.ok(
        result.recommendedAngles.includes(angle),
        `mandatory angle "${angle}" must survive dynamic resolution; got ${JSON.stringify(result.recommendedAngles)}`,
      );
      assert.ok(!result.skippedAngles.includes(angle), `mandatory angle "${angle}" must not be skipped`);
    }
  });
});
