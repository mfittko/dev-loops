#!/usr/bin/env node
import { existsSync } from "node:fs";
import { access, open, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText, readJsonIfExists } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { autoDetectSnapshot } from "./detect-copilot-loop-state.mjs";
import {
  buildHandoffContractForResumeAction,
  compareHandoffContracts,
  parseRecordedHandoffContract,
} from "./_handoff-contract.mjs";
import { interpretLoopState, summarizeLoopInterpretation } from "@dev-loops/core/loop/copilot-loop-state";
import { listOpenPrs } from "./_loop-pr-aggregation.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const USAGE = `Usage: conductor-monitor.mjs --repo <owner/name> [--auto-resume]
Aggregate Copilot-loop status across all open PRs in one repo.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
Optional:
  --auto-resume         Inspect documented async run artifacts, detect orphaned
                        PR follow-up runs, and emit deterministic resume plans.
Success output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/repo",
    "checkedAt": "...",
    "prCount": 2,
    "queueStatus": "queue_complete"|"monitoring"|"attention_needed",
    "needsAttentionCount": 1,
    "summary": {
      "waiting": 1,
      "needsAttention": 1,
      "blocked": 0,
      "done": 0
    },
    "prs": [
      {
        "number": 17,
        "title": "...",
        "url": "...",
        "isDraft": false,
        "headRefName": "...",
        "authorLogin": "...",
        "state": "waiting_for_copilot_review",
        "nextAction": "...",
        "loopDisposition": "pending",
        "terminal": false,
        "needsAttention": false,
        "snapshot": {
          "ciStatus": "none",
          "copilotReviewRequestStatus": "requested",
          "copilotReviewOnCurrentHead": false,
          "unresolvedThreadCount": 0,
          "actionableThreadCount": 0,
          "copilotReviewRoundCount": 0
        }
      }
    ]
  }
Additional success fields when --auto-resume is present:
  {
    "autoResumeRequested": true,
    "orphanedPrCount": 1,
    "resumePlanCount": 1,
    "manualAttentionCount": 0,
    "resumePlans": [...],
    "needsManualAttention": [...]
  }
