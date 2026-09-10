#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import { discoverRepositoryTests, resolveBunTestParallelism, runBunTest } from "./run-bun-test.mjs";

const TIMINGS_PATH = ".bun-test-timings.json";
const execFileAsync = promisify(execFile);

export async function refreshTestTimings({
  env = process.env,
  runTests = runBunTest,
  readText = (file) => readFile(file, "utf8"),
  writeText = writeFile,
  renameFile = rename,
  removeFile = (file) => rm(file, { force: true }),
  resolveInventory = discoverRepositoryTests,
  resolveCommit = async () => (await execFileAsync("git", ["rev-parse", "HEAD"], { env })).stdout.trim(),
  tempPath = `${TIMINGS_PATH}.tmp-${process.pid}-${Date.now()}`,
} = {}) {
  const inventory = await resolveInventory();
  const existing = JSON.parse(await readText(TIMINGS_PATH));
  existing.files = Object.fromEntries(inventory.map((file) => [file, existing.files?.[file] ?? 0]));
  await writeText(tempPath, `${JSON.stringify(existing)}\n`, "utf8");
  try {
    const exitCode = await runTests([`--timings=${tempPath}`, "--update-timings", "--all"], { env: { ...env, BUN_TEST_TIMINGS_PATH: tempPath } });
    if (exitCode !== 0) return exitCode;

    const profile = JSON.parse(await readText(tempPath));
    const profiledFiles = Object.keys(profile.files ?? {}).sort();
    if (JSON.stringify(profiledFiles) !== JSON.stringify(inventory)) {
      throw new Error("Refreshed timing profile does not exactly match the canonical test inventory");
    }
    profile.provenance = {
      bunVersion: Bun.version,
      sourceCommit: await resolveCommit(),
      platform: `${process.platform}-${process.arch}`,
      osRelease: os.release(),
      parallelism: resolveBunTestParallelism(env),
      method: "complete canonical inventory, one Bun worker queue, --no-isolate, --update-timings",
    };
    await writeText(tempPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await renameFile(tempPath, TIMINGS_PATH);
    return 0;
  } finally {
    await removeFile(tempPath);
  }
}

if (import.meta.main) {
  process.exitCode = await refreshTestTimings();
}
