#!/usr/bin/env node
// Pinned-source fallback repo-wiki wrapper. Clones mfittko/repo-wiki at a fixed
// commit, installs/builds it locally, and proxies the requested command against
// this repo.
//
// This helper is retained for environments that prefer a pinned source checkout
// over the published npm install path (deterministic source pin, controlled
// GitHub-only network access, offline reproduction after the initial clone).
// It still requires git access to https://github.com/mfittko/repo-wiki.git for
// the initial clone/fetch step.
//
// The primary repo-wiki entrypoint is `scripts/repo-wiki.mjs` (npm-installed).
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../packages/core/src/cli/helpers.mjs";

export const REPO_WIKI_GIT_URL = "https://github.com/mfittko/repo-wiki.git";
export const REPO_WIKI_REF = "d7e772e3d702a75896a6f4eec574a4e4e5bfa6dd";
export const REPO_WIKI_MIN_NODE_MAJOR = 24;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (args.length === 0) {
    return { prepareOnly: false, passthroughArgs: ["--help"] };
  }
  if (args[0] === "prepare") {
    return { prepareOnly: true, passthroughArgs: [] };
  }
  return { prepareOnly: false, passthroughArgs: args };
}

export function resolveRepoWikiPaths(projectRoot = PROJECT_ROOT, ref = REPO_WIKI_REF) {
  const baseDir = path.join(projectRoot, ".tmp", "repo-wiki", ref);
  const sourceDir = path.join(baseDir, "source");
  const cliPath = path.join(sourceDir, "dist", "bin", "repo-wiki.js");
  const buildStampPath = path.join(baseDir, "build-stamp.json");
  return { projectRoot, baseDir, sourceDir, cliPath, buildStampPath };
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < REPO_WIKI_MIN_NODE_MAJOR) {
    throw new Error(
      `repo-wiki local helper requires Node.js ${REPO_WIKI_MIN_NODE_MAJOR}+ because repo-wiki itself requires Node.js ${REPO_WIKI_MIN_NODE_MAJOR}+. Current runtime: ${version}`,
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding ?? "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const printable = [command, ...args].join(" ");
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${printable}`);
  }

  return result;
}

async function readBuildStamp(buildStampPath) {
  try {
    return JSON.parse(await readFile(buildStampPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeBuildStamp(buildStampPath) {
  await writeFile(buildStampPath, JSON.stringify({ ref: REPO_WIKI_REF }, null, 2) + "\n", "utf8");
}

export async function ensureRepoWikiPrepared(projectRoot = PROJECT_ROOT) {
  assertSupportedNodeVersion();
  const { baseDir, sourceDir, cliPath, buildStampPath } = resolveRepoWikiPaths(projectRoot);
  await mkdir(baseDir, { recursive: true });

  let currentHead = null;
  try {
    run("git", ["-C", sourceDir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    currentHead = run("git", ["-C", sourceDir, "rev-parse", "HEAD"], { stdio: "pipe" }).stdout.trim();
  } catch {
    run("git", ["clone", REPO_WIKI_GIT_URL, sourceDir], { cwd: baseDir });
  }

  if (currentHead !== REPO_WIKI_REF) {
    run("git", ["-C", sourceDir, "fetch", "origin", REPO_WIKI_REF, "--depth", "1"]);
    run("git", ["-C", sourceDir, "checkout", "--force", REPO_WIKI_REF]);
  }

  const stamp = await readBuildStamp(buildStampPath);
  if (stamp?.ref !== REPO_WIKI_REF) {
    run("npm", ["install", "--silent"], { cwd: sourceDir });
    run("npm", ["run", "build", "--silent"], { cwd: sourceDir });
    await writeBuildStamp(buildStampPath);
  } else {
    try {
      run(process.execPath, [cliPath, "--help"], { stdio: "ignore" });
    } catch {
      run("npm", ["install", "--silent"], { cwd: sourceDir });
      run("npm", ["run", "build", "--silent"], { cwd: sourceDir });
      await writeBuildStamp(buildStampPath);
    }
  }

  return resolveRepoWikiPaths(projectRoot);
}

// Composable entry point: returns a structured result instead of calling
// process.exit so importers can reuse this wrapper without terminating the host
// process. The direct-run block below owns the process-level exit-code mapping.
export async function runRepoWikiLocal(argv, projectRoot = PROJECT_ROOT) {
  const { prepareOnly, passthroughArgs } = parseCliArgs(argv);
  const { cliPath } = await ensureRepoWikiPrepared(projectRoot);
  if (prepareOnly) {
    return { ok: true, status: 0, prepared: true, cliPath };
  }

  const result = spawnSync(process.execPath, [cliPath, ...passthroughArgs], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return { ok: false, status: result.status ?? 1, cliPath };
  }
  return { ok: true, status: 0, prepared: true, cliPath };
}

if (isDirectCliRun(import.meta.url)) {
  runRepoWikiLocal(process.argv.slice(2)).then((result) => {
    if (!result.ok) {
      process.exitCode = result.status;
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
