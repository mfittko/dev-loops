#!/usr/bin/env node
// Parallel `npm run verify`: one merged `node --test` concurrency pool for all
// plain specs, plus `test:extension` and `test:docs` as concurrent siblings.
// Output is buffered per-job and printed under fixed headers so the
// failure-summary reporter stays intact and non-interleaved.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const REPORTER_MARKER = "--test-reporter ./test/failure-summary-reporter.mjs ";
const PLAIN_SCRIPTS = ["test:assets", "test:scripts", "test:core", "test:dev-loop"];

// Single source of truth: derive the plain spec list from package.json instead
// of hardcoding globs, so the file set stays in lockstep with the test:* scripts.
export function derivePlainSpecs(pkg) {
  const specs = [];
  for (const name of PLAIN_SCRIPTS) {
    const script = pkg.scripts?.[name];
    if (typeof script !== "string") throw new Error(`missing script ${name} in package.json`);
    const idx = script.indexOf(REPORTER_MARKER);
    if (idx === -1) throw new Error(`script ${name} does not use the failure-summary reporter`);
    const tail = script.slice(idx + REPORTER_MARKER.length).trim();
    for (const arg of tail.split(/\s+/)) if (arg) specs.push(arg);
  }
  return specs;
}

// Exit code: 0 iff every job exited 0, otherwise 1.
export function aggregateExit(codes) {
  return codes.every((code) => code === 0) ? 0 : 1;
}

function runJob(label, command, args, options = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => resolve({ label, code: 1, output: `spawn error: ${err.message}\n` }));
    child.on("close", (code) => resolve({ label, code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

async function main() {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
  const specs = derivePlainSpecs(pkg);

  const jobs = await Promise.all([
    runJob("plain", process.execPath, ["--test", "--test-reporter", "./test/failure-summary-reporter.mjs", ...specs]),
    runJob("extension", "npm", ["run", "test:extension"], { shell: true }),
    runJob("docs", "npm", ["run", "test:docs"], { shell: true }),
  ]);

  const order = ["plain", "extension", "docs"];
  const byLabel = new Map(jobs.map((j) => [j.label, j]));
  for (const label of order) {
    const job = byLabel.get(label);
    process.stdout.write(`===== ${label} =====\n`);
    process.stdout.write(job.output);
    if (!job.output.endsWith("\n")) process.stdout.write("\n");
  }

  const failed = order.filter((label) => byLabel.get(label).code !== 0);
  if (failed.length) process.stdout.write(`\nFAILED group(s): ${failed.join(", ")}\n`);
  process.exit(aggregateExit(order.map((label) => byLabel.get(label).code)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
