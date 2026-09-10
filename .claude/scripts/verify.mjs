#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const VERIFY_SUITES = Object.freeze(["test:all", "test:docs", "test:workflows"]);

export function createAttributedWriter(stream, suite) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return {
    write(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) stream.write(`[${suite}] ${line}\n`);
    },
    end() { pending += decoder.end(); if (pending) stream.write(`[${suite}] ${pending}\n`); },
  };
}

export function runSuite(suite, {
  cwd = process.cwd(), command = process.env.BUN_BIN || "bun",
  stdout = process.stdout, stderr = process.stderr, spawnImpl = spawn,
} = {}) {
  const child = spawnImpl(command, ["run", suite], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const out = createAttributedWriter(stdout, suite);
  const err = createAttributedWriter(stderr, suite);
  child.stdout?.on("data", (chunk) => out.write(chunk));
  child.stderr?.on("data", (chunk) => err.write(chunk));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      out.end(); err.end(); resolve(code ?? 1);
    };
    child.once("error", (error) => { err.write(`${error.message}\n`); finish(1); });
    child.once("close", finish);
  });
}

export async function runVerification({ suites = VERIFY_SUITES, execute = runSuite, now = () => performance.now() } = {}) {
  const wallStarted = now();
  const results = await Promise.all(suites.map(async (suite) => {
    const started = now();
    const exitCode = await execute(suite);
    return { suite, exitCode, durationMs: now() - started };
  }));
  return { ok: results.every(({ exitCode }) => exitCode === 0), results, wallMs: now() - wallStarted };
}

export function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(2)}s`;
}

if (import.meta.main) {
  const result = await runVerification();
  for (const { suite, exitCode, durationMs } of result.results) process.stderr.write(`[verify] ${suite}: ${exitCode ? `fail (exit ${exitCode})` : "pass"} (${formatDuration(durationMs)})\n`);
  process.stderr.write(`[verify] total: ${result.ok ? "pass" : "fail"} (${formatDuration(result.wallMs)} wall)\n`);
  process.exitCode = result.ok ? 0 : 1;
}
