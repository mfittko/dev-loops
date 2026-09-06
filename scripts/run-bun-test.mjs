#!/usr/bin/env bun

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const ALL_TEST_PATTERNS = Object.freeze([
  "test/**/*.test.mjs",
  "packages/core/test/*.test.mjs",
  "skills/dev-loop/scripts/*.test.mjs",
]);

export function resolveBunTestParallelism(env = process.env) {
  const raw = env.BUN_TEST_PARALLELISM;
  if (raw === undefined || raw === "") return 8;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("BUN_TEST_PARALLELISM must be a positive integer");
  return value;
}

export function buildBunTestArgs(args, env = process.env) {
  return ["test", "--only-failures", `--parallel=${resolveBunTestParallelism(env)}`, "--no-isolate", ...args];
}

export async function discoverRepositoryTests(repoRoot = DEFAULT_ROOT) {
  const files = (await Promise.all(ALL_TEST_PATTERNS.map((pattern) =>
    Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: repoRoot, onlyFiles: true }))))).flat().sort();
  const duplicate = files.find((file, index) => index > 0 && file === files[index - 1]);
  if (duplicate) throw new Error(`Duplicate Bun test inventory entry: ${duplicate}`);
  return files;
}

export async function resolveBunTestFiles(args, { discover = discoverRepositoryTests } = {}) {
  if (!args.includes("--all")) return args;
  if (args.filter((arg) => arg === "--all").length > 1) throw new Error("--all may be supplied only once");
  return [...args.filter((arg) => arg !== "--all"), ...await discover()];
}

export function childResult(child) {
  return new Promise((resolve) => {
    let error;
    child.once("error", (value) => { error = value; });
    child.once("close", (code) => resolve({ code: code ?? 1, error }));
  });
}

export async function runBunTest(args, { env = process.env, command = env.BUN_BIN || process.execPath, spawnImpl = spawn } = {}) {
  const child = spawnImpl(command, buildBunTestArgs(await resolveBunTestFiles(args), env), { env, stdio: "inherit" });
  const result = await childResult(child);
  if (result.error) throw result.error;
  return result.code;
}

if (import.meta.main) {
  try { process.exitCode = await runBunTest(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; }
}
