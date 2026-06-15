#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import {
  buildParseError,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  parseJsonText,
  classifyReviewThreadsSignal,
  parseReviewThreads,
  summarizeCopilotReviews,
} from "../_core-helpers.mjs";
import { fetchGithubReviewThreadsPayload } from "../github/capture-review-threads.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { loadDevLoopConfig, resolveRefinement } from "@dev-loops/core/config";
import {
  buildSnapshotFromPrFacts,
  interpretLoopState,
  normalizeSnapshot,
  summarizeLoopInterpretation,
} from "@dev-loops/core/loop/copilot-loop-state";
import {
  normalizeStatusCheckRollupContract,
  summarizeHeadScopedCheckRunsSignal,
  normalizeHeadScopedCommitStatus,
  normalizeHeadScopedCiContract,
} from "@dev-loops/core/loop/copilot-ci-status";
const USAGE = `Usage:
  detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>
  detect-copilot-loop-state.mjs --input <path>
Detect or interpret the current Copilot-loop state.
Modes:
  Auto-detect  Fetch live PR/GitHub facts and interpret loop state.
               Requires: --repo, --pr
  Snapshot     Interpret a pre-built snapshot JSON without any gh calls.
               Requires: --input
Required (auto-detect mode):
  --repo <owner/name>                        Repository slug (e.g. owner/repo)
  --pr <number>                              Pull request number
Required (snapshot mode):
  --input <path>                             Path to snapshot JSON file
Optional (auto-detect mode only):
Optional (auto-detect mode only):
Output (stdout, JSON):
  { "ok": true, "snapshot": {..., "copilotReviewRoundCount": N}, "state": "...", "allowedTransitions": [...], "nextAction": "...",
    "autoRerequestEligible": true|false, "sameHeadCleanConverged": true|false,
    "loopDisposition": "...", "terminal": true|false }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
Exit codes:
  0  Success
  1  Argument error, gh failure, or indeterminate state`.trim();
const VALID_OVERRIDE_STATUSES = new Set(["requested", "already-requested", "unavailable", "none", "failed"]);
const parseError = buildParseError(USAGE);
export function parseDetectCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    inputPath: undefined,
    repo: undefined,
    pr: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--input") {
      options.inputPath = requireOptionValue(args, "--input", parseError);
      continue;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.inputPath !== undefined) {
    if (options.repo !== undefined || options.pr !== undefined) {
      throw parseError("Choose exactly one input source: --input <path> or --repo/--pr auto-detect");
    }
    return options;
  }
  const hasRepo = options.repo !== undefined;
  const hasPr = options.pr !== undefined;
  if (hasRepo || hasPr) {
    if (!hasRepo || !hasPr) {
      throw parseError("Auto-detect mode requires both --repo <owner/name> and --pr <number>");
    }
    try {
      parseRepoSlug(options.repo);
    } catch (error) {
      throw parseError(error instanceof Error ? error.message : String(error));
    }
  } else {
    throw parseError("Provide either --input <path> or --repo <owner/name> --pr <number>");
  }
  return options;
}
async function fetchPrView({ repo, pr }, { env, ghCommand }) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    if (/no pull requests found/i.test(detail) || /could not find pull request/i.test(detail)) {
      return null;
    }
    throw new Error(`gh command failed: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
  return payload;
}
async function fetchCopilotRequested({ repo, pr }, { env, ghCommand }) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
  const users = Array.isArray(payload?.users) ? payload.users : [];
  return users.some((user) => isCopilotLogin(user?.login));
}
async function fetchLatestCopilotReviewRequestAt({ repo, pr }, { env, ghCommand }) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/issues/${pr}/timeline`, "--paginate", "--jq",
      '.[] | select(.event == "review_requested") | select(.requested_reviewer.login != null) | {login: .requested_reviewer.login, created_at: .created_at}'],
    env,
  );
  if (result.code !== 0) {
    return null;
  }
  let latestAt = null;
  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (isCopilotLogin(event?.login)) {
        if (latestAt === null || event.created_at > latestAt) {
          latestAt = event.created_at;
        }
      }
    } catch {
    }
  }
  return latestAt;
}
function extractPrVisibleCheckNames(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) return [];
  return statusCheckRollup
    .map((entry) => entry?.name || entry?.context)
    .filter((name) => typeof name === "string" && name.length > 0);
}

