#!/usr/bin/env node
import { runConductorCycle } from "./run-conductor-cycle.mjs";
import { runConductorMonitor } from "./conductor-monitor.mjs";
import { requireOptionValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  loadDevLoopConfig,
  resolveWorkflowConfig,
  resolveAutonomyStopAt,
  resolveGateConfig,
} from "@dev-loops/core/config";
import { readFileSync } from "node:fs";
import path from "node:path";
const USAGE = `Usage: conductor.mjs --repo <owner/name> [--auto-resume] [--cycle-only] [--monitor-only] [--require-retrospective]
Unified conductor entrypoint for dev-loop lifecycle orchestration.`.trim();
const parseError = buildParseError(USAGE);
function checkRetrospectiveGate(cwd, requireRetrospective) {
  if (!requireRetrospective) return { blocked: false };
  try {
    const checkpointPath = path.join(cwd, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpointText = readFileSync(checkpointPath, "utf8");
    const checkpoint = JSON.parse(checkpointText);
    const state = typeof checkpoint?.state === "string" ? checkpoint.state.trim().toLowerCase() : null;
    if (state === "none" || state === "complete" || state === "skipped") {
      return { blocked: false };
    }
    if (state === "required" || state === "missing" || state === null || state === "") {
      return {
        blocked: true,
        reason: state === "required" || state === "missing"
          ? `Retrospective checkpoint pending (state: ${state}). Complete the retrospective before running the conductor.`
          : "Retrospective checkpoint file exists but has an unrecognized or empty state; cannot determine retrospective status safely.",
      };
    }
    return {
      blocked: true,
      reason: `Retrospective checkpoint has an unrecognized state: "${state}".`,
    };
  } catch (err) {
    if (err?.code === "ENOENT") return { blocked: false };
    return { blocked: true, reason: `Cannot read retrospective checkpoint: ${err.message}` };
  }
}
function parseCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    autoResume: false,
    cycleOnly: false,
    monitorOnly: false,
    requireRetrospective: false,
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
    if (token === "--auto-resume") {
      options.autoResume = true;
      continue;
    }
    if (token === "--cycle-only") {
      options.cycleOnly = true;
      continue;
    }
    if (token === "--monitor-only") {
      options.monitorOnly = true;
      continue;
    }
    if (token === "--require-retrospective") {
      options.requireRetrospective = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined) {
    throw parseError("conductor requires --repo <owner/name>");
  }
  if (options.cycleOnly && options.monitorOnly) {
    throw parseError("--cycle-only and --monitor-only are mutually exclusive");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
export async function runConductor(options, runtime = {}) {
  const { cycleOnly = false, monitorOnly = false, autoResume = false, requireRetrospective: forceRetrospective = false } = options;
  const cwd = runtime.repoRoot || process.cwd();
  const loadConfig = runtime.loadConfigImpl || loadDevLoopConfig;
  let configLoadResult;
  let requireRetrospective = false;
  let autonomyStopAt = ["merge"];
  let gateConfig = { draft: { requireCi: true }, preApproval: { requireCi: true } };
  try {
    configLoadResult = await loadConfig({ repoRoot: cwd });
    const hasErrors = Array.isArray(configLoadResult.errors) && configLoadResult.errors.length > 0;
    if (hasErrors) {
      configLoadResult = { ...configLoadResult };
    } else {
      const cfg = configLoadResult.config ?? {};
      requireRetrospective = resolveWorkflowConfig(cfg, "requireRetrospective");
      autonomyStopAt = resolveAutonomyStopAt(cfg);
      const draftCfg = resolveGateConfig(cfg, "draft");
      const preApprovalCfg = resolveGateConfig(cfg, "preApproval");
      gateConfig = {
        draft: { requireCi: draftCfg.requireCi },
        preApproval: { requireCi: preApprovalCfg.requireCi },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    configLoadResult = { config: null, warnings: [], errors: [{ path: "<config>", message: `Failed to load config: ${errorMessage}`, layer: "merged" }] };
  }
  const effectiveRequireRetrospective = forceRetrospective || requireRetrospective;
  const retroGate = checkRetrospectiveGate(cwd, effectiveRequireRetrospective);
  if (retroGate.blocked) {
    return {
      ok: false,
      error: retroGate.reason,
      repo: options.repo,
      blockedByRetrospective: true,
      checkedAt: new Date().toISOString(),
    };
  }
  const runCycle = !monitorOnly;
  const runMonitor = !cycleOnly;
  const cycleResult = runCycle
    ? await runConductorCycle({ repo: options.repo, autonomyStopAt, gateConfig }, runtime).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;
  const monitorResult = runMonitor
    ? await runConductorMonitor({ repo: options.repo, autoResume }, runtime).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    : null;
  const cycleOk = cycleResult?.ok === true;
  const monitorOk = monitorResult?.ok === true;
  return {
    ok: (runCycle ? cycleOk : true) && (runMonitor ? monitorOk : true),
    repo: options.repo,
    checkedAt: new Date().toISOString(),
    cycle: cycleResult ?? null,
    monitor: monitorResult ?? null,
    cycleOk,
    monitorOk,
    config: {
      requireRetrospective: effectiveRequireRetrospective,
      configRequireRetrospective: requireRetrospective,
      autonomyStopAt,
      gateConfig,
      configErrors: configLoadResult?.errors?.length ?? 0,
    },
    summary: {
      totalPrs: (cycleResult?.prCount ?? 0) || (monitorResult?.prCount ?? 0),
      cycleActions: cycleResult?.actions?.length ?? 0,
      needsSubagent: cycleResult?.summary?.needsSubagent ?? 0,
      readyToMerge: cycleResult?.summary?.readyToMerge ?? 0,
      waiting: cycleResult?.summary?.waiting ?? 0,
      blocked: cycleResult?.summary?.blocked ?? 0,
      done: cycleResult?.summary?.done ?? 0,
      errors: cycleResult?.summary?.errors ?? 0,
      queueStatus: monitorResult?.queueStatus ?? "unknown",
      needsAttentionCount: monitorResult?.needsAttentionCount ?? 0,
      orphanedPrCount: monitorResult?.orphanedPrCount ?? 0,
      resumePlanCount: monitorResult?.resumePlanCount ?? 0,
      manualAttentionCount: monitorResult?.manualAttentionCount ?? 0,
    },
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
    cwd = process.cwd(),
  } = {},
) {
  const options = parseCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runConductor(options, {
    env,
    ghCommand,
    repoRoot: cwd,
  });
  if (result.ok === false) {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