Queue status values:
  queue_complete   No open PRs remain in the repo queue
  monitoring       Open PRs exist, but all are in healthy wait states
  attention_needed At least one open PR needs human-in-the-loop follow-up
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, gh failure, or indeterminate PR status
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
const DEFAULT_SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const RUN_STATE = {
  COMPLETED: "completed",
  FAILED: "failed",
  PAUSED: "paused",
  RUNNING: "running",
  QUEUED: "queued",
  UNKNOWN: "unknown",
};
const RESUME_ACTION = {
  NEEDS_FEEDBACK_FIX: "needs_feedback_fix",
  NEEDS_REPLY_RESOLVE: "needs_reply_resolve",
  NEEDS_REREQUEST_OR_WATCH: "needs_rerequest_or_watch",
  AWAIT_FINAL_APPROVAL: "await_final_approval",
  AWAIT_MERGE_AUTHORIZATION: "await_merge_authorization",
  AWAIT_READY_FOR_REVIEW_AUTHORIZATION: "await_ready_for_review_authorization",
  DONE_OR_MERGED: "done_or_merged",
  NEEDS_MANUAL_ATTENTION: "needs_manual_attention",
};
const MANUAL_REASON = {
  AMBIGUOUS_PR_IDENTITY: "ambiguous_pr_identity",
  MISSING_PR_IDENTITY: "missing_pr_identity",
  ARTIFACT_LIVE_STATE_CONFLICT: "artifact_live_state_conflict",
  MISSING_OUTPUT_ARTIFACT: "missing_output_artifact",
  UNCLASSIFIED_ARTIFACT_STATE: "unclassified_artifact_state",
  MULTIPLE_CANDIDATE_RUNS: "multiple_candidate_runs",
  STALE_WORKTREE_MISSING_RESUME_INPUTS: "stale_worktree_missing_resume_inputs",
  HANDOFF_CONTRACT_INCOMPLETE: "handoff_contract_incomplete",
  HANDOFF_CONTRACT_INVALID: "handoff_contract_invalid",
  HANDOFF_CONTRACT_MISMATCH: "handoff_contract_mismatch",
};
function parseCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    autoResume: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      "auto-resume": { type: "boolean" },
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
    if (token.name === "auto-resume") {
      options.autoResume = true;
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
  if (options.repo === undefined) {
    throw parseError("conductor-monitor requires --repo <owner/name>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function summarizePrDisposition(loopDisposition) {
  switch (loopDisposition) {
    case "pending":
      return { bucket: "waiting", needsAttention: false };
    case "blocked":
      return { bucket: "blocked", needsAttention: true };
    case "done":
      return { bucket: "done", needsAttention: false };
    case "unresolved_feedback":
    case "clean_converged":
    case "action_required":
      return { bucket: "needsAttention", needsAttention: true };
    default:
      return { bucket: "needsAttention", needsAttention: true };
  }
}
function buildPrReport(pr, interpretation, interpretationSummary, snapshot) {
  const disposition = summarizePrDisposition(interpretationSummary.loopDisposition);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    headRefName: pr.headRefName,
    authorLogin: pr.authorLogin,
    state: interpretation.state,
    nextAction: interpretation.nextAction,
    loopDisposition: interpretationSummary.loopDisposition,
    terminal: interpretationSummary.terminal,
    needsAttention: disposition.needsAttention,
    bucket: disposition.bucket,
    snapshot: {
      ciStatus: snapshot.ciStatus,
      copilotReviewRequestStatus: snapshot.copilotReviewRequestStatus,
      copilotReviewOnCurrentHead: snapshot.copilotReviewOnCurrentHead,
      unresolvedThreadCount: snapshot.unresolvedThreadCount,
      actionableThreadCount: snapshot.actionableThreadCount,
      copilotReviewRoundCount: snapshot.copilotReviewRoundCount,
    },
  };
}
async function buildPrReports(prs, { repo, env, ghCommand }) {
  const reports = [];
  for (const pr of prs) {
    const snapshot = await autoDetectSnapshot({ repo, pr: pr.number }, { env, ghCommand });
    const interpretation = interpretLoopState(snapshot);
    const interpretationSummary = summarizeLoopInterpretation(interpretation);
    reports.push(buildPrReport(pr, interpretation, interpretationSummary, snapshot));
  }
  return reports;
}
function buildQueueSummary(reports) {
  return reports.reduce((accumulator, pr) => {
    accumulator[pr.bucket] += 1;
    return accumulator;
  }, {
    waiting: 0,
    needsAttention: 0,
    blocked: 0,
    done: 0,
  });
}
function buildBaseResult(repo, reports) {
  const summary = buildQueueSummary(reports);
  const needsAttentionCount = summary.needsAttention + summary.blocked;
  const queueStatus = reports.length === 0
    ? "queue_complete"
    : (needsAttentionCount > 0 ? "attention_needed" : "monitoring");
  return {
    ok: true,
    repo,
    checkedAt: new Date().toISOString(),
    prCount: reports.length,
    queueStatus,
    needsAttentionCount,
    summary,
    prs: reports.map(({ bucket, ...pr }) => pr),
  };
}
function splitPathList(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
async function listDirectoriesIfExists(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}
async function readTextIfExists(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
async function readFirstLineIfExists(filePath, chunkSize = 4096) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  let handle;
  try {
    handle = await open(filePath, "r");
    let position = 0;
    let collected = "";
    while (true) {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) {
        return collected.length > 0 ? collected : null;
      }
      const chunk = buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = chunk.search(/\r?\n/u);
      if (newlineIndex >= 0) {
        return `${collected}${chunk.slice(0, newlineIndex)}`;
      }
      collected += chunk;
      position += bytesRead;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
function normalizeRunState(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case "complete":
    case "completed":
      return RUN_STATE.COMPLETED;
    case "failed":
    case "failure":
    case "error":
      return RUN_STATE.FAILED;
    case "paused":
    case "interrupted":
      return RUN_STATE.PAUSED;
    case "running":
      return RUN_STATE.RUNNING;
    case "queued":
    case "pending":
      return RUN_STATE.QUEUED;
    default:
      return RUN_STATE.UNKNOWN;
  }
}
function normalizeRunStateForPlan(value) {
  const normalized = normalizeRunState(value);
  if (normalized === RUN_STATE.UNKNOWN) {
    return RUN_STATE.COMPLETED;
  }
  return normalized;
}
function isRunningLikeState(value) {
  const normalized = normalizeRunState(value);
  return normalized === RUN_STATE.RUNNING || normalized === RUN_STATE.QUEUED;
}
function isExitedState(value) {
  const normalized = normalizeRunState(value);
  return normalized === RUN_STATE.COMPLETED
    || normalized === RUN_STATE.FAILED
    || normalized === RUN_STATE.PAUSED;
}
function runStatePriority(value) {
  switch (normalizeRunState(value)) {
    case RUN_STATE.RUNNING:
      return 5;
    case RUN_STATE.QUEUED:
      return 4;
    case RUN_STATE.FAILED:
      return 3;
    case RUN_STATE.PAUSED:
      return 2;
    case RUN_STATE.COMPLETED:
      return 1;
    default:
      return 0;
  }
}
function createRunRecord(runId, childIndex = 0) {
  return {
    runId,
    childIndex,
    agent: null,
    runState: RUN_STATE.UNKNOWN,
    cwd: null,
    sessionPath: null,
    statusPath: null,
    eventsPath: null,
    outputLogPath: null,
    outputArtifactPath: null,
    metaPath: null,
    resultPath: null,
    resultSummaryPath: null,
    resultSummaryText: null,
    timestampMs: null,
    evidence: {},
  };
}
function mergeRunRecord(target, patch) {
  const merged = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "evidence") {
      merged.evidence = { ...merged.evidence, ...value };
      continue;
    }
    if (key === "timestampMs") {
      const numeric = Number.isFinite(value) ? value : null;
      if (numeric !== null) {
        merged.timestampMs = merged.timestampMs === null
          ? numeric
          : Math.max(merged.timestampMs, numeric);
      }
      continue;
    }
    if (key === "runState") {
      const normalized = normalizeRunState(value);
      if (runStatePriority(normalized) > runStatePriority(merged.runState)) {
        merged.runState = normalized;
      }
      continue;
    }
    merged[key] = value;
  }
  return merged;
}
function recordKey(runId, childIndex) {
  return `${runId}:${childIndex}`;
}
function parseArtifactFileName(name) {
  const match = name.match(/^(?<runId>.+)_(?<agent>[^_]+)_(?<index>\d+)_(?<kind>meta\.json|output\.md|input\.md)$/u);
  if (!match?.groups) {
    return null;
  }
  return {
    runId: match.groups.runId,
    agent: match.groups.agent,
    childIndex: Number(match.groups.index),
    kind: match.groups.kind,
  };
}
async function scanSessionArtifactRoot(artifactsDir, records) {
  const entries = await readdir(artifactsDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const parsedName = parseArtifactFileName(entry.name);
    if (parsedName === null) {
      continue;
    }
    const { runId, childIndex, agent } = parsedName;
    const key = recordKey(runId, childIndex);
    const record = records.get(key) ?? createRunRecord(runId, childIndex);
    const filePath = path.join(artifactsDir, entry.name);
    if (entry.name.endsWith("_meta.json")) {
      const meta = await readJsonIfExists(filePath).catch(() => null);
      if (meta && typeof meta === "object") {
        records.set(key, mergeRunRecord(record, {
          agent: typeof meta.agent === "string" ? meta.agent : (record.agent ?? agent),
          metaPath: filePath,
          ...(Number.isInteger(meta.exitCode) ? {
            runState: meta.exitCode === 0 ? RUN_STATE.COMPLETED : RUN_STATE.FAILED,
          } : {}),
          timestampMs: typeof meta.timestamp === "number" ? meta.timestamp : null,
          evidence: {
            metaPath: filePath,
            exitCode: Number.isInteger(meta.exitCode) ? meta.exitCode : null,
          },
        }));
      }
      continue;
    }
    if (entry.name.endsWith("_output.md")) {
      records.set(key, mergeRunRecord(record, {
        outputArtifactPath: filePath,
        agent: record.agent ?? agent,
        evidence: { outputArtifactPath: filePath },
      }));
    }
  }
}
async function scanSessionRunRoot(root, records) {
  const topLevelEntries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (topLevelEntries === null) {
    return;
  }
  for (const topLevelEntry of topLevelEntries) {
    if (!topLevelEntry.isDirectory()) {
      continue;
    }
    if (topLevelEntry.name === "subagent-artifacts") {
      await scanSessionArtifactRoot(path.join(root, topLevelEntry.name), records);
      continue;
    }
    const topLevelPath = path.join(root, topLevelEntry.name);
    await scanSessionArtifactRoot(path.join(topLevelPath, "subagent-artifacts"), records).catch(() => {});
    const runIdEntries = await readdir(topLevelPath, { withFileTypes: true }).catch(() => []);
    for (const runIdEntry of runIdEntries) {
      if (!runIdEntry.isDirectory() || runIdEntry.name === "subagent-artifacts") {
        continue;
      }
      const runId = runIdEntry.name;
      const runRoot = path.join(topLevelPath, runId);
      const runDirectories = await readdir(runRoot, { withFileTypes: true }).catch(() => []);
      for (const runDirectory of runDirectories) {
        const indexMatch = runDirectory.name.match(/^run-(\d+)$/u);
        if (!runDirectory.isDirectory() || indexMatch === null) {
          continue;
        }
        const childIndex = Number(indexMatch[1]);
        const sessionPath = path.join(runRoot, runDirectory.name, "session.jsonl");
        const firstLine = await readFirstLineIfExists(sessionPath);
        let header = null;
        if (firstLine) {
          try {
            header = parseJsonText(firstLine);
          } catch {
            header = null;
          }
        }
        const key = recordKey(runId, childIndex);
        const record = records.get(key) ?? createRunRecord(runId, childIndex);
        records.set(key, mergeRunRecord(record, {
          sessionPath,
          cwd: typeof header?.cwd === "string" ? header.cwd : null,
          evidence: { sessionPath },
        }));
      }
    }
  }
}
async function scanAsyncRunRoot(asyncRoot, records) {
  const runDirs = await readdir(asyncRoot, { withFileTypes: true }).catch(() => []);
  for (const runDirEntry of runDirs) {
    if (!runDirEntry.isDirectory()) {
      continue;
    }
    const asyncDir = path.join(asyncRoot, runDirEntry.name);
    const statusPath = path.join(asyncDir, "status.json");
    const eventsPath = path.join(asyncDir, "events.jsonl");
    const status = await readJsonIfExists(statusPath).catch(() => null);
    if (!status || typeof status !== "object") {
      continue;
    }
    const runId = typeof status.runId === "string" && status.runId.trim().length > 0
      ? status.runId.trim()
      : runDirEntry.name;
    const rootState = normalizeRunState(status.state);
    const cwd = typeof status.cwd === "string" ? status.cwd : null;
    const defaultSessionPath = typeof status.sessionFile === "string" ? status.sessionFile : null;
    const baseTimestamp = [status.endedAt, status.lastUpdate, status.lastActivityAt, status.startedAt]
      .find((value) => typeof value === "number");
    const steps = Array.isArray(status.steps) && status.steps.length > 0
      ? status.steps
      : [{
        agent: typeof status.agent === "string" ? status.agent : null,
        status: status.state,
        sessionFile: status.sessionFile,
      }];
    steps.forEach((step, index) => {
      if (typeof step?.agent !== "string" || step.agent !== "dev-loop") {
        return;
      }
      const key = recordKey(runId, index);
      const record = records.get(key) ?? createRunRecord(runId, index);
      const explicitOutputFile = typeof status.outputFile === "string"
        ? status.outputFile
        : path.join(asyncDir, `output-${index}.log`);
      records.set(key, mergeRunRecord(record, {
        agent: step.agent,
        runState: step.status ?? rootState,
        cwd,
        sessionPath: typeof step.sessionFile === "string" ? step.sessionFile : defaultSessionPath,
        statusPath,
        eventsPath,
        outputLogPath: explicitOutputFile,
        timestampMs: typeof baseTimestamp === "number" ? baseTimestamp : null,
        evidence: {
          asyncDir,
          statusPath,
          eventsPath,
          outputLogPath: explicitOutputFile,
        },
      }));
    });
  }
}
function extractResultOutputArtifactPath(result) {
  const value = result?.artifactPaths;
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.outputPath === "string") {
    return value.outputPath;
  }
  if (typeof value.output === "string") {
    return value.output;
  }
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" && entry.endsWith("_output.md")) {
      return entry;
    }
  }
  return null;
}
function parseRunIdFromTextSummary(text, fallbackName) {
  const runLine = text.match(/^Run(?: ID)?:\s*(.+)$/imu);
  if (runLine && typeof runLine[1] === "string" && runLine[1].trim().length > 0) {
    return runLine[1].trim();
  }
  return fallbackName;
}
function parseSummaryPointers(text) {
  const outputArtifactMatch = text.match(/^Output artifact:\s*(.+)$/imu);
  const sessionMatch = text.match(/^Session:\s*(.+)$/imu);
  const stateMatch = text.match(/^State:\s*(.+)$/imu);
  const agentMatch = text.match(/^Agent:\s*(.+)$/imu);
  return {
    outputArtifactPath: outputArtifactMatch?.[1]?.trim() || null,
    sessionPath: sessionMatch?.[1]?.trim() || null,
    runState: stateMatch?.[1]?.trim() || null,
    agent: agentMatch?.[1]?.trim() || null,
  };
}
async function scanAsyncResultRoot(resultsRoot, records) {
  const entries = await readdir(resultsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = path.join(resultsRoot, entry.name);
    if (entry.name.endsWith(".json")) {
      const result = await readJsonIfExists(filePath).catch(() => null);
      if (!result || typeof result !== "object") {
        continue;
      }
      const runId = typeof result.runId === "string" && result.runId.trim().length > 0
        ? result.runId.trim()
        : (typeof result.id === "string" && result.id.trim().length > 0 ? result.id.trim() : null);
      if (runId === null) {
        continue;
      }
      const resultEntries = Array.isArray(result.results) && result.results.length > 0
        ? result.results
        : [{
          agent: typeof result.agent === "string" ? result.agent : null,
          sessionFile: typeof result.sessionFile === "string" ? result.sessionFile : null,
          artifactPaths: result.artifactPaths,
          output: typeof result.summary === "string" ? result.summary : undefined,
        }];
      const baseTimestamp = typeof result.timestamp === "number" ? result.timestamp : null;
      const cwd = typeof result.cwd === "string" ? result.cwd : null;
      resultEntries.forEach((child, index) => {
        if (typeof child?.agent !== "string" || child.agent !== "dev-loop") {
          return;
        }
        const key = recordKey(runId, index);
        const record = records.get(key) ?? createRunRecord(runId, index);
        records.set(key, mergeRunRecord(record, {
          agent: child.agent,
          runState: result.state,
          cwd,
          sessionPath: typeof child.sessionFile === "string" ? child.sessionFile : (typeof result.sessionFile === "string" ? result.sessionFile : null),
          outputArtifactPath: extractResultOutputArtifactPath(child),
          resultPath: filePath,
          resultSummaryText: typeof child.output === "string" ? child.output : (typeof result.summary === "string" ? result.summary : null),
          timestampMs: baseTimestamp,
          evidence: { resultPath: filePath },
        }));
      });
      continue;
    }
    if (!/\.(md|txt)$/iu.test(entry.name)) {
      continue;
    }
    const text = await readTextIfExists(filePath);
    if (text === null || (!text.includes("Output artifact:") && !text.includes("Session:"))) {
      continue;
    }
    const runId = parseRunIdFromTextSummary(text, path.parse(entry.name).name);
    const childIndex = 0;
    const key = recordKey(runId, childIndex);
    const record = records.get(key) ?? createRunRecord(runId, childIndex);
    const pointers = parseSummaryPointers(text);
    records.set(key, mergeRunRecord(record, {
      agent: pointers.agent,
      runState: pointers.runState,
      sessionPath: pointers.sessionPath,
      outputArtifactPath: pointers.outputArtifactPath,
      resultSummaryPath: filePath,
      resultSummaryText: text,
      evidence: { resultSummaryPath: filePath },
    }));
  }
}
function collectConfiguredRoots(explicitRoots, envValue, fallbackRoots) {
  if (Array.isArray(explicitRoots) && explicitRoots.length > 0) {
    return [...new Set(explicitRoots.map((root) => path.resolve(root)))];
  }
  const fromEnv = splitPathList(envValue);
  if (fromEnv.length > 0) {
    return [...new Set(fromEnv.map((root) => path.resolve(root)))];
  }
  return [...new Set((fallbackRoots ?? []).map((root) => path.resolve(root)))];
}
async function detectDefaultAsyncRoots(kind) {
  const tempDir = os.tmpdir();
  const entries = await readdir(tempDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-subagents-"))
    .map((entry) => path.join(tempDir, entry.name, kind))
    .filter((candidate) => existsSync(candidate));
}
async function resolveRepoIsolation(repoRoot) {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const worktreeRoot = path.join(normalizedRepoRoot, "tmp", "worktrees");
  const existingWorktrees = await listDirectoriesIfExists(worktreeRoot);
  return {
    repoRoot: normalizedRepoRoot,
    worktreeRoot,
    worktrees: existingWorktrees.map((entry) => path.resolve(entry)),
  };
}
function isPathWithinRoot(candidate, root) {
  if (typeof candidate !== "string" || typeof root !== "string") {
    return false;
  }
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}
function recordMatchesRepo(record, repoIsolation) {
  if (typeof record.cwd !== "string" || record.cwd.trim().length === 0) {
    return false;
  }
  if (isPathWithinRoot(record.cwd, repoIsolation.repoRoot)) {
    return true;
  }
  if (isPathWithinRoot(record.cwd, repoIsolation.worktreeRoot)) {
    return true;
  }
  return repoIsolation.worktrees.some((worktree) => isPathWithinRoot(record.cwd, worktree));
}
function isStaleWorktreePath(filePath, repoIsolation) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return false;
  }
  if (!isPathWithinRoot(filePath, repoIsolation.worktreeRoot)) {
    return false;
  }
  return !existsSync(filePath);
}
const LOCAL_PHASE_AGENTS = new Set([
  "developer",
  "quality",
  "docs",
  "fixer",
  "refiner",
  "review",
]);
const RUN_STATE_LABELS = Object.freeze({
  queued: RUN_STATE.QUEUED,
  pending: RUN_STATE.QUEUED,
  running: RUN_STATE.RUNNING,
  paused: RUN_STATE.PAUSED,
  interrupted: RUN_STATE.PAUSED,
  completed: RUN_STATE.COMPLETED,
  complete: RUN_STATE.COMPLETED,
  done: RUN_STATE.COMPLETED,
  failed: RUN_STATE.FAILED,
  failure: RUN_STATE.FAILED,
  error: RUN_STATE.FAILED,
});
function normalizeSummaryState(label) {
  return RUN_STATE_LABELS[String(label).trim().toLowerCase()] ?? RUN_STATE.UNKNOWN;
}
function parseLocalSubagentSummary(text, filePath) {
  const agentMatch = text.match(/^[-*]\s*agent(?:\s*name)?:\s*(.+)$/imu);
  const statusMatch = text.match(/^[-*]\s*(?:status|state):\s*(.+)$/imu);
  const runIdMatch = text.match(/^[-*]\s*run(?:\s*id)?:\s*(.+)$/imu);
  const cwdMatch = text.match(/^[-*]\s*(?:cwd|working\s*directory):\s*(.+)$/imu);
  const taskMatch = text.match(/^[-*]\s*(?:task|prompt\s*summary):\s*(.+)$/imu);
  const agent = agentMatch?.[1]?.trim().toLowerCase() ?? null;
  if (agent === null || !LOCAL_PHASE_AGENTS.has(agent)) {
    return null;
  }
  return {
    agent,
    runState: normalizeSummaryState(statusMatch?.[1] ?? ""),
    runId: (runIdMatch?.[1] ?? path.basename(filePath, ".md")).trim(),
    cwd: cwdMatch?.[1]?.trim() ?? null,
    taskSummary: taskMatch?.[1]?.trim() ?? null,
    summaryPath: filePath,
    evidence: { summaryPath: filePath },
    childIndex: 0,
    timestampMs: null,
  };
}
async function scanLocalPhaseSubagents(repoRoot) {
  const phasesRoot = path.join(repoRoot, "tmp", "phases");
  const phaseDirs = await listDirectoriesIfExists(phasesRoot);
  const runs = [];
  for (const phaseDir of phaseDirs) {
    const subagentsDir = path.join(phaseDir, "subagents");
    let entries;
    try {
      entries = await readdir(subagentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const filePath = path.join(subagentsDir, entry.name);
      const text = await readTextIfExists(filePath);
      if (text === null) {
        continue;
      }
      const parsed = parseLocalSubagentSummary(text, filePath);
      if (parsed !== null && isExitedState(parsed.runState)) {
        runs.push({
          ...parsed,
          phaseDir,
          kind: "local_phase",
        });
      }
    }
    const rawDir = path.join(subagentsDir, "raw");
    let rawEntries;
    try {
      rawEntries = await readdir(rawDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of rawEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const filePath = path.join(rawDir, entry.name);
      const text = await readTextIfExists(filePath);
      if (text === null) {
        continue;
      }
      const parsed = parseLocalSubagentSummary(text, filePath);
      if (parsed !== null && isExitedState(parsed.runState)) {
        runs.push({
          ...parsed,
          phaseDir,
          kind: "local_phase_raw",
        });
      }
    }
  }
  return runs;
}
function buildLocalPhaseResumePlan(localRun) {
  const phaseName = path.basename(localRun.phaseDir);
  const taskDesc = localRun.taskSummary ?? "unknown";
  let resumeMessage;
  if (localRun.runState === RUN_STATE.COMPLETED) {
    resumeMessage = `Local phase ${phaseName} subagent ${localRun.agent} (${localRun.runId}) completed. Task: ${taskDesc}. Consolidate and review results from ${localRun.phaseDir}.`;
  } else if (localRun.runState === RUN_STATE.FAILED) {
    resumeMessage = `Local phase ${phaseName} subagent ${localRun.agent} (${localRun.runId}) failed. Task: ${taskDesc}. Resume the phase from the last deterministic checkpoint in ${localRun.phaseDir}.`;
  } else {
    resumeMessage = `Local phase ${phaseName} subagent ${localRun.agent} (${localRun.runId}) exited (${localRun.runState}). Task: ${taskDesc}. Resume the phase from the last deterministic checkpoint in ${localRun.phaseDir}.`;
  }
  return {
    kind: "local_phase",
    phase: phaseName,
    phaseDir: localRun.phaseDir,
    agent: localRun.agent,
    runId: localRun.runId,
    runState: localRun.runState,
    taskSummary: localRun.taskSummary,
    resumeMessage,
    summaryPath: localRun.summaryPath,
  };
}
export async function listRepoAsyncRuns(
  { repo },
  {
    repoRoot = process.cwd(),
    env = process.env,
    sessionRoots,
    asyncRunRoots,
    asyncResultRoots,
  } = {},
) {
  parseRepoSlug(repo);
  const repoIsolation = await resolveRepoIsolation(repoRoot);
  const resolvedSessionRoots = collectConfiguredRoots(
    sessionRoots,
    env.PI_AGENT_SESSIONS_DIR ?? env.PI_SUBAGENT_SESSIONS_DIR,
    [DEFAULT_SESSION_ROOT],
  );
  const resolvedAsyncRunRoots = collectConfiguredRoots(
    asyncRunRoots,
    env.PI_SUBAGENT_ASYNC_RUNS_DIR,
    await detectDefaultAsyncRoots("async-subagent-runs"),
  );
  const resolvedAsyncResultRoots = collectConfiguredRoots(
    asyncResultRoots,
    env.PI_SUBAGENT_ASYNC_RESULTS_DIR,
    await detectDefaultAsyncRoots("async-subagent-results"),
  );
  const records = new Map();
  for (const sessionRoot of resolvedSessionRoots) {
    if (await pathExists(sessionRoot)) {
      await scanSessionRunRoot(sessionRoot, records);
    }
  }
  for (const asyncRoot of resolvedAsyncRunRoots) {
    if (await pathExists(asyncRoot)) {
      await scanAsyncRunRoot(asyncRoot, records);
    }
  }
  for (const resultsRoot of resolvedAsyncResultRoots) {
    if (await pathExists(resultsRoot)) {
      await scanAsyncResultRoot(resultsRoot, records);
    }
  }
  return [...records.values()]
    .filter((record) => record.agent === "dev-loop")
    .filter((record) => recordMatchesRepo(record, repoIsolation))
    .map((record) => ({
      ...record,
      staleWorktree: isStaleWorktreePath(record.cwd, repoIsolation),
      repoRoot: repoIsolation.repoRoot,
      worktreeRoot: repoIsolation.worktreeRoot,
    }));
}
function stripFormatting(value) {
  return value
    .replace(/`/gu, "")
    .replace(/^\*+|\*+$/gu, "")
    .trim();
}
function extractPrNumberFromLine(line) {
  const trimmed = stripFormatting(line);
  if (/\bActive PR:\s*none\b/i.test(trimmed)) {
    return null;
  }
  const urlMatch = trimmed.match(/\/pull\/(\d+)\b/u);
  if (urlMatch) {
    return Number(urlMatch[1]);
  }
  const hashMatch = trimmed.match(/\bPR\s*#(\d+)\b/u);
  if (hashMatch) {
    return Number(hashMatch[1]);
  }
  const activePrMatch = trimmed.match(/^Active PR:\s*.+#(\d+)\b/ui);
  if (activePrMatch) {
    return Number(activePrMatch[1]);
  }
  const prLineMatch = trimmed.match(/^PR:\s*.+#(\d+)\b/ui);
  if (prLineMatch) {
    return Number(prLineMatch[1]);
  }
  const artifactMatch = trimmed.match(/^[-*]\s*Artifact(?:\/state)? inspected:\s*PR\s*#(\d+)\b/ui);
  if (artifactMatch) {
    return Number(artifactMatch[1]);
  }
  const mergedMatch = trimmed.match(/^PR merged:\s*#(\d+)\b/ui);
  if (mergedMatch) {
    return Number(mergedMatch[1]);
  }
  const statusMatch = trimmed.match(/^Status:.*\bPR\s*#(\d+)\b/ui);
  if (statusMatch) {
    return Number(statusMatch[1]);
  }
  return null;
}
function extractPrNumbersFromArtifactText(text) {
  const numbers = new Set();
  const lines = text.split(/\r?\n/u);
  for (const line of lines) {
    const number = extractPrNumberFromLine(line);
    if (Number.isInteger(number)) {
      numbers.add(number);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}
function parseArtifactState(text) {
  const artifactStateLine = text.match(/^\**Artifact state:\**\s*(.+)$/imu)?.[1];
  const statusLine = text.match(/^Status:\s*(.+)$/imu)?.[1];
  const normalizedArtifact = stripFormatting(artifactStateLine ?? "").toLowerCase();
  const normalizedStatus = stripFormatting(statusLine ?? "").toLowerCase();
  const combined = `${normalizedArtifact}\n${normalizedStatus}`;
  if (/\bmerged\b/u.test(combined)) {
    return "merged";
  }
  if (/\bclosed\b/u.test(combined)) {
    return "closed";
  }
  if (/\bopen\b/u.test(combined)) {
    return "open";
  }
  if (/final human approval|waiting_for_merge_authorization|advanced to the final human approval boundary|inspected and advanced/u.test(combined)) {
    return "open";
  }
  return null;
}
function parseLoopState(text) {
  const patterns = [
    /^\**Loop state:\**\s*(.+)$/imu,
    /^Current routed state:\s*(.+)$/imu,
    /^-?\s*Copilot loop state:\s*(.+)$/imu,
    /^-?\s*Routed strategy:\s*(.+)$/imu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return stripFormatting(match[1]);
    }
  }
  return null;
}
function parseNextActionText(text) {
  const match = text.match(/^(?:Next action|Next recommended action):\s*(.+)$/imu);
  if (match?.[1]) {
    return stripFormatting(match[1]);
  }
  return null;
}
function classifyResumeBucket(text, parsedArtifactState) {
  const normalized = text.toLowerCase();
  if (
    parsedArtifactState === "merged"
    || /\bpr merged:\s*#\d+\b/u.test(normalized)
    || /\bartifact state:\s*merged\b/u.test(normalized)
  ) {
    return RESUME_ACTION.DONE_OR_MERGED;
  }
  if (
    /\bstop(?:ped)? at waiting_for_merge_authorization\b/u.test(normalized)
    || /\bcurrent stop boundary:\s*waiting_for_merge_authorization\b/u.test(normalized)
    || /\bstopping at waiting_for_merge_authorization\b/u.test(normalized)
    || /\basking for explicit merge authorization\b/u.test(normalized)
  ) {
    return RESUME_ACTION.AWAIT_MERGE_AUTHORIZATION;
  }
  if (
    /\bfinal human approval boundary\b/u.test(normalized)
    || /\bfinal human approval readiness\b/u.test(normalized)
    || /\brouted strategy:\s*`?final_approval`?/u.test(normalized)
    || /\bhuman reviews\/approves pr\b/u.test(normalized)
    || /\bawait final human approval\b/u.test(normalized)
  ) {
    return RESUME_ACTION.AWAIT_FINAL_APPROVAL;
  }
  if (
    /\balready_fixed_needs_reply_resolve\b/u.test(normalized)
    || /\breply(?:ing)? to and resolving the addressed github threads\b/u.test(normalized)
    || /\breply to and resolve each github thread\b/u.test(normalized)
  ) {
    return RESUME_ACTION.NEEDS_REPLY_RESOLVE;
  }
  if (
    /\bunresolved_feedback_present\b/u.test(normalized)
    || /\baddress(?:ing)? review feedback\b/u.test(normalized)
    || /\bfix(?:ing)? the remaining review feedback\b/u.test(normalized)
    || /\bremaining review feedback\b/u.test(normalized)
  ) {
    return RESUME_ACTION.NEEDS_FEEDBACK_FIX;
  }
  if (
    /\bwaiting_for_copilot_review\b/u.test(normalized)
    || /\bready_to_rerequest_review\b/u.test(normalized)
    || /\brequest(?:ing)? another copilot pass\b/u.test(normalized)
    || /\bwatch(?:ing)? the next copilot review cycle\b/u.test(normalized)
    || /\bcopilot review cycle\b/u.test(normalized)
  ) {
    return RESUME_ACTION.NEEDS_REREQUEST_OR_WATCH;
  }
  if (
    /\bauthorization boundary\b/u.test(normalized)
    || /\bdo not perform the next mutation without explicit approval\b/u.test(normalized)
    || /\bready-for-review\b/u.test(normalized)
    || /\bdraft review\b/u.test(normalized)
    || /\bdraft_gate\b/u.test(normalized)
  ) {
    return RESUME_ACTION.AWAIT_READY_FOR_REVIEW_AUTHORIZATION;
  }
  return null;
}
function buildSourceSelection(record, outputArtifactText, resultSummaryText, outputLogText) {
  const resultSummaryPath = record.resultSummaryPath ?? record.resultPath ?? null;
  const candidates = [];
  if (outputArtifactText !== null) {
    candidates.push({
      text: outputArtifactText,
      source: "output_artifact",
      artifactPath: record.outputArtifactPath ?? null,
      reportingIssue: null,
    });
  } else if (record.outputArtifactPath) {
    if (resultSummaryText !== null) {
      candidates.push({
        text: resultSummaryText,
        source: "grouped_result_summary",
        artifactPath: resultSummaryPath,
        reportingIssue: MANUAL_REASON.MISSING_OUTPUT_ARTIFACT,
      });
    }
    if (outputLogText !== null) {
      candidates.push({
        text: outputLogText,
        source: "weak_fallback_output_log",
        artifactPath: record.outputLogPath ?? null,
        reportingIssue: MANUAL_REASON.MISSING_OUTPUT_ARTIFACT,
      });
    }
    return {
      candidates,
      primarySource: "missing_output_artifact",
      weakFallbackText: outputLogText,
      outputArtifactMissing: true,
    };
  }
  if (resultSummaryText !== null) {
    candidates.push({
      text: resultSummaryText,
      source: "grouped_result_summary",
      artifactPath: resultSummaryPath,
      reportingIssue: null,
    });
  }
  if (outputLogText !== null) {
    candidates.push({
      text: outputLogText,
      source: "weak_fallback_output_log",
      artifactPath: record.outputLogPath ?? null,
      reportingIssue: null,
    });
  }
  return {
    candidates,
    primarySource: candidates.length > 0 ? candidates[0].source : "weak_fallback_only",
    weakFallbackText: outputLogText,
    outputArtifactMissing: false,
  };
}
function parseWeakFallbackPr(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }
  const prNumbers = extractPrNumbersFromArtifactText(text);
  return prNumbers.length === 1 ? prNumbers[0] : null;
}
export async function parseDevLoopArtifact(record) {
  const outputArtifactText = await readTextIfExists(record.outputArtifactPath);
  const resultSummaryText = record.resultSummaryText ?? await readTextIfExists(record.resultSummaryPath);
  const outputLogText = await readTextIfExists(record.outputLogPath);
  const selection = buildSourceSelection(record, outputArtifactText, resultSummaryText, outputLogText);
  if (selection.candidates.length === 0) {
    const weakFallbackPr = parseWeakFallbackPr(selection.weakFallbackText);
    return {
      ok: false,
      reason: MANUAL_REASON.MISSING_OUTPUT_ARTIFACT,
      ...(Number.isInteger(weakFallbackPr) ? { pr: weakFallbackPr } : {}),
      evidence: {
        outputArtifactPath: record.outputArtifactPath,
        resultSummaryPath: record.resultSummaryPath,
        resultPath: record.resultPath,
        outputLogPath: record.outputLogPath,
        sessionPath: record.sessionPath,
      },
      weakFallbackText: selection.weakFallbackText,
      source: selection.primarySource,
    };
  }
  let lastFailure = null;
  for (const candidate of selection.candidates) {
    const prNumbers = extractPrNumbersFromArtifactText(candidate.text);
    if (prNumbers.length > 1) {
      lastFailure = {
        ok: false,
        reason: MANUAL_REASON.AMBIGUOUS_PR_IDENTITY,
        evidence: {
          prNumbers,
          source: candidate.source,
          outputArtifactPath: record.outputArtifactPath,
          resultSummaryPath: record.resultSummaryPath,
          resultPath: record.resultPath,
          artifactPath: candidate.artifactPath,
        },
        source: candidate.source,
        weakFallbackText: selection.weakFallbackText,
      };
      continue;
    }
    if (prNumbers.length === 0) {
      lastFailure = {
        ok: false,
        reason: MANUAL_REASON.MISSING_PR_IDENTITY,
        evidence: {
          source: candidate.source,
          outputArtifactPath: record.outputArtifactPath,
          resultSummaryPath: record.resultSummaryPath,
          resultPath: record.resultPath,
          artifactPath: candidate.artifactPath,
        },
        source: candidate.source,
        weakFallbackText: selection.weakFallbackText,
      };
      continue;
    }
    const parsedArtifactState = parseArtifactState(candidate.text);
    const parsedLoopState = parseLoopState(candidate.text);
    const nextAction = parseNextActionText(candidate.text);
    const recordedHandoffContractResult = parseRecordedHandoffContract(candidate.text);
    if (recordedHandoffContractResult.reason !== null) {
      return {
        ok: false,
        reason: recordedHandoffContractResult.reason === "incomplete_handoff_contract"
          ? MANUAL_REASON.HANDOFF_CONTRACT_INCOMPLETE
          : MANUAL_REASON.HANDOFF_CONTRACT_INVALID,
        pr: prNumbers[0],
        evidence: {
          source: candidate.source,
          details: recordedHandoffContractResult.details ?? null,
          parsedArtifactState,
          parsedLoopState,
          nextAction,
          outputArtifactPath: record.outputArtifactPath,
          resultSummaryPath: record.resultSummaryPath,
        },
        source: candidate.source,
        weakFallbackText: selection.weakFallbackText,
      };
    }
    if (parsedArtifactState === null) {
      lastFailure = {
        ok: false,
        reason: MANUAL_REASON.UNCLASSIFIED_ARTIFACT_STATE,
        pr: prNumbers[0],
        evidence: {
          source: candidate.source,
          parsedLoopState,
          nextAction,
          outputArtifactPath: record.outputArtifactPath,
          resultSummaryPath: record.resultSummaryPath,
          resultPath: record.resultPath,
          artifactPath: candidate.artifactPath,
        },
        source: candidate.source,
        weakFallbackText: selection.weakFallbackText,
      };
      continue;
    }
    const resumeBucket = classifyResumeBucket(candidate.text, parsedArtifactState);
    if (resumeBucket === null) {
      lastFailure = {
        ok: false,
        reason: MANUAL_REASON.UNCLASSIFIED_ARTIFACT_STATE,
        pr: prNumbers[0],
        evidence: {
          source: candidate.source,
          parsedArtifactState,
          parsedLoopState,
          nextAction,
          outputArtifactPath: record.outputArtifactPath,
          resultSummaryPath: record.resultSummaryPath,
          resultPath: record.resultPath,
          artifactPath: candidate.artifactPath,
        },
        source: candidate.source,
        weakFallbackText: selection.weakFallbackText,
      };
      continue;
    }
    return {
      ok: true,
      pr: prNumbers[0],
      parsedArtifactState,
      parsedLoopState,
      nextAction,
      recordedHandoffContract: recordedHandoffContractResult.contract,
      resumeBucket,
      source: candidate.source,
      text: candidate.text,
      artifactPath: candidate.artifactPath,
      reportingIssue: candidate.reportingIssue,
    };
  }
  if (selection.outputArtifactMissing) {
    const weakFallbackPr = parseWeakFallbackPr(selection.weakFallbackText);
    return {
      ok: false,
      reason: MANUAL_REASON.MISSING_OUTPUT_ARTIFACT,
      ...(Number.isInteger(weakFallbackPr) ? { pr: weakFallbackPr } : {}),
      evidence: {
        outputArtifactPath: record.outputArtifactPath,
        resultSummaryPath: record.resultSummaryPath,
        resultPath: record.resultPath,
        outputLogPath: record.outputLogPath,
        sessionPath: record.sessionPath,
      },
      weakFallbackText: selection.weakFallbackText,
      source: selection.primarySource,
    };
  }
  return lastFailure ?? {
    ok: false,
    reason: MANUAL_REASON.UNCLASSIFIED_ARTIFACT_STATE,
    evidence: {
      outputArtifactPath: record.outputArtifactPath,
      resultSummaryPath: record.resultSummaryPath,
      resultPath: record.resultPath,
      outputLogPath: record.outputLogPath,
      sessionPath: record.sessionPath,
    },
    source: selection.primarySource,
    weakFallbackText: selection.weakFallbackText,
  };
}
function buildResumeMessage({ pr, runId, resumeAction, livePrState }) {
  switch (resumeAction) {
    case RESUME_ACTION.NEEDS_FEEDBACK_FIX:
      return `PR #${pr} is orphaned. Live state: unresolved_feedback_present. Resume the prior dev-loop from run ${runId}. Continue by fixing the remaining review feedback, then reply to and resolve each GitHub thread. Do not merge.`;
    case RESUME_ACTION.NEEDS_REPLY_RESOLVE:
      return `PR #${pr} is orphaned. Live state: already_fixed_needs_reply_resolve. Resume the prior dev-loop from run ${runId}. Continue by replying to and resolving the addressed GitHub threads before requesting another Copilot pass. Do not merge.`;
    case RESUME_ACTION.NEEDS_REREQUEST_OR_WATCH:
      return `PR #${pr} is orphaned. Live state: ${livePrState}. Resume the prior dev-loop from run ${runId}. Continue by requesting or watching the next Copilot review cycle on the current head. Do not enter gate or merge until the review settles.`;
    case RESUME_ACTION.AWAIT_FINAL_APPROVAL:
      return `PR #${pr} is orphaned. Live state: final_approval_ready. Resume the prior dev-loop from run ${runId}. Continue by summarizing the clean current-head evidence and stop at final human approval. Do not merge without explicit authorization.`;
    case RESUME_ACTION.AWAIT_MERGE_AUTHORIZATION:
      return `PR #${pr} is orphaned. Live state: clean current-head gate evidence + green CI. Resume the prior dev-loop from run ${runId}. Continue by stopping at waiting_for_merge_authorization and asking for explicit merge authorization. Do not merge automatically.`;
    case RESUME_ACTION.AWAIT_READY_FOR_REVIEW_AUTHORIZATION:
      return `PR #${pr} is orphaned. Live state: ${livePrState}. Resume the prior dev-loop from run ${runId}. Continue by staying at the current authorization boundary (assignment, ready-for-review, or draft review) and do not perform the next mutation without explicit approval.`;
    default:
      return `PR #${pr} is orphaned. Resume the prior dev-loop from run ${runId}. Continue from the last deterministic state and do not merge.`;
  }
}
function buildResumeCommandPreview({ runId, childIndex, childCount, resumeMessage }) {
  if (childCount > 1 || childIndex !== 0) {
    return `subagent({ action: "resume", id: "${runId}", index: ${childIndex}, message: ${JSON.stringify(resumeMessage)} })`;
  }
  return `subagent({ action: "resume", id: "${runId}", message: ${JSON.stringify(resumeMessage)} })`;
}
function buildManualAttentionEntry({
  pr = null,
  runId = null,
  reason,
  evidence,
  suggestedNextStep,
}) {
  return {
    ...(Number.isInteger(pr) ? { pr } : {}),
    ...(typeof runId === "string" && runId.length > 0 ? { runId } : {}),
    reason,
    evidence,
    suggestedNextStep,
  };
}
export function selectLatestExitedRunForPr({ pr, exitedRuns, activeRuns }) {
  const activeMatch = activeRuns.filter((candidate) => candidate.parsedArtifact?.ok && candidate.parsedArtifact.pr === pr.number);
  const matches = exitedRuns.filter((candidate) => candidate.parsedArtifact?.ok && candidate.parsedArtifact.pr === pr.number);
  if (matches.length === 0) {
    return { kind: "none" };
  }
  const sorted = [...matches].sort((left, right) => {
    const leftTs = left.run.timestampMs ?? Number.NEGATIVE_INFINITY;
    const rightTs = right.run.timestampMs ?? Number.NEGATIVE_INFINITY;
    return rightTs - leftTs;
  });
  if (sorted.length > 1) {
    const firstTimestamp = sorted[0].run.timestampMs;
    const secondTimestamp = sorted[1].run.timestampMs;
    if (firstTimestamp === null || secondTimestamp === null || firstTimestamp === secondTimestamp) {
      return {
        kind: "manual_attention",
        reason: MANUAL_REASON.MULTIPLE_CANDIDATE_RUNS,
        runs: sorted.map((candidate) => ({
          runId: candidate.run.runId,
          childIndex: candidate.run.childIndex,
          timestampMs: candidate.run.timestampMs,
          outputArtifactPath: candidate.run.outputArtifactPath,
          sessionPath: candidate.run.sessionPath,
        })),
      };
    }
  }
  const selected = sorted[0];
  const selectedTimestamp = selected.run.timestampMs;
  if (activeMatch.length > 0) {
    const indeterminateActiveRuns = activeMatch.filter((candidate) => (
      typeof candidate.run.timestampMs !== "number"
      || typeof selectedTimestamp !== "number"
    ));
    if (indeterminateActiveRuns.length > 0) {
      return {
        kind: "manual_attention",
        reason: MANUAL_REASON.ARTIFACT_LIVE_STATE_CONFLICT,
        runs: [
          {
            runId: selected.run.runId,
            childIndex: selected.run.childIndex,
            timestampMs: selected.run.timestampMs,
            outputArtifactPath: selected.run.outputArtifactPath,
            sessionPath: selected.run.sessionPath,
          },
          ...indeterminateActiveRuns.map((candidate) => ({
            runId: candidate.run.runId,
            childIndex: candidate.run.childIndex,
            timestampMs: candidate.run.timestampMs,
            outputArtifactPath: candidate.run.outputArtifactPath,
            sessionPath: candidate.run.sessionPath,
            runState: candidate.run.runState,
          })),
        ],
      };
    }
  }
  const sameTimestampActiveRuns = activeMatch.filter((candidate) => candidate.run.timestampMs === selectedTimestamp);
  if (sameTimestampActiveRuns.length > 0) {
    return {
      kind: "manual_attention",
      reason: MANUAL_REASON.ARTIFACT_LIVE_STATE_CONFLICT,
      runs: [
        {
          runId: selected.run.runId,
          childIndex: selected.run.childIndex,
          timestampMs: selected.run.timestampMs,
          outputArtifactPath: selected.run.outputArtifactPath,
          sessionPath: selected.run.sessionPath,
        },
        ...sameTimestampActiveRuns.map((candidate) => ({
          runId: candidate.run.runId,
          childIndex: candidate.run.childIndex,
          timestampMs: candidate.run.timestampMs,
          outputArtifactPath: candidate.run.outputArtifactPath,
          sessionPath: candidate.run.sessionPath,
          runState: candidate.run.runState,
        })),
      ],
    };
  }
  const newerActiveRuns = activeMatch.filter((candidate) => candidate.run.timestampMs > selectedTimestamp);
  if (newerActiveRuns.length > 0) {
    return {
      kind: "suppressed_by_active_run",
      runIds: newerActiveRuns.map((candidate) => candidate.run.runId),
    };
  }
  return { kind: "selected", candidate: selected };
}
function classifyLiveStateForResume(resumeAction, prReport) {
  switch (resumeAction) {
    case RESUME_ACTION.NEEDS_FEEDBACK_FIX:
      return "unresolved_feedback_present";
    case RESUME_ACTION.NEEDS_REPLY_RESOLVE:
      return "already_fixed_needs_reply_resolve";
    case RESUME_ACTION.NEEDS_REREQUEST_OR_WATCH:
      return prReport.state;
    case RESUME_ACTION.AWAIT_FINAL_APPROVAL:
      return "final_approval_ready";
    case RESUME_ACTION.AWAIT_MERGE_AUTHORIZATION:
      return "clean current-head gate evidence + green CI";
    case RESUME_ACTION.AWAIT_READY_FOR_REVIEW_AUTHORIZATION:
      return prReport.isDraft ? "pr_draft" : prReport.state;
    default:
      return prReport.state;
  }
}
function hasMaterialConflict(resumeAction, prReport, parsedArtifact) {
  if (parsedArtifact.parsedArtifactState === "merged" || resumeAction === RESUME_ACTION.DONE_OR_MERGED) {
    return true;
  }
  if (resumeAction === RESUME_ACTION.AWAIT_FINAL_APPROVAL) {
    return prReport.snapshot.unresolvedThreadCount > 0 || prReport.snapshot.ciStatus === "failure";
  }
  if (resumeAction === RESUME_ACTION.AWAIT_MERGE_AUTHORIZATION) {
    return prReport.snapshot.unresolvedThreadCount > 0 || prReport.snapshot.ciStatus !== "success";
  }
  if (resumeAction === RESUME_ACTION.NEEDS_REREQUEST_OR_WATCH) {
    return prReport.state === "unresolved_feedback_present" && parsedArtifact.resumeBucket !== RESUME_ACTION.NEEDS_REPLY_RESOLVE;
  }
  return false;
}
const HEALTHY_CI_STATUSES = new Set(["success", "crediblyGreen"]);

export function isPrHealthy(prReport) {
  return prReport.snapshot.unresolvedThreadCount === 0
    && HEALTHY_CI_STATUSES.has(prReport.snapshot.ciStatus);
}

const FIX_FEEDBACK_RESUME_ACTIONS = new Set([
  RESUME_ACTION.NEEDS_FEEDBACK_FIX,
  RESUME_ACTION.NEEDS_REPLY_RESOLVE,
  RESUME_ACTION.NEEDS_REREQUEST_OR_WATCH,
]);

export function buildResumePlan({ prReport, candidate, childCounts }) {
  const { run, parsedArtifact } = candidate;
  const resumeAction = parsedArtifact.resumeBucket;
  if (hasMaterialConflict(resumeAction, prReport, parsedArtifact)) {
    return {
      kind: "manual_attention",
      entry: buildManualAttentionEntry({
        pr: prReport.number,
        runId: run.runId,
        reason: MANUAL_REASON.ARTIFACT_LIVE_STATE_CONFLICT,
        evidence: {
          parsedArtifactState: parsedArtifact.parsedArtifactState,
          parsedLoopState: parsedArtifact.parsedLoopState,
          resumeAction,
          livePrState: prReport.state,
          outputArtifactPath: run.outputArtifactPath,
          sessionPath: run.sessionPath,
        },
        suggestedNextStep: "Reconcile the live PR state against the exited run artifact before resuming.",
      }),
    };
  }
  if (FIX_FEEDBACK_RESUME_ACTIONS.has(resumeAction) && isPrHealthy(prReport)) {
    return { kind: "suppressed_healthy" };
  }
  if (run.staleWorktree && !run.sessionPath && !run.outputArtifactPath && !run.resultSummaryPath && !run.resultPath) {
    return {
      kind: "manual_attention",
      entry: buildManualAttentionEntry({
        pr: prReport.number,
        runId: run.runId,
        reason: MANUAL_REASON.STALE_WORKTREE_MISSING_RESUME_INPUTS,
        evidence: {
          cwd: run.cwd,
          sessionPath: run.sessionPath,
          outputArtifactPath: run.outputArtifactPath,
          resultSummaryPath: run.resultSummaryPath,
        },
        suggestedNextStep: "Recover or recreate the missing worktree/session inputs before attempting resume.",
      }),
    };
  }
  const livePrState = classifyLiveStateForResume(resumeAction, prReport);
  const expectedHandoffContract = buildHandoffContractForResumeAction(resumeAction);
  const recordedHandoffContract = parsedArtifact.recordedHandoffContract ?? null;
  const handoffContractMismatch = compareHandoffContracts(recordedHandoffContract, expectedHandoffContract);
  if (handoffContractMismatch !== null) {
    return {
      kind: "manual_attention",
      entry: buildManualAttentionEntry({
        pr: prReport.number,
        runId: run.runId,
        reason: MANUAL_REASON.HANDOFF_CONTRACT_MISMATCH,
        evidence: {
          parsedArtifactState: parsedArtifact.parsedArtifactState,
          parsedLoopState: parsedArtifact.parsedLoopState,
          resumeAction,
          livePrState,
          recordedHandoffContract,
          expectedHandoffContract,
          outputArtifactPath: run.outputArtifactPath,
          sessionPath: run.sessionPath,
        },
        suggestedNextStep: "Reconcile the recorded handoff contract against the live PR state before resuming.",
      }),
    };
  }
  const resumeMessage = buildResumeMessage({
    pr: prReport.number,
    runId: run.runId,
    resumeAction,
    livePrState,
  });
  const childCount = childCounts.get(run.runId) ?? 1;
  return {
    kind: "resume_plan",
    entry: {
      pr: prReport.number,
      runId: run.runId,
      runState: normalizeRunStateForPlan(run.runState),
      artifactPath: parsedArtifact.artifactPath ?? run.outputArtifactPath ?? run.resultSummaryPath ?? run.resultPath ?? null,
      ...(parsedArtifact.reportingIssue ? { reportingIssue: parsedArtifact.reportingIssue } : {}),
      ...(run.sessionPath ? { sessionPath: run.sessionPath } : {}),
      parsedArtifactState: parsedArtifact.parsedArtifactState,
      parsedLoopState: parsedArtifact.parsedLoopState,
      livePrState,
      resumeAction,
      handoffContract: expectedHandoffContract,
      ...(recordedHandoffContract ? { recordedHandoffContract } : {}),
      resumeMessage,
      resumeCommandPreview: buildResumeCommandPreview({
        runId: run.runId,
        childIndex: run.childIndex,
        childCount,
        resumeMessage,
      }),
      staleWorktree: run.staleWorktree,
    },
  };
}
async function analyzeAutoResume({ repo, reports }, options) {
  const openPrNumbers = new Set(reports.map((report) => report.number));
  const runs = await listRepoAsyncRuns({ repo }, options);
  const childCounts = runs.reduce((map, run) => {
    map.set(run.runId, (map.get(run.runId) ?? 0) + 1);
    return map;
  }, new Map());
  const activeRuns = [];
  const exitedRuns = [];
  const manualAttention = [];
  for (const run of runs) {
    const parsedArtifact = await parseDevLoopArtifact(run);
    let candidate = { run, parsedArtifact };
    if (!parsedArtifact.ok) {
      if (isRunningLikeState(run.runState)) {
        const runningPr = parseWeakFallbackPr(parsedArtifact.weakFallbackText ?? null);
        if (Number.isInteger(runningPr)) {
          activeRuns.push({
            run,
            parsedArtifact: {
              ok: true,
              pr: runningPr,
              parsedArtifactState: "open",
              parsedLoopState: null,
              nextAction: null,
              resumeBucket: RESUME_ACTION.NEEDS_REREQUEST_OR_WATCH,
              source: "weak_fallback_output_log",
              text: parsedArtifact.weakFallbackText,
            },
          });
        }
        continue;
      }
      const parsedNumbers = Array.isArray(parsedArtifact.evidence?.prNumbers)
        ? parsedArtifact.evidence.prNumbers.filter((value) => Number.isInteger(value))
        : [];
      const touchesOpenPr = openPrNumbers.has(parsedArtifact.pr)
        || parsedNumbers.some((value) => openPrNumbers.has(value));
      if ((run.runState === RUN_STATE.UNKNOWN || isExitedState(run.runState)) && touchesOpenPr) {
        manualAttention.push(buildManualAttentionEntry({
          pr: Number.isInteger(parsedArtifact.pr) ? parsedArtifact.pr : null,
          runId: run.runId,
          reason: parsedArtifact.reason,
          evidence: {
            ...parsedArtifact.evidence,
            cwd: run.cwd,
            sessionPath: run.sessionPath,
            outputLogPath: run.outputLogPath,
          },
          suggestedNextStep: parsedArtifact.reason === MANUAL_REASON.MISSING_OUTPUT_ARTIFACT
            ? "Locate the missing output artifact or inspect the saved session before attempting resume."
            : "Inspect the saved artifact/session manually and reconcile the PR identity/state before resuming.",
        }));
      }
      continue;
    }
    candidate = { run, parsedArtifact };
    if (isRunningLikeState(run.runState)) {
      activeRuns.push(candidate);
      continue;
    }
    if (isExitedState(run.runState)) {
      exitedRuns.push(candidate);
      continue;
    }
    if (run.runState === RUN_STATE.UNKNOWN && openPrNumbers.has(parsedArtifact.pr)) {
      manualAttention.push(buildManualAttentionEntry({
        pr: parsedArtifact.pr,
        runId: run.runId,
        reason: MANUAL_REASON.ARTIFACT_LIVE_STATE_CONFLICT,
        evidence: {
          runState: run.runState,
          outputArtifactPath: run.outputArtifactPath,
          sessionPath: run.sessionPath,
        },
        suggestedNextStep: "Resolve the run state for this candidate before preparing a resume plan.",
      }));
    }
  }
  const resumePlans = [];
  for (const prReport of reports) {
    const selection = selectLatestExitedRunForPr({ pr: prReport, exitedRuns, activeRuns });
    if (selection.kind === "manual_attention") {
      manualAttention.push(buildManualAttentionEntry({
        pr: prReport.number,
        reason: selection.reason,
        evidence: { runs: selection.runs },
        suggestedNextStep: "Choose the correct exited run manually before attempting resume.",
      }));
      continue;
    }
    if (selection.kind !== "selected") {
      continue;
    }
    const built = buildResumePlan({
      prReport,
      candidate: selection.candidate,
      childCounts,
    });
    if (built.kind === "suppressed_healthy") {
      continue;
    }
    if (built.kind === "manual_attention") {
      manualAttention.push(built.entry);
      continue;
    }
    resumePlans.push(built.entry);
  }
  const orphanedPrs = new Set();
  resumePlans.forEach((plan) => orphanedPrs.add(plan.pr));
  manualAttention.forEach((entry) => {
    if (Number.isInteger(entry.pr)) {
      orphanedPrs.add(entry.pr);
    }
  });
  const localPhaseRuns = await scanLocalPhaseSubagents(options.repoRoot ?? process.cwd());
  const localPhaseResumePlans = localPhaseRuns
    .map((run) => buildLocalPhaseResumePlan(run));
  return {
    orphanedPrCount: orphanedPrs.size,
    resumePlanCount: resumePlans.length,
    manualAttentionCount: manualAttention.length,
    localPhaseOrphanedCount: localPhaseResumePlans.filter(p => p.runState !== RUN_STATE.COMPLETED).length,
    resumePlans,
    needsManualAttention: manualAttention,
    localPhaseResumePlans,
  };
}
function applyAutoResumeToBaseResult(baseResult, autoResume) {
  const orphanAttentionPrs = new Set();
  autoResume.resumePlans.forEach((entry) => orphanAttentionPrs.add(entry.pr));
  autoResume.needsManualAttention.forEach((entry) => {
    if (Number.isInteger(entry.pr)) {
      orphanAttentionPrs.add(entry.pr);
    }
  });
  const localPhaseAttention = (autoResume.localPhaseResumePlans?.filter(p => p.runState !== RUN_STATE.COMPLETED)?.length ?? 0) > 0;
  const queueNeedsAttention = baseResult.queueStatus === "attention_needed"
    || autoResume.resumePlanCount > 0
    || autoResume.manualAttentionCount > 0
    || localPhaseAttention;
  const queueStatus = baseResult.prCount === 0 && !localPhaseAttention
    ? "queue_complete"
    : (queueNeedsAttention ? "attention_needed" : "monitoring");
  const liveAttentionPrs = new Set(baseResult.prs.filter((pr) => pr.needsAttention).map((pr) => pr.number));
  const needsAttentionCount = new Set([...liveAttentionPrs, ...orphanAttentionPrs]).size;
  return {
    ...baseResult,
    queueStatus,
    needsAttentionCount,
    autoResumeRequested: true,
    orphanedPrCount: autoResume.orphanedPrCount,
    resumePlanCount: autoResume.resumePlanCount,
    manualAttentionCount: autoResume.manualAttentionCount,
    localPhaseOrphanedCount: autoResume.localPhaseOrphanedCount ?? 0,
    resumePlans: autoResume.resumePlans,
    needsManualAttention: autoResume.needsManualAttention,
    localPhaseResumePlans: autoResume.localPhaseResumePlans ?? [],
  };
}
export async function runConductorMonitor(
  { repo, autoResume = false },
  {
    env = process.env,
    ghCommand = "gh",
    repoRoot = process.cwd(),
    sessionRoots,
    asyncRunRoots,
    asyncResultRoots,
  } = {},
) {
  const prs = await listOpenPrs({ repo }, { env, ghCommand });
  if (prs.length === 0) {
    const baseResult = buildBaseResult(repo, []);
    if (!autoResume) {
      const localRuns = await scanLocalPhaseSubagents(repoRoot);
      if (localRuns.length > 0) {
        return {
          ...baseResult,
          localPhaseOrphanedCount: localRuns.filter(r => r.runState !== RUN_STATE.COMPLETED).length,
          localPhaseResumePlans: localRuns.map((run) => buildLocalPhaseResumePlan(run)),
        };
      }
      return baseResult;
    }
    const localPhaseRuns = await scanLocalPhaseSubagents(repoRoot);
    return applyAutoResumeToBaseResult(baseResult, {
      orphanedPrCount: 0,
      resumePlanCount: 0,
      manualAttentionCount: 0,
      resumePlans: [],
      needsManualAttention: [],
      localPhaseOrphanedCount: localPhaseRuns.filter(r => r.runState !== RUN_STATE.COMPLETED).length,
      localPhaseResumePlans: localPhaseRuns.map((run) => buildLocalPhaseResumePlan(run)),
    });
  }
  const reports = await buildPrReports(prs, { repo, env, ghCommand });
  const baseResult = buildBaseResult(repo, reports);
  if (!autoResume) {
    return baseResult;
  }
  const autoResumeResult = await analyzeAutoResume({ repo, reports }, {
    env,
    repoRoot,
    sessionRoots,
    asyncRunRoots,
    asyncResultRoots,
  });
  return applyAutoResumeToBaseResult(baseResult, autoResumeResult);
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", cwd = process.cwd() } = {},
) {
  const options = parseCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runConductorMonitor(options, {
    env,
    ghCommand,
    repoRoot: cwd,
  });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
