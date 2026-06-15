#!/usr/bin/env node
// Primary repo-wiki wrapper. Proxies to the published @mfittko/repo-wiki npm package
// at a pinned version, after validating that the consumer-repo config exists.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../packages/core/src/cli/helpers.mjs";

// Pinned to the latest published release at the time this slice was opened.
// Bump deliberately when the consumer repo wants to adopt a newer release.
export const REPO_WIKI_NPM_PACKAGE = "@mfittko/repo-wiki";
export const REPO_WIKI_NPM_VERSION = "0.2.6";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export const REPO_WIKI_MIN_NODE_MAJOR = 20;

export function resolveRepoWikiConfigPath(projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, ".llmwiki", "config.json");
}

export const REPO_WIKI_CONFIG_PATH = resolveRepoWikiConfigPath();
export const REPO_WIKI_SCHEMA_PATH = path.join(PROJECT_ROOT, ".llmwiki", "schema.md");

export function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (args.length === 0) {
    return { passthroughArgs: ["--help"] };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { passthroughArgs: ["--help"] };
  }
  return { passthroughArgs: args };
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < REPO_WIKI_MIN_NODE_MAJOR) {
    throw new Error(
      `repo-wiki npm wrapper requires Node.js ${REPO_WIKI_MIN_NODE_MAJOR}+. Current runtime: ${version}`,
    );
  }
}

export function assertConsumerConfigPresent({
  configPath = REPO_WIKI_CONFIG_PATH,
  projectRoot = PROJECT_ROOT,
} = {}) {
  // When callers override projectRoot without overriding configPath, derive the
  // expected config path from the override so tests and other call sites stay
  // consistent with the per-project layout.
  const resolvedConfigPath =
    configPath === REPO_WIKI_CONFIG_PATH ? resolveRepoWikiConfigPath(projectRoot) : configPath;
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

export function runNpxInvocation({
  command,
  args,
  cwd = PROJECT_ROOT,
  env = process.env,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

// Composable entry point: returns a structured result instead of calling
// process.exit so importers can reuse this wrapper without terminating the host
// process. The direct-run block below owns the process-level exit-code mapping.
export async function runRepoWiki(argv, projectRoot = PROJECT_ROOT) {
  assertSupportedNodeVersion();
  assertConsumerConfigPresent({ projectRoot });
  const { passthroughArgs } = parseCliArgs(argv);
  const invocation = buildNpxInvocation({ passthroughArgs });

  const result = runNpxInvocation({ command: invocation[0], args: invocation.slice(1), cwd: projectRoot });

  if (result.status !== 0) {
    return { ok: false, status: result.status ?? 1, invocation };
  }
  return { ok: true, status: 0, invocation };
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
