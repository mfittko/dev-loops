#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_PARALLELISM = 8;

export function resolveBunTestParallelism(env = process.env) {
  const raw = env.BUN_TEST_PARALLELISM;
  if (raw === undefined || raw === "") return DEFAULT_PARALLELISM;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("BUN_TEST_PARALLELISM must be a positive integer");
  }
  return value;
}

export function buildBunTestArgs(args, env = process.env) {
  return [
    "test",
    "--only-failures",
    `--parallel=${resolveBunTestParallelism(env)}`,
    ...args,
  ];
}

export function runBunTest(args, {
  env = process.env,
  command = env.BUN_BIN || process.execPath,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, buildBunTestArgs(args, env), {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await runBunTest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
