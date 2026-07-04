#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const USAGE = `Usage: detect-copilot-session-activity.mjs --repo <owner/name> --branch <name> [--limit <number>]
Detect Copilot GitHub Actions session activity on a branch.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --branch <name>       Branch to inspect workflow runs on
Optional:
  --limit <number>      Number of recent runs to inspect (default: 20)
Activity values:
  active      Matching Copilot workflow run is currently in progress
  concluded   Most recent matching Copilot workflow run completed, or the latest
              matching run is approval-gated in "action_required" and should be
              treated as a non-blocking observational signal
  idle        No matching Copilot workflow run found on this branch
Success output (stdout, JSON):
  {
    "ok": true,
    "activity": "active"|"concluded"|"idle",
    "runId": 123456|null,
    "runName": "..."|null,
    "runStatus": "queued"|"in_progress"|"pending"|"requested"|"waiting"|"action_required"|"completed"|null,
    "runConclusion": string|null,
    "runCreatedAt": "..."|null,
    "branch": "...",
    "confidence": "high"
  }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}`.trim();
const DEFAULT_LIMIT = 20;
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "pending", "requested", "waiting"]);
const COPILOT_RUN_NAME_PATTERNS = Object.freeze([
  /^copilot coding for issue\b/i,
  /^addressing comment on pr\b/i,
  /^addressing review on pr\b/i,
]);
const parseError = buildParseError(USAGE);
export function parseDetectCopilotSessionActivityCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    branch: undefined,
    limit: DEFAULT_LIMIT,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      branch: { type: "string" },
      limit: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
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
    if (token.name === "branch") {
      options.branch = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "limit") {
      options.limit = parsePositiveInteger(requireTokenValue(token, parseError), "--limit", parseError);
      continue;
    }
    if (token.name === "jq") {
      options.jq = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.branch === undefined || options.branch.length === 0) {
    throw parseError("detect-copilot-session-activity requires both --repo <owner/name> and --branch <name>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function isCopilotRunName(name) {
  if (typeof name !== "string") {
    return false;
  }
  return COPILOT_RUN_NAME_PATTERNS.some((pattern) => pattern.test(name.trim()));
}
function normalizeRun(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!isCopilotRunName(name)) {
    return null;
  }
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : null;
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  return {
    runId: Number.isInteger(raw.databaseId) ? raw.databaseId : null,
    runName: name,
    runStatus: typeof raw.status === "string" ? raw.status : null,
    runConclusion: typeof raw.conclusion === "string" && raw.conclusion.length > 0 ? raw.conclusion : null,
    runCreatedAt: createdAt,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Number.NEGATIVE_INFINITY,
  };
}
function compareRunsNewestFirst(left, right) {
  if (left.createdAtMs !== right.createdAtMs) {
    return right.createdAtMs - left.createdAtMs;
  }
  return (right.runId ?? Number.NEGATIVE_INFINITY) - (left.runId ?? Number.NEGATIVE_INFINITY);
}
function toActivityPayload(activity, branch, run = null) {
  return {
    ok: true,
    activity,
    runId: run?.runId ?? null,
    runName: run?.runName ?? null,
    runStatus: run?.runStatus ?? null,
    runConclusion: run?.runConclusion ?? null,
    runCreatedAt: run?.runCreatedAt ?? null,
    branch,
    confidence: "high",
  };
}
function isApprovalGatedActionRequired(run) {
  const status = String(run?.runStatus ?? "").trim().toLowerCase();
  const conclusion = String(run?.runConclusion ?? "").trim().toLowerCase();
  return status === "action_required" || conclusion === "action_required";
}
export async function detectCopilotSessionActivity({ repo, branch, limit = DEFAULT_LIMIT }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    [
      "run",
      "list",
      "--repo",
      repo,
      "--branch",
      branch,
      "--limit",
      String(limit),
      "--json",
      "databaseId,name,status,conclusion,createdAt",
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  const runs = (Array.isArray(payload) ? payload : [])
    .map(normalizeRun)
    .filter(Boolean)
    .sort(compareRunsNewestFirst);
  if (runs.length > 0) {
    const latest = runs[0];
    const latestStatus = String(latest.runStatus ?? "").toLowerCase();
    if (isApprovalGatedActionRequired(latest)) {
      return toActivityPayload("concluded", branch, latest);
    }
    if (ACTIVE_RUN_STATUSES.has(latestStatus)) {
      return toActivityPayload("active", branch, latest);
    }
    return toActivityPayload("concluded", branch, latest);
  }
  return toActivityPayload("idle", branch);
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseDetectCopilotSessionActivityCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await detectCopilotSessionActivity(options, { env, ghCommand });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
