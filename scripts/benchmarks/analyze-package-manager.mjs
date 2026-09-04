#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stable = (value) => JSON.stringify(value);
const validRuns = (runs, count, { tool, measured } = {}) => Array.isArray(runs) && runs.length === count
  && runs.every((run) => run.exitCode === 0 && Number.isFinite(run.durationMs) && run.durationMs >= 0
    && (tool === undefined || run.tool === tool) && (measured === undefined || run.measured === measured));

export function analyzeBenchmark(sessions) {
  const errors = [];
  if (!Array.isArray(sessions) || sessions.length !== 2) return { pass: false, errors: ["exactly two independent session files are required"] };
  const [first, second] = sessions;
  for (const [index, evidence] of sessions.entries()) {
    if (evidence?.protocolVersion !== 2) errors.push(`session ${index + 1}: unsupported protocolVersion`);
    if (!evidence?.sessionId || !evidence?.sessionRoot) errors.push(`session ${index + 1}: missing session identity/root`);
    for (const key of ["platform", "arch", "cpu", "node", "bun", "npm", "powerState"]) if (!evidence?.environment?.[key]) errors.push(`session ${index + 1}: missing environment.${key}`);
    for (const [field, label, missingLabel] of [
      ["packages", "dependency package identities", "dependency package identity inventories"],
      ["bins", "root executable bins", "root executable bin inventories"],
      ["workspaceLinks", "workspace links", "workspace link inventories"],
    ]) {
      const npmInventory = evidence?.inventory?.npm?.[field];
      const bunInventory = evidence?.inventory?.bun?.[field];
      if (!Array.isArray(npmInventory) || !Array.isArray(bunInventory)) errors.push(`session ${index + 1}: missing ${missingLabel}`);
      else if (stable(npmInventory) !== stable(bunInventory)) errors.push(`session ${index + 1}: ${label} differ`);
    }
    if (stable(evidence?.suiteInventory?.npm) !== stable(evidence?.suiteInventory?.bun)) errors.push(`session ${index + 1}: verification suite inventories differ`);
  }
  if (first?.sessionId === second?.sessionId || first?.sessionRoot === second?.sessionRoot) errors.push("sessions must have distinct ids and temporary roots");
  if (first?.startTool === second?.startTool) errors.push("sessions must use opposite starting tool orders");
  for (const key of ["environment", "sourceFingerprint", "suiteInventory"]) if (stable(first?.[key]) !== stable(second?.[key])) errors.push(`session fingerprint mismatch: ${key}`);

  const installs = [];
  const verify = [];
  for (const [index, evidence] of sessions.entries()) {
    const sessionInstall = {};
    for (const phase of ["cold", "warm"]) {
      const npmPhase = evidence?.installs?.npm?.[phase];
      const bunPhase = evidence?.installs?.bun?.[phase];
      const complete = validRuns(npmPhase?.warmups, 1, { tool: "npm", measured: false }) && validRuns(npmPhase?.measured, 7, { tool: "npm", measured: true })
        && validRuns(bunPhase?.warmups, 1, { tool: "bun", measured: false }) && validRuns(bunPhase?.measured, 7, { tool: "bun", measured: true })
        && (phase !== "warm" || (validRuns(npmPhase?.prime, 1, { tool: "npm", measured: false }) && validRuns(bunPhase?.prime, 1, { tool: "bun", measured: false })));
      const npmMedian = complete ? median(npmPhase.measured.map((run) => run.durationMs)) : null;
      const bunMedian = complete ? median(bunPhase.measured.map((run) => run.durationMs)) : null;
      const ratio = complete && npmMedian > 0 ? bunMedian / npmMedian : null;
      const pass = complete && ratio <= 0.5;
      sessionInstall[phase] = { npmMedian, bunMedian, ratio, pass };
      if (!pass) errors.push(`session ${index + 1}: ${phase} install requires 7 successful samples and Bun median <=50% of npm`);
    }
    installs.push(sessionInstall);

    const runs = evidence?.verify ?? [];
    const measured = runs.filter((run) => run.measured);
    const warmups = runs.filter((run) => !run.measured);
    const expected = [];
    for (let pair = 0; pair < 7; pair++) {
      const firstTool = pair % 2 === 0 ? evidence?.startTool : evidence?.startTool === "npm" ? "bun" : "npm";
      expected.push(firstTool, firstTool === "npm" ? "bun" : "npm");
    }
    const complete = ["npm", "bun"].includes(evidence?.startTool) && validRuns(warmups, 2, { measured: false }) && new Set(warmups.map((run) => run.tool)).size === 2 && validRuns(measured, 14, { measured: true })
      && measured.every((run, runIndex) => run.tool === expected[runIndex]);
    const npmRuns = measured.filter((run) => run.tool === "npm");
    const bunRuns = measured.filter((run) => run.tool === "bun");
    const npmMedian = complete ? median(npmRuns.map((run) => run.durationMs)) : null;
    const bunMedian = complete ? median(bunRuns.map((run) => run.durationMs)) : null;
    const wins = complete ? Array.from({ length: 7 }, (_, pair) => {
      const paired = measured.slice(pair * 2, pair * 2 + 2);
      return paired.find((run) => run.tool === "bun").durationMs < paired.find((run) => run.tool === "npm").durationMs;
    }).filter(Boolean).length : 0;
    const pass = complete && bunMedian < npmMedian && wins >= 5;
    verify.push({ sessionId: evidence?.sessionId, npmMedian, bunMedian, wins, pass });
    if (!pass) errors.push(`session ${index + 1}: verify requires 7 successful interleaved pairs, lower Bun median, and >=5/7 wins`);
  }
  return { pass: errors.length === 0, errors, installs, verify };
}

async function main() {
  const inputs = process.argv.slice(2);
  if (inputs.length !== 2) throw new Error("usage: analyze-package-manager.mjs <session-1.json> <session-2.json>");
  const verdict = analyzeBenchmark(await Promise.all(inputs.map(async (input) => JSON.parse(await readFile(input, "utf8")))));
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exitCode = verdict.pass ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