async function fetchCurrentHeadCiEvidence({ repo, headSha, prVisibleCheckNames }, { env, ghCommand }) {
  const [checkRunsResult, statusesResult] = await Promise.all([
    runChild(
      ghCommand,
      ["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`],
      env,
    ),
    runChild(
      ghCommand,
      ["api", `repos/${repo}/commits/${headSha}/status?per_page=100`],
      env,
    ),
  ]);
  let checkRunsSignal = null;
  let checkRunsCount = null;
  if (checkRunsResult.code === 0) {
    try {
      const payload = JSON.parse(checkRunsResult.stdout);
      if (Array.isArray(payload?.check_runs)) {
        const visibleSet = prVisibleCheckNames?.length > 0 ? new Set(prVisibleCheckNames) : null;
        const visibleRuns = visibleSet
          ? payload.check_runs.filter((run) => !run.name || visibleSet.has(run.name))
          : payload.check_runs;
        // Use visible runs for the status signal, but preserve the full-set
        // unsupportedCompleted flag so hidden check-runs still contribute to
        // the cautious none override (#740).
        const visibleSignal = summarizeHeadScopedCheckRunsSignal({ check_runs: visibleRuns });
        const fullSignal = summarizeHeadScopedCheckRunsSignal(payload);
        const excludedRuns = visibleSet
          ? payload.check_runs.filter((run) => run.name && !visibleSet.has(run.name))
          : [];
        const excludedSignal = summarizeHeadScopedCheckRunsSignal({ check_runs: excludedRuns });
        checkRunsSignal = { ...visibleSignal, unsupportedCompleted: fullSignal.unsupportedCompleted, excludedFailureDetails: excludedSignal.failureDetails ?? [] };
        checkRunsCount = payload.check_runs.length;
      }
    } catch {
      checkRunsSignal = null;
      checkRunsCount = null;
    }
  }
  let commitStatus = null;
  let statusesCount = null;
  if (statusesResult.code === 0) {
    try {
      const payload = JSON.parse(statusesResult.stdout);
      if (Array.isArray(payload?.statuses)) {
        commitStatus = normalizeHeadScopedCommitStatus(payload);
        statusesCount = payload.statuses.length;
      }
    } catch {
      commitStatus = null;
      statusesCount = null;
    }
  }
  if (checkRunsSignal === null && commitStatus === null) {
    return null;
  }
  return {
    status: normalizeHeadScopedCiContract({
      checkRunsStatus: checkRunsSignal?.status ?? "none",
      commitStatus: commitStatus ?? "none",
      checkRunsUnsupportedCompleted: checkRunsSignal?.unsupportedCompleted ?? false,
    }).overallStatus,
    observedZeroSuitesAndStatuses: checkRunsCount === 0 && statusesCount === 0,
    failureDetails: checkRunsSignal?.failureDetails ?? [],
    excludedFailureDetails: checkRunsSignal?.excludedFailureDetails ?? [],
  };
}
function hasLocalValidationForCurrentHead(localValidationHeadSha, currentHeadSha) {
  if (typeof localValidationHeadSha !== "string" || typeof currentHeadSha !== "string") {
    return false;
  }
  const normalizedValidationHeadSha = localValidationHeadSha.trim().toLowerCase();
  const normalizedCurrentHeadSha = currentHeadSha.trim().toLowerCase();
  return normalizedValidationHeadSha.length > 0
    && normalizedCurrentHeadSha.length > 0
    && normalizedCurrentHeadSha.startsWith(normalizedValidationHeadSha);
}
function shouldPromoteCrediblyGreen({
  refreshedCurrentHeadCi,
  fallbackCiStatus,
  localValidationHeadSha,
  currentHeadSha,
  reviewSummary,
  unresolvedThreadCount,
  actionableThreadCount,
}) {
  return refreshedCurrentHeadCi?.status === "none"
    && refreshedCurrentHeadCi?.observedZeroSuitesAndStatuses === true
    && fallbackCiStatus === "success"
    && hasLocalValidationForCurrentHead(localValidationHeadSha, currentHeadSha)
    && reviewSummary?.hasSubmittedReviewOnCurrentHead === true
    && unresolvedThreadCount === 0
    && actionableThreadCount === 0;
}
function hasSubmittedCopilotReviewOffCurrentHead(reviewSummary, currentHeadSha) {
  if (currentHeadSha == null) {
    return false;
  }
  const reviews = Array.isArray(reviewSummary?.copilotReviews) ? reviewSummary.copilotReviews : [];
  for (const review of reviews) {
    const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
    if (state === "PENDING") {
      continue;
    }
    const commitSha = typeof review?.commit?.oid === "string"
      ? review.commit.oid
      : (typeof review?.commit_id === "string" ? review.commit_id : null);
    if (commitSha && commitSha !== currentHeadSha) {
      return true;
    }
  }
  return false;
}


export async function autoDetectSnapshot({ repo, pr, reviewRequestStatusOverride, localValidationHeadSha, draftGateResetAtMs }, { env = process.env, ghCommand = "gh" } = {}) {
  const prData = await fetchPrView({ repo, pr }, { env, ghCommand });
  if (prData === null) {
    return normalizeSnapshot({ prExists: false });
  }
  const prState = typeof prData.state === "string" ? prData.state.toUpperCase() : "OPEN";
  const prMerged = prState === "MERGED";
  const prClosed = prState === "CLOSED";
  if (prMerged || prClosed) {
    return normalizeSnapshot({
      prExists: true,
      prNumber: typeof prData.number === "number" ? prData.number : pr,
      prMerged,
      prClosed,
    });
  }
  const prHeadSha = typeof prData.headRefOid === "string" && prData.headRefOid.trim().length > 0
    ? prData.headRefOid.trim()
    : null;
  const reviewSummary = summarizeCopilotReviews(prData.reviews, { headSha: prHeadSha, draftGateResetAtMs });
  const fallbackCiStatus = normalizeStatusCheckRollupContract(prData.statusCheckRollup).overallStatus;
  let copilotReviewRequestStatus;
  if (reviewRequestStatusOverride !== undefined) {
    copilotReviewRequestStatus = reviewRequestStatusOverride;
  } else if (reviewSummary.hasPendingReviewOnCurrentHead) {
    copilotReviewRequestStatus = "requested";
  } else {
    const copilotRequested = await fetchCopilotRequested({ repo, pr }, { env, ghCommand });
    if (!copilotRequested) {
      copilotReviewRequestStatus = "none";
    } else if (!reviewSummary.hasSubmittedReviewOnCurrentHead) {
      copilotReviewRequestStatus = "requested";
    } else {
      const latestRequestAt = await fetchLatestCopilotReviewRequestAt({ repo, pr }, { env, ghCommand });
      const latestReviewAt = reviewSummary.latestSubmittedReviewOnCurrentHeadAt;
      if (latestRequestAt !== null && latestReviewAt !== null && latestRequestAt > latestReviewAt) {
        copilotReviewRequestStatus = "requested";
      } else if (latestRequestAt === null) {
        copilotReviewRequestStatus = "requested";
      } else {
        copilotReviewRequestStatus = "none";
      }
    }
  }
  let unresolvedThreadCount = 0;
  let actionableThreadCount = 0;
  let lastCopilotRoundMaxSignal = null;
  try {
    const threadsPayload = await fetchGithubReviewThreadsPayload({ repo, pr }, { env, ghCommand });
    const parsed = parseReviewThreads(threadsPayload);
    unresolvedThreadCount = parsed.summary.unresolvedThreads;
    actionableThreadCount = parsed.summary.actionableThreads;
    lastCopilotRoundMaxSignal = classifyReviewThreadsSignal(parsed, isCopilotLogin);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not determine review-thread state: ${detail}`);
  }
  const shouldRefreshCurrentHeadCi =
    prHeadSha !== null
    && fallbackCiStatus === "success"
    && (
      hasSubmittedCopilotReviewOffCurrentHead(reviewSummary, prHeadSha)
      || (
        reviewSummary.hasSubmittedReviewOnCurrentHead
        && hasLocalValidationForCurrentHead(localValidationHeadSha, prHeadSha)
      )
    );
  const prVisibleCheckNames = extractPrVisibleCheckNames(prData.statusCheckRollup);
  let currentHeadCiStatus = fallbackCiStatus;
  let failureDetails = [];
  let excludedFailureDetails = [];
  if (shouldRefreshCurrentHeadCi) {
    const refreshed = await fetchCurrentHeadCiEvidence({ repo, headSha: prHeadSha, prVisibleCheckNames }, { env, ghCommand });
    currentHeadCiStatus = refreshed?.status ?? "none";
    failureDetails = refreshed?.failureDetails ?? [];
    excludedFailureDetails = refreshed?.excludedFailureDetails ?? [];
    if (shouldPromoteCrediblyGreen({
      refreshedCurrentHeadCi: refreshed,
      fallbackCiStatus,
      localValidationHeadSha,
      currentHeadSha: prHeadSha,
      reviewSummary,
      unresolvedThreadCount,
      actionableThreadCount,
    })) {
      currentHeadCiStatus = "crediblyGreen";
    }
  }
  return buildSnapshotFromPrFacts({
    prData,
    prNumber: pr,
    copilotReviewRequestStatus,
    copilotReviewPresent: reviewSummary.copilotReviewPresent,
    copilotReviewOnCurrentHead: reviewSummary.hasSubmittedReviewOnCurrentHead,
    unresolvedThreadCount,
    actionableThreadCount,
    copilotReviewRoundCount: reviewSummary.completedCopilotReviewRounds,
    lastCopilotRoundMaxSignal,
    ciStatus: currentHeadCiStatus,
    failureDetails,
    excludedFailureDetails,
  });
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseDetectCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  let snapshot;
  let interpretationInput;
  if (options.inputPath !== undefined) {
    const text = await readFile(options.inputPath, "utf8");
    interpretationInput = parseJsonText(text);
    snapshot = normalizeSnapshot(interpretationInput);
  } else {
    snapshot = await autoDetectSnapshot(
      {
        repo: options.repo,
        pr: options.pr,
      },
      { env, ghCommand },
    );
    interpretationInput = snapshot;
  }
  let interpretation;
  const config = await loadDevLoopConfig({ repoRoot: path.resolve(process.cwd()) });
  const refinementConfig = config.errors.length > 0
    ? resolveRefinement({ version: 1 })
    : resolveRefinement(config.config);
  interpretation = interpretLoopState(interpretationInput, refinementConfig);
  const interpretationSummary = summarizeLoopInterpretation(interpretation);
  stdout.write(`${JSON.stringify({
    ok: true,
    snapshot,
    state: interpretation.state,
    allowedTransitions: interpretation.allowedTransitions,
    nextAction: interpretation.nextAction,
    autoRerequestEligible: interpretation.autoRerequestEligible,
    sameHeadCleanConverged: interpretation.sameHeadCleanConverged,
    loopDisposition: interpretationSummary.loopDisposition,
    terminal: interpretationSummary.terminal,
  })}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
