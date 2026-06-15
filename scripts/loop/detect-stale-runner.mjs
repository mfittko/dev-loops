#!/usr/bin/env node
import process from "node:process";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireOptionValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  detectStaleRunner,
  STALE_RUNNER_ERROR,
} from "./_stale-runner-detection.mjs";
const USAGE = `Usage: detect-stale-runner.mjs --repo <owner/name> --pr <number>
Detect whether the active runner for a PR is stale or has received an exit
signal. Fails closed with status "stale_runner" or "exit_signal_recorded" so
the pre-merge guard can refuse to proceed.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --stale-runner-max-age-ms <ms>
                        Override the staleness threshold (default 30 minutes,
                        or $PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS).
  --run-id <id>         Override the active run id (default: read from
                        PI_SUBAGENT_RUN_ID). When supplied, the detector
                        additionally verifies the current run id is still
                        the active owner.
Output (stdout, JSON; always includes staleRunnerCheck):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 17,
    "status": "fresh_runner",
    "activeRun": { "runId": "...", "claimedAt": "...", "updatedAt": "..." },
    "staleRunnerCheck": {
      "ok": true,
      "failures": []
    }
  }
  or on failure:
  {
    "ok": false,
    "error": "stale_runner" | "exit_signal_recorded",
    "message": "...",
    "staleRunnerCheck": {
      "ok": false,
      "failures": ["stale runner: run X claimed N ms ago, last updated M ms ago (max age K ms)"]
    }
  }
Exit codes:
  0  Success / fresh runner / no owner record
  1  Argument error or stale/exit-signal condition detected`.trim();
const parseError = buildParseError(USAGE);
function parseCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    staleRunnerMaxAgeMs: undefined,
    runId: undefined,
  };
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
    if (token === "--stale-runner-max-age-ms") {
      const raw = requireOptionValue(args, "--stale-runner-max-age-ms", parseError).trim();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw parseError(`--stale-runner-max-age-ms must be a positive integer (ms), got: ${raw}`);
      }
      options.staleRunnerMaxAgeMs = Math.floor(parsed);
      continue;
    }
    if (token === "--run-id") {
      options.runId = requireOptionValue(args, "--run-id", parseError).trim();
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-stale-runner requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function resolveRunId(explicitRunId, env) {
  if (typeof explicitRunId === "string" && explicitRunId.trim().length > 0) {
    return explicitRunId.trim();
  }
  if (typeof env?.PI_SUBAGENT_RUN_ID === "string" && env.PI_SUBAGENT_RUN_ID.trim().length > 0) {
    return env.PI_SUBAGENT_RUN_ID.trim();
  }
  return null;
}
function buildStaleRunnerCheck(detection) {
  if (detection.status === "no_owner_record") {
    return {
      ok: true,
      failures: [],
    };
  }
  if (detection.status === "exit_signal_recorded") {
    return {
      ok: false,
      failures: [`exit signal recorded for run ${detection.activeRun?.runId ?? "unknown"}: refuse to merge`],
    };
  }
  if (detection.status === "stale_runner") {
    return {
      ok: false,
      failures: [
        `stale runner: run ${detection.staleRunner.runId} claimed ${detection.staleRunner.claimedAgeMs}ms ago, last updated ${detection.staleRunner.updatedAgeMs}ms ago (max age ${detection.staleRunner.maxAgeMs}ms)`,
      ],
    };
  }
  return { ok: true, failures: [] };
}
export async function runDetectStaleRunner(options, { env = process.env, cwd = process.cwd() } = {}) {
  const detection = await detectStaleRunner({
    repo: options.repo,
    pr: options.pr,
    maxAgeMs: options.staleRunnerMaxAgeMs,
    cwd,
  });
  const explicitRunId = resolveRunId(options.runId, env);
  const ownershipLost = explicitRunId !== null
    && detection.activeRun !== null
    && detection.activeRun.runId !== explicitRunId;
  const ownershipMissing = explicitRunId !== null && detection.activeRun === null;
  const staleRunnerCheck = buildStaleRunnerCheck(detection);
  if (ownershipMissing) {
    return {
      ok: false,
      error: "ownership_lost",
      repo: options.repo.trim().toLowerCase(),
      pr: options.pr,
      status: "ownership_lost",
      activeRun: null,
      runId: explicitRunId,
      exitSignals: [],
      filePath: detection.filePath,
      maxAgeMs: detection.maxAgeMs,
      message: `Stale-runner check: run ${explicitRunId} is no longer the active owner of ${options.repo}#${options.pr}; no active owner record exists.`,
      staleRunnerCheck: {
        ok: false,
        failures: [`ownership_lost: no active owner record exists; run ${explicitRunId} is not the owner`],
      },
    };
  }
  if (ownershipLost) {
    return {
      ok: false,
      error: "ownership_lost",
      repo: options.repo.trim().toLowerCase(),
      pr: options.pr,
      status: "ownership_lost",
      activeRun: detection.activeRun,
      runId: explicitRunId,
      exitSignals: detection.exitSignal?.signals ?? [],
      filePath: detection.filePath,
      maxAgeMs: detection.maxAgeMs,
      message: `Stale-runner check: run ${explicitRunId} is no longer the active owner of ${options.repo}#${options.pr}; current owner is ${detection.activeRun?.runId}.`,
      staleRunnerCheck: {
        ok: false,
        failures: [`ownership_lost: active owner is ${detection.activeRun?.runId ?? "unknown"}, not ${explicitRunId}`],
      },
    };
  }
  if (detection.status === "exit_signal_recorded") {
    return {
      ok: false,
      error: STALE_RUNNER_ERROR.EXIT_SIGNAL_RECORDED,
      repo: options.repo.trim().toLowerCase(),
      pr: options.pr,
      status: "exit_signal_recorded",
      activeRun: detection.activeRun,
      runId: explicitRunId,
      exitSignals: detection.exitSignal?.signals ?? [],
      filePath: detection.filePath,
      maxAgeMs: detection.maxAgeMs,
      message: detection.message,
      staleRunnerCheck,
    };
  }
  if (detection.status === "stale_runner") {
    return {
      ok: false,
      error: STALE_RUNNER_ERROR.STALE_RUNNER,
      repo: options.repo.trim().toLowerCase(),
      pr: options.pr,
      status: "stale_runner",
      activeRun: detection.activeRun,
      runId: explicitRunId,
      exitSignals: [],
      staleRunner: detection.staleRunner,
      filePath: detection.filePath,
      maxAgeMs: detection.maxAgeMs,
      message: detection.message,
      staleRunnerCheck,
    };
  }
  return {
    ok: true,
    repo: options.repo.trim().toLowerCase(),
    pr: options.pr,
    status: detection.status,
    activeRun: detection.activeRun,
    runId: explicitRunId,
    exitSignals: [],
    filePath: detection.filePath,
    maxAgeMs: detection.maxAgeMs,
    staleRunnerCheck,
  };
}
async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      return;
    }
    const result = await runDetectStaleRunner(options, { env: process.env });
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
