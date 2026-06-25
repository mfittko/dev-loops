#!/usr/bin/env node
import process from "node:process";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { resolveRunId as resolveEnvRunId } from "@dev-loops/core/loop/run-context";
import {
  assertRunnerOwnership,
  claimRunnerOwnership,
  loadRunnerCoordinationState,
  releaseRunnerOwnership,
} from "./_pr-runner-coordination.mjs";
const USAGE = `Usage:
  pr-runner-coordination.mjs status --repo <owner/name> --pr <number>
  pr-runner-coordination.mjs claim --repo <owner/name> --pr <number> [--run-id <id>]
  pr-runner-coordination.mjs takeover --repo <owner/name> --pr <number> [--run-id <id>]
  pr-runner-coordination.mjs assert --repo <owner/name> --pr <number> [--run-id <id>] [--require-existing]
  pr-runner-coordination.mjs release --repo <owner/name> --pr <number> [--run-id <id>]
Durable one-runner-per-PR coordination helper.
If --run-id is omitted for claim/assert/release/takeover, DEVLOOPS_RUN_ID is used
(falling back to the PI_SUBAGENT_RUN_ID alias).
Output:
  stdout: { "ok": true, ... }
  stderr: { "ok": false, "error": "...", ... }
Exit codes:
  0  Success / clean stop-compatible result
  1  Argument error or coordination conflict`.trim();
const parseError = buildParseError(USAGE);
function parseCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    command: null,
    repo: undefined,
    pr: undefined,
    runId: undefined,
    requireExisting: false,
  };
  const command = args.shift();
  if (command === undefined || command === "--help" || command === "-h") {
    options.help = true;
    return options;
  }
  options.command = command;
  const { tokens } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "run-id": { type: "string" },
      "require-existing": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "run-id") {
      options.runId = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "require-existing") {
      options.requireExisting = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const validCommands = new Set(["status", "claim", "takeover", "assert", "release"]);
  if (!validCommands.has(options.command)) {
    throw parseError(`Unknown subcommand: ${options.command}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("pr-runner-coordination requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function resolveRunId(explicitRunId, env) {
  return typeof explicitRunId === "string" && explicitRunId.trim().length > 0
    ? explicitRunId.trim()
    : resolveEnvRunId(env);
}
export async function runPrRunnerCoordination(options, { env = process.env, cwd = process.cwd() } = {}) {
  if (options.command === "status") {
    const { filePath, state } = await loadRunnerCoordinationState({ repo: options.repo, pr: options.pr, cwd });
    return {
      ok: true,
      command: "status",
      repo: options.repo.trim().toLowerCase(),
      pr: options.pr,
      filePath,
      state,
    };
  }
  const runId = resolveRunId(options.runId, env);
  if (options.command === "claim") {
    return claimRunnerOwnership({ repo: options.repo, pr: options.pr, runId, mode: "claim", cwd });
  }
  if (options.command === "takeover") {
    return claimRunnerOwnership({ repo: options.repo, pr: options.pr, runId, mode: "takeover", cwd });
  }
  if (options.command === "assert") {
    return assertRunnerOwnership({
      repo: options.repo,
      pr: options.pr,
      runId,
      requireExisting: options.requireExisting,
      cwd,
    });
  }
  if (options.command === "release") {
    return releaseRunnerOwnership({ repo: options.repo, pr: options.pr, runId, cwd });
  }
  throw new Error(`Unhandled runner coordination command: ${options.command}`);
}
async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      return;
    }
    const result = await runPrRunnerCoordination(options, { env: process.env });
    if (!result.ok) {
      console.error(JSON.stringify(result));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    const payload = formatCliError(error, { usage: USAGE });
    console.error(JSON.stringify(payload));
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
