#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERIFY_SUITES = Object.freeze([
  "test:all",
  "test:docs",
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
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, ["run", suite], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => writeAttributed(stdout, suite, chunk));
    child.stderr.on("data", (chunk) => writeAttributed(stderr, suite, chunk));
    let spawnError = null;
    child.on("error", (error) => {
      spawnError = error;
      writeAttributed(stderr, suite, `${error.message}\n`);
    });
    child.on("close", (code) => resolve(spawnError === null ? (code ?? 1) : 1));
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
