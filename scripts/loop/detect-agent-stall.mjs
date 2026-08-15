#!/usr/bin/env node
/**
 * Agent-level stall probe (#1669).
 *
 * Detects whether a dev-loop child (subagent) has stalled — no turn progress
 * for N minutes with no pending supervisor request — while NOT falsely bailing
 * a sanctioned long watch (an active tool call that heartbeats its runner
 * claim). Emits a structured verdict plus a recovery brief for a fresh-context
 * dispatch.
 *
 * Signal sources (all optional where stated):
 *   - Turn progress: the async run's `status.json` `lastActivityAt` /
 *     `lastUpdate`, or the session `session.jsonl` file mtime.
 *   - Sanctioned-watch heartbeat: runner-coordination `activeRun.updatedAt`
 *     (only sanctioned long waits refresh that claim).
 *   - Pending request: explicit `--pending-request` flag or a marker file.
 *
 * Verdict statuses: stalled | not_stalled | no_evidence.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import {
  detectAgentStall,
  resolveAgentStallThresholdMs,
  buildAgentStallRecoveryBrief,
} from "@dev-loops/core/loop/agent-stall";
import { loadRunnerCoordinationState } from "./_pr-runner-coordination.mjs";

const USAGE = `Usage: detect-agent-stall.mjs --repo <owner/name> [--pr <n>] [--status <path> | --session <path>] [--threshold-min <n>] [--pending-request]
Detect whether a dev-loop child has stalled (no turn progress for N minutes, no pending request).
Required:
  --repo <owner/name>   Repository slug (owner/name)
Optional:
  --pr <n>              PR number; enables the sanctioned-watch heartbeat read
                        from runner-coordination state.
  --status <path>       Path to the async run status.json (turn-progress signal).
  --session <path>      Path to a session.jsonl (mtime used as turn signal when --status absent).
  --threshold-min <n>   No-turn-progress window in minutes (default 5).
  --pending-request     Mark the child as blocked on a pending supervisor request (never a stall).
  --pending-marker <path>  Path to a file whose existence marks a pending request.
  --run-id <id>         Async run id (included in the recovery brief).
  --cwd <path>          Worktree directory (included in the recovery brief).
  --last-action <text>  Last known action (included in the recovery brief).
  --help, -h            Show this help.

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;
const parseError = (message) => ({ ok: false, error: message, usage: USAGE });

function parseCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      status: { type: "string" },
      session: { type: "string" },
      "threshold-min": { type: "string" },
      "pending-request": { type: "boolean", default: false },
      "pending-marker": { type: "string" },
      "run-id": { type: "string" },
      cwd: { type: "string" },
      "last-action": { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const opts = {
    repo: null,
    pr: null,
    statusPath: null,
    sessionPath: null,
    thresholdMin: null,
    pendingRequest: false,
    pendingMarker: null,
    runId: null,
    cwd: null,
    lastAction: null,
  };
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      if (token.value !== undefined) {
        throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
      }
      process.stdout.write(USAGE);
      process.exit(0);
    }
    switch (token.name) {
      case "repo": opts.repo = token.value ?? null; break;
      case "pr": opts.pr = token.value ?? null; break;
      case "status": opts.statusPath = token.value ?? null; break;
      case "session": opts.sessionPath = token.value ?? null; break;
      case "threshold-min": opts.thresholdMin = token.value ?? null; break;
      case "pending-request": opts.pendingRequest = true; break;
      case "pending-marker": opts.pendingMarker = token.value ?? null; break;
      case "run-id": opts.runId = token.value ?? null; break;
      case "cwd": opts.cwd = token.value ?? null; break;
      case "last-action": opts.lastAction = token.value ?? null; break;
      default:
        if (matchJqOutputToken(token, opts)) continue;
    }
  }
  return opts;
}

function coercePositiveInt(text) {
  if (text === null || text === undefined) return null;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function readStatusTimestamp(statusPath) {
  if (!statusPath) return null;
  const { readFile } = await import("node:fs/promises");
  let raw;
  try {
    raw = await readFile(statusPath, "utf8");
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = Array.isArray(data)
    ? null
    : [data.lastActivityAt, data.lastUpdate, data.endedAt, data.startedAt]
      .find((v) => typeof v === "number" || (typeof v === "string" && v.trim().length > 0));
  if (candidate === undefined || candidate === null) return null;
  const ms = typeof candidate === "number" ? candidate : Date.parse(candidate);
  return Number.isFinite(ms) ? ms : null;
}

async function readSessionMtime(sessionPath) {
  if (!sessionPath) return null;
  try {
    const s = await stat(sessionPath);
    return Math.floor(s.mtimeMs);
  } catch {
    return null;
  }
}

async function runDetectAgentStall(options) {
  const {
    repo,
    pr,
    statusPath,
    sessionPath,
    thresholdMin,
    pendingRequest,
    pendingMarker,
    runId,
    cwd,
    lastAction,
  } = options;

  if (!repo || typeof repo !== "string") {
    return parseError("detect-agent-stall requires a non-empty repo slug");
  }
  const prNumber = pr === null ? null : coercePositiveInt(pr);
  if (pr !== null && prNumber === null) {
    return parseError(`Invalid PR number: ${JSON.stringify(pr)}`);
  }
  const thresholdMs = resolveAgentStallThresholdMs(coercePositiveInt(thresholdMin));
  const nowMs = Date.now();

  let pending = Boolean(pendingRequest);
  if (!pending && pendingMarker) {
    try {
      const { access } = await import("node:fs/promises");
      await access(pendingMarker);
      pending = true;
    } catch {
      pending = false;
    }
  }

  const turnMs = (await readStatusTimestamp(statusPath)) ?? (await readSessionMtime(sessionPath));

  // Sanctioned-watch heartbeat: runner-coordination activeRun.updatedAt.
  let watchMs = null;
  if (prNumber !== null) {
    const loaded = await loadRunnerCoordinationState({ repo, pr: prNumber, cwd: process.cwd() }).catch(() => null);
    const updated = loaded?.state?.activeRun?.updatedAt;
    if (typeof updated === "string" && updated.trim().length > 0) {
      const ms = Date.parse(updated);
      if (Number.isFinite(ms)) watchMs = ms;
    }
  }

  const verdict = detectAgentStall({
    lastActivityAt: turnMs,
    sanctionedWatchAt: watchMs,
    pendingRequest: pending,
    now: nowMs,
    thresholdMs,
  });

  const brief = buildAgentStallRecoveryBrief({
    runId,
    cwd,
    lastAction,
    reason: verdict.reason,
  });

  return {
    ok: true,
    repo,
    pr: prNumber,
    checkedAt: new Date(nowMs).toISOString(),
    status: verdict.status,
    stalled: verdict.stalled,
    reason: verdict.reason,
    thresholdMs: verdict.thresholdMs,
    thresholdMinutes: Math.floor(verdict.thresholdMs / 60000),
    turnAgeMs: verdict.turnAgeMs,
    watchAgeMs: verdict.watchAgeMs,
    pendingRequest: pending,
    sources: {
      turnSignal: turnMs !== null ? new Date(turnMs).toISOString() : null,
      watchHeartbeat: watchMs !== null ? new Date(watchMs).toISOString() : null,
    },
    recoveryBrief: brief.brief,
  };
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(JSON.stringify(parseError(error instanceof Error ? error.message : String(error))));
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = await runDetectAgentStall(options);
  } catch (error) {
    result = parseError(error instanceof Error ? error.message : String(error));
  }
  const code = emitResult(result, { jq: options.jq ?? undefined, silent: options.silent ?? false });
  process.exitCode = code;
}

main();
