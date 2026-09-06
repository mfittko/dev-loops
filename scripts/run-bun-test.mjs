#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUN_TEST_SUITE_NAMES, resolveTestInventory } from "./test-inventory.mjs";

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
    "--no-isolate",
    ...args,
  ];
}

export async function resolveBunTestFiles(args, { resolveInventory = resolveTestInventory } = {}) {
  const suites = [];
  const passthrough = [];
  for (const arg of args) {
    if (arg.startsWith("--suite=")) {
      suites.push(arg.slice("--suite=".length));
    } else {
      passthrough.push(arg);
    }
  }
  if (suites.length === 0) return passthrough;
  if (suites.includes("all") && suites.length !== 1) {
    throw new Error("--suite=all cannot be combined with another suite");
  }
  const selectedSuites = suites[0] === "all" ? BUN_TEST_SUITE_NAMES : suites;
  return [...passthrough, ...await resolveInventory({ suites: selectedSuites })];
}

export function runBunTest(args, {
  env = process.env,
  command = env.BUN_BIN || process.execPath,
  spawnImpl = spawn,
} = {}) {
  return resolveBunTestFiles(args).then((resolvedArgs) => new Promise((resolve, reject) => {
    const child = spawnImpl(command, buildBunTestArgs(resolvedArgs, env), {
      env,
      stdio: "inherit",
    });
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (spawnError !== null) {
        reject(spawnError);
        return;
      }
      resolve(code ?? 1);
    });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await runBunTest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
