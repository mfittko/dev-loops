import assert from "node:assert/strict";
import { test } from "bun:test";

import { buildReviewDispatchPlan } from "../src/loop/review-dispatch-plan.mjs";
import { consolidateFanin } from "../src/loop/gate-fanin.mjs";
import { resolveRoleModel } from "../src/config/config.mjs";

// Issue #2414 retired the mandatory primer barrier, so this case keeps only the
// Codex model-inheritance assertions #2467 added and drops its primer-evidence
// half, whose API no longer exists.
test("Codex model resolution works through both gate fan-ins without a primer phase", () => {
  const config = { models: { tiers: { high: { claude: "opus", pi: "pi-review" } } } };
  for (const gate of ["draft_gate", "pre_approval_gate"]) {
    const model = resolveRoleModel(config, { role: "correctness", harness: "codex", kind: "angle" });
    assert.equal(model, null);
    const plan = buildReviewDispatchPlan({
      gate,
      headSha: "abc1234567890",
      harness: "codex",
      sharedPrefixHash: "sha256:" + "a".repeat(64),
      requestGroups: [{ model: "inherit", requestPrefixFingerprint: "sha256:" + "b".repeat(64), angles: ["correctness"] }],
      capabilities: { harness: "codex" },
    });
    assert.equal(plan.harness, "codex");
    assert.equal(plan.requestGroups[0].model, "inherit");
    assert.equal(consolidateFanin({ angleResults: [{ angle: "correctness", verdict: "clean", findings: [] }] }).verdict, "clean");
  }
});
