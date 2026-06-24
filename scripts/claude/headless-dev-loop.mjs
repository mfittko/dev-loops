#!/usr/bin/env node
/**
 * Headless dev-loop entry for Claude Code (#775).
 *
 * Runs the dev-loop non-interactively via `claude -p` (the Claude Agent SDK headless path),
 * with the repo's `.claude/settings.json` hooks (gate + read-only guard, #773) active. It mints
 * a neutral DEVLOOPS_RUN_ID (CA2) and propagates it into the spawned `claude` env so the headless
 * session is recognized as the dev-loop subagent context by the write-guard.
 *
 * Usage:
 *   node scripts/claude/headless-dev-loop.mjs --issue <n> [--pr <n>] [--claude-bin <path>] [--dry-run]
 *
 * --dry-run prints the resolved command + the DEVLOOPS_RUN_ID without spawning `claude`
 *   (CI-safe; no API key / `claude` binary required).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRunId } from "@dev-loops/core/loop/run-context";
import {
  buildDevLoopPrompt,
  buildHeadlessClaudeInvocation,
  DEFAULT_CLAUDE_BIN,
} from "@dev-loops/core/claude/headless-entry";

function parseArgs(argv) {
  const opts = { dryRun: false, claudeBin: DEFAULT_CLAUDE_BIN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--issue") opts.issue = argv[++i];
    else if (a === "--pr") opts.pr = argv[++i];
    else if (a === "--claude-bin") opts.claudeBin = argv[++i];
    else if (a === "--prompt") opts.prompt = argv[++i];
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

  const { runId } = ensureRunId({ env: process.env, root: repoRoot });
  const prompt = opts.prompt ?? buildDevLoopPrompt({ issue: opts.issue, pr: opts.pr });
  const { command, args, env } = buildHeadlessClaudeInvocation({
    prompt,
    runId,
    claudeBin: opts.claudeBin,
  });

  if (opts.dryRun) {
    process.stdout.write(
      JSON.stringify({ ok: true, dryRun: true, command, args, runId, DEVLOOPS_RUN_ID: env.DEVLOOPS_RUN_ID }, null, 2) + "\n",
    );
    return 0;
  }

  const res = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (res.error) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: `failed to spawn ${command}: ${res.error.message}` }) + "\n",
    );
    return 127;
  }
  return res.status ?? 1;
}

process.exit(main(process.argv.slice(2)));
