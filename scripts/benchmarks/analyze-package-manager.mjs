#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function analyzeBenchmark(evidence) {
  const errors = [];
  if (evidence?.protocolVersion !== 1) errors.push("unsupported or missing protocolVersion");
  for (const key of ["platform", "arch", "cpu", "node", "bun", "npm"]) {
    if (!evidence?.environment?.[key]) errors.push(`missing environment.${key}`);
  }

  const sameInventory = JSON.stringify(evidence?.inventory?.npm) === JSON.stringify(evidence?.inventory?.bun);
  if (!sameInventory) errors.push("npm and Bun dependency inventories differ");

  const installs = {};
  for (const phase of ["cold", "warm"]) {
    const npmRun = evidence?.installs?.npm?.[phase];
    const bunRun = evidence?.installs?.bun?.[phase];
    const valid = npmRun?.exitCode === 0 && bunRun?.exitCode === 0
      && Number.isFinite(npmRun?.durationMs) && Number.isFinite(bunRun?.durationMs) && npmRun.durationMs > 0;
    const ratio = valid ? bunRun.durationMs / npmRun.durationMs : null;
    installs[phase] = { ratio, pass: valid && ratio <= 0.5 };
    if (!installs[phase].pass) errors.push(`${phase} install did not complete successfully at <=50% of npm time`);
  }

  const verify = [];
  for (const session of [1, 2]) {
    const sessionRuns = (evidence?.verify ?? []).filter((item) => item.session === session);
    const expectedFirst = session === 1 ? "npm" : "bun";
    const interleaved = sessionRuns.length === 16 && sessionRuns.every((item, index) => item.tool === (index % 2 === 0 ? expectedFirst : expectedFirst === "npm" ? "bun" : "npm"));
    const warmups = sessionRuns.filter((item) => !item.measured);
    const npmRuns = sessionRuns.filter((item) => item.measured && item.tool === "npm");
    const bunRuns = sessionRuns.filter((item) => item.measured && item.tool === "bun");
    const complete = interleaved && warmups.length === 2 && npmRuns.length === 7 && bunRuns.length === 7
      && sessionRuns.every((item) => item.exitCode === 0 && Number.isFinite(item.durationMs));
    const npmMedian = complete ? median(npmRuns.map((item) => item.durationMs)) : null;
    const bunMedian = complete ? median(bunRuns.map((item) => item.durationMs)) : null;
    const wins = complete ? bunRuns.filter((item, index) => item.durationMs < npmRuns[index].durationMs).length : 0;
    const pass = complete && bunMedian < npmMedian && wins >= 5;
    verify.push({ session, npmMedian, bunMedian, wins, pass });
    if (!pass) errors.push(`verify session ${session} requires a lower Bun median and at least 5/7 paired wins`);
  }

  return { pass: errors.length === 0, errors, inventoryEqual: sameInventory, installs, verify };
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("usage: analyze-package-manager.mjs <raw-evidence.json>");
  const verdict = analyzeBenchmark(JSON.parse(await readFile(input, "utf8")));
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exitCode = verdict.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
