#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { childResult } from "./run-bun-test.mjs";

export const VERIFY_SUITES = Object.freeze(["test:all", "test:docs", "test:workflows"]);

export function createAttributedWriter(stream, suite) {
  let pending = "";
  return {
    write(chunk) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) stream.write(`[${suite}] ${line}\n`);
    },
    end() { if (pending) stream.write(`[${suite}] ${pending}\n`); },
  };
}

export function runSuite(suite, {
  cwd = process.cwd(), command = process.env.BUN_BIN || "bun",
  stdout = process.stdout, stderr = process.stderr, spawnImpl = spawn,
} = {}) {
  const child = spawnImpl(command, ["run", suite], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const out = createAttributedWriter(stdout, suite);
  const err = createAttributedWriter(stderr, suite);
  child.stdout.on("data", (chunk) => out.write(chunk));
  child.stderr.on("data", (chunk) => err.write(chunk));
  child.on("error", (error) => err.write(`${error.message}\n`));
  child.on("close", () => { out.end(); err.end(); });
  return childResult(child).then(({ code, error }) => error ? 1 : code);
}

export async function runVerification({ suites = VERIFY_SUITES, execute = runSuite } = {}) {
  const results = await Promise.all(suites.map(async (suite) => ({ suite, exitCode: await execute(suite) })));
  return { ok: results.every(({ exitCode }) => exitCode === 0), results };
}

if (import.meta.main) {
  const result = await runVerification();
  for (const { suite, exitCode } of result.results) process.stderr.write(`[verify] ${suite}: ${exitCode ? `fail (exit ${exitCode})` : "pass"}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
