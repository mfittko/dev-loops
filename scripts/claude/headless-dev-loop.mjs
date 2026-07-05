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
 *   node scripts/claude/headless-dev-loop.mjs [--issue <n> | --pr <n>] [--prompt <text>]
 *                                             [--claude-bin <path>] [--dry-run]
 *
 * --issue/--pr select the target; with neither, the prompt targets the current state.
 * --prompt overrides the generated dev-loop prompt entirely.
 * --claude-bin overrides the `claude` binary path.
 * --dry-run prints the resolved command + the DEVLOOPS_RUN_ID without spawning `claude`
 *   (CI-safe; no API key / `claude` binary required).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ensureRunId } from "@dev-loops/core/loop/run-context";
import {
  buildDevLoopPrompt,
  buildHeadlessClaudeInvocation,
  DEFAULT_CLAUDE_BIN,
} from "@dev-loops/core/claude/headless-entry";

function parseCliArgs(argv) {
  const opts = { dryRun: false, claudeBin: DEFAULT_CLAUDE_BIN };
  const requireValue = (name, token) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return v;
  };

  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      "dry-run": { type: "boolean" },
      issue: { type: "string" },
      pr: { type: "string" },
      "claude-bin": { type: "string" },
      prompt: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw new Error(`unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "dry-run":
        if (token.value !== undefined) {
          throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
        }
        opts.dryRun = true;
        break;
      case "issue":
        opts.issue = requireValue("--issue", token);
        break;
      case "pr":
        opts.pr = requireValue("--pr", token);
        break;
      case "claude-bin":
        opts.claudeBin = requireValue("--claude-bin", token);
        break;
      case "prompt":
        opts.prompt = requireValue("--prompt", token);
        break;
      default:
        throw new Error(`unknown argument: ${token.rawName}`);
    }
  }

  if (opts.issue != null && opts.pr != null) {
    throw new Error("--issue and --pr are mutually exclusive");
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
    return 1;
  }
  const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

  // --dry-run is side-effect-free: mint a run id in-memory without persisting the state file.
  const { runId } = ensureRunId({ env: opts.dryRun ? {} : process.env, root: opts.dryRun ? undefined : repoRoot });
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
