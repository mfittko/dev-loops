#!/usr/bin/env node
// Primary repo-wiki wrapper. Proxies to either the published @mfittko/repo-wiki
// npm package (default) or a pinned local source checkout when --source local or
// REPO_WIKI_SOURCE=local is set.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isDirectCliRun } from "@dev-loops/core/cli/helpers";

// Pinned to the latest published release at the time this slice was opened.
export const REPO_WIKI_NPM_PACKAGE = "@mfittko/repo-wiki";
export const REPO_WIKI_NPM_VERSION = "0.2.6";
export const REPO_WIKI_MIN_NODE_MAJOR = 20;

export const REPO_WIKI_GIT_URL = "https://github.com/mfittko/repo-wiki.git";
export const REPO_WIKI_REF = "d7e772e3d702a75896a6f4eec574a4e4e5bfa6dd";
export const REPO_WIKI_LOCAL_MIN_NODE_MAJOR = 24;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const REPO_WIKI_LOCAL_CONFIG_PATH = resolveRepoWikiConfigPath();
export const REPO_WIKI_SCHEMA_PATH = path.join(PROJECT_ROOT, ".llmwiki", "schema.md");

export function resolveRepoWikiConfigPath(projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, ".llmwiki", "config.json");
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < REPO_WIKI_MIN_NODE_MAJOR) {
    throw new Error(
      `repo-wiki npm wrapper requires Node.js ${REPO_WIKI_MIN_NODE_MAJOR}+. Current runtime: ${version}`,
    );
  }
}

export function assertSupportedLocalNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < REPO_WIKI_LOCAL_MIN_NODE_MAJOR) {
    throw new Error(
      `repo-wiki local helper requires Node.js ${REPO_WIKI_LOCAL_MIN_NODE_MAJOR}+ because repo-wiki itself requires Node.js ${REPO_WIKI_LOCAL_MIN_NODE_MAJOR}+. Current runtime: ${version}`,
    );
  }
}

export function assertConsumerConfigPresent({
  configPath = REPO_WIKI_LOCAL_CONFIG_PATH,
  projectRoot = PROJECT_ROOT,
} = {}) {
  const resolvedConfigPath =
    configPath === REPO_WIKI_LOCAL_CONFIG_PATH ? resolveRepoWikiConfigPath(projectRoot) : configPath;
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(
      `Missing required repo-wiki config at ${path.relative(projectRoot, resolvedConfigPath) || resolvedConfigPath}.\n` +
      `This repository expects a checked-in \`.llmwiki/config.json\`. ` +
      `If you deleted it intentionally, restore it from git or regenerate it with \`repo-wiki init --repo .\`.`,
    );
  }
  return resolvedConfigPath;
}

export function buildNpxInvocation({
  packageName = REPO_WIKI_NPM_PACKAGE,
  version = REPO_WIKI_NPM_VERSION,
  passthroughArgs = [],
} = {}) {
  return ["npx", "--yes", `${packageName}@${version}`, ...passthroughArgs];
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
  if (result.status !== 0 && !options.allowNonZero) {
    const printable = [command, ...args].join(" ");
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${printable}`);
  }

  return result;
}

function runNpxInvocation({
  command,
  args,
  cwd = PROJECT_ROOT,
  env = process.env,
} = {}) {
  return run(command, args, { cwd, env, stdio: "inherit", allowNonZero: true });
}

export function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string" },
    },
    strict: false,
  });

  const sourceEnv = process.env.REPO_WIKI_SOURCE;
  const source = values.source || sourceEnv || "npm";

  const passthroughArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--source") {
      i++;
      continue;
    }
    if (a.startsWith("--source=")) continue;
    passthroughArgs.push(a);
  }

  const firstPositional = passthroughArgs.find(a => !a.startsWith("-"));
  if (firstPositional === undefined || firstPositional === "help") {
    return { source, prepareOnly: false, passthroughArgs: ["--help"] };
  }

  if (firstPositional === "prepare") {
    return { source, prepareOnly: true, passthroughArgs: [] };
  }

  return { source, prepareOnly: false, passthroughArgs };
}

export function resolveRepoWikiPaths(projectRoot = PROJECT_ROOT, ref = REPO_WIKI_REF) {
  const baseDir = path.join(projectRoot, ".tmp", "repo-wiki", ref);
  const sourceDir = path.join(baseDir, "source");
  const cliPath = path.join(sourceDir, "dist", "bin", "repo-wiki.js");
  const buildStampPath = path.join(baseDir, "build-stamp.json");
  return { projectRoot, baseDir, sourceDir, cliPath, buildStampPath };
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
  assertSupportedLocalNodeVersion();
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

async function runRepoWikiNpm(passthroughArgs, projectRoot) {
  assertSupportedNodeVersion();
  assertConsumerConfigPresent({ projectRoot });
  const invocation = buildNpxInvocation({ passthroughArgs });
  const result = runNpxInvocation({ command: invocation[0], args: invocation.slice(1), cwd: projectRoot });

  if (result.status !== 0) {
    return { ok: false, status: result.status ?? 1, source: "npm", invocation };
  }
  return { ok: true, status: 0, source: "npm", invocation };
}

async function _runRepoWikiLocal(passthroughArgs, projectRoot) {
  const { cliPath } = await ensureRepoWikiPrepared(projectRoot);
  const result = spawnSync(process.execPath, [cliPath, ...passthroughArgs], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return { ok: false, status: result.status ?? 1, source: "local", cliPath };
  }
  return { ok: true, status: 0, source: "local", cliPath };
}

// Composable entry point: returns a structured result instead of calling
// process.exit so importers can reuse this wrapper without terminating the host
// process. The direct-run block below owns the process-level exit-code mapping.
// Convenience export for callers that explicitly want the pinned source path.
export async function runRepoWikiLocal(argv, projectRoot = PROJECT_ROOT) {
  const args = argv.some((a) => a === "--source" || a.startsWith("--source="))
    ? argv
    : ["--source", "local", ...argv];
  return runRepoWiki(args, projectRoot);
}

export async function runRepoWiki(argv, projectRoot = PROJECT_ROOT) {
  const { source, prepareOnly, passthroughArgs } = parseCliArgs(argv);

  if (source === "local") {
    if (prepareOnly) {
      const { cliPath } = await ensureRepoWikiPrepared(projectRoot);
      return { ok: true, status: 0, source: "local", prepared: true, cliPath };
    }
    return _runRepoWikiLocal(passthroughArgs, projectRoot);
  }

  if (prepareOnly) {
    // prepare is meaningless for the npm source; treat as help.
    return runRepoWikiNpm(["--help"], projectRoot);
  }
  return runRepoWikiNpm(passthroughArgs, projectRoot);
}

if (isDirectCliRun(import.meta.url)) {
  runRepoWiki(process.argv.slice(2)).then((result) => {
    if (!result.ok) {
      process.exitCode = result.status;
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
