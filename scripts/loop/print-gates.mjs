#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { resolveGateConfig } from "@dev-loops/core/config";
import { resolveGateAngles, resolveReviewerRole } from "@dev-loops/core/config";
async function run({ stdout = process.stdout, repoRoot = process.cwd() } = {}) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  const gates = [
    { name: "draft_gate", label: "draft gate", gate: "draft" },
    { name: "pre_approval_gate", label: "pre-approval gate", gate: "preApproval" },
  ];
  for (const { label, gate } of gates) {
    const gateConfig = resolveGateConfig(config, gate);
    const angles = resolveGateAngles(config, gate);
    const ciLabel = gate === "draft"
      ? String(gateConfig.requireCi)
      : "true (always enforced)";
    stdout.write(`${label}:\n`);
    stdout.write(`  requireCi: ${ciLabel}\n`);
    if (!angles || angles.length === 0) {
      stdout.write("  (no angles configured)\n\n");
      continue;
    }
    const maxLen = Math.max(...angles.map(a => a.length));
    for (const angle of angles) {
      const { prompt } = resolveReviewerRole(config, angle);
      const displayPrompt = prompt ?? "(no prompt — add to config personas)";
      stdout.write(`  ${angle.padEnd(maxLen + 2)} ${displayPrompt}\n`);
    }
    stdout.write("\n");
  }
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  run().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
export { run };
