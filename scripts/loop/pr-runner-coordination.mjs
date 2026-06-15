#!/usr/bin/env node
import process from "node:process";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireOptionValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
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
If --run-id is omitted for claim/assert/release/takeover, PI_SUBAGENT_RUN_ID is used.
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
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    if (token === "--run-id") {
      options.runId = requireOptionValue(args, "--run-id", parseError).trim();
      continue;
    }
    if (token === "--require-existing") {
      options.requireExisting = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
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
    : (typeof env?.PI_SUBAGENT_RUN_ID === "string" && env.PI_SUBAGENT_RUN_ID.trim().length > 0
      ? env.PI_SUBAGENT_RUN_ID.trim()
      : null);
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
