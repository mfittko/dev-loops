#!/usr/bin/env node
/**
 * claude-launch
 *
 * Starts Claude Code with the `.devloops` `extraTools` entries delivered to the configured roles
 * through a session-scoped `--agents` render, plus `--allowedTools`. With no `extraTools` entry
 * it runs `claude` with the passthrough args only.
 *
 * Usage: dev-loops loop claude-launch [--dry-run] [--claude-bin <path>] [-- <claude args>]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDevLoopConfig } from "@dev-loops/core/config";
import { buildClaudeLaunch, DEFAULT_CLAUDE_BIN } from "@dev-loops/core/claude/headless-entry";

const argv = process.argv.slice(2);
const fail = (error) => {
  process.stderr.write(JSON.stringify({ ok: false, error }) + "\n");
  process.exit(1);
};

const USAGE = "Usage: dev-loops loop claude-launch [--dry-run] [--claude-bin <path>] [-- <claude args>]\n";
let dryRun = false;
let claudeBin = DEFAULT_CLAUDE_BIN;
// Own flags come first; the first other token (or `--`, which a runtime may consume) starts the claude args.
let i = 0;
for (; i < argv.length; i += 1) {
  if (argv[i] === "--help" || argv[i] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (argv[i] === "--dry-run") dryRun = true;
  else if (argv[i] === "--claude-bin") {
    if (!argv[i + 1]) fail("--claude-bin requires a path");
    claudeBin = argv[++i];
  } else break;
}
const passthroughArgs = argv[i] === "--" ? argv.slice(i + 1) : argv.slice(i);

const result = await loadDevLoopConfig({ cwd: process.cwd() });
if (result.errors?.length > 0) fail(`invalid .devloops config: ${result.errors.map((e) => e.message ?? JSON.stringify(e)).join("; ")}`);
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const { command, args, env } = buildClaudeLaunch({ config: result.config ?? result, repoRoot, passthroughArgs, claudeBin });

if (dryRun) {
  process.stdout.write(JSON.stringify({ ok: true, dryRun: true, command, args, DEVLOOPS_AGENT_OVERRIDES: env.DEVLOOPS_AGENT_OVERRIDES ?? null }, null, 2) + "\n");
  process.exit(0);
}
const res = spawnSync(command, args, { env, stdio: "inherit" });
if (res.error) fail(`failed to spawn ${command}: ${res.error.message}`);
process.exit(res.status ?? 1);
