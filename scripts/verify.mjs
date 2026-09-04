#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERIFY_SUITES = Object.freeze([
  "test:assets",
  "test:extension",
  "test:scripts",
  "test:core",
  "test:docs",
  "test:pack",
  "test:dev-loop",
  "test:workflows",
]);

function writeAttributed(stream, suite, chunk) {
  const output = chunk.toString();
  for (const line of output.split(/(?<=\n)/)) {
    if (line) stream.write(`[${suite}] ${line}`);
  }
}

export function runSuite(suite, {
  cwd = process.cwd(),
  command = process.env.BUN_BIN || "bun",
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, ["run", suite], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => writeAttributed(stdout, suite, chunk));
    child.stderr.on("data", (chunk) => writeAttributed(stderr, suite, chunk));
    child.on("error", (error) => {
      writeAttributed(stderr, suite, `${error.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runVerification({ suites = VERIFY_SUITES, execute = runSuite } = {}) {
  const results = await Promise.all(suites.map(async (suite) => ({ suite, exitCode: await execute(suite) })));
  return {
    ok: results.every(({ exitCode }) => exitCode === 0),
    results,
  };
}

async function main() {
  const result = await runVerification();
  for (const { suite, exitCode } of result.results) {
    process.stderr.write(`[verify] ${suite}: ${exitCode === 0 ? "pass" : `fail (exit ${exitCode})`}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
