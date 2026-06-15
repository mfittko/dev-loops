#!/usr/bin/env node
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  parseJsonText,
  parseReviewThreads,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
const USAGE = `Usage: detect-checkpoint-evidence.mjs --repo <owner/name> --pr <number>
Fetch the live PR head SHA and visible PR issue comments, then summarize the
latest valid draft-gate and pre-approval checkpoint verdict comments. Always fail
closed (exit 1) unless both required gate comments exist: a clean draft_gate
comment for the one-time draft boundary and a clean current-head
pre_approval_gate comment.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Output (stdout, JSON; always includes preMergeGateCheck):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 17,
    "currentHeadSha": "abc1234",
    "draftGate": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "mark ready for review",
      "commentId": 101,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "draftGateMarker": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "mark ready for review",
      "contractComplete": true,
      "commentId": 101,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "draftGateSatisfied": true,
    "preApprovalGate": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "await final human approval",
      "commentId": 102,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-102",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "preApprovalGateMarker": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "await final human approval",
      "contractComplete": true,
      "commentId": 102,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-102",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "preMergeGateCheck": {
      "ok": true,
      "failures": []
    }
  }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
Exit codes:
  0  Success (gate evidence is valid)
  1  Argument error, gh failure, malformed gh JSON, or missing required pre-merge gate evidence.`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectCheckpointEvidenceCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
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
    if (token === "--require-before-merge") {
      throw parseError(`--require-before-merge has been removed: gate evidence enforcement is now always-on by default. Omit the flag.`);
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-checkpoint-evidence requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: `gh ${args.slice(0, 2).join(" ")}` });
}
function normalizeIssueCommentsPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("Invalid gh issue comments payload: expected an array");
  }
  if (payload.every((entry) => Array.isArray(entry))) {
    return payload.flat();
  }
  return payload;
}
function normalizePrReviewsPayload(payload) {
  if (!Array.isArray(payload)) return [];
  const flat = payload.every((entry) => Array.isArray(entry)) ? payload.flat() : payload;
  return flat
    .filter((r) => r && typeof r === "object" && r.state !== "PENDING" && typeof r.submitted_at === "string" && r.submitted_at.trim().length > 0 && typeof r.body === "string" && r.body.trim().length > 0)
    .map((r) => ({
      id: r.id,
      body: r.body,
      html_url: typeof r.html_url === "string" ? r.html_url : null,
      created_at: typeof r.submitted_at === "string" ? r.submitted_at : null,
      updated_at: typeof r.submitted_at === "string" ? r.submitted_at : null,
    }));
}
function emptyGateSummary() {
  return {
    visible: false,
    headSha: null,
    verdict: null,
    findingsSummary: null,
    nextAction: null,
    commentId: null,
    commentUrl: null,
    updatedAt: null,
  };
}
function normalizeGateSummary(summary) {
  if (!summary) {
    return emptyGateSummary();
  }
  return {
    visible: true,
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
function emptyGateMarkerSummary() {
  return {
    visible: false,
    headSha: null,
    verdict: null,
    findingsSummary: null,
    nextAction: null,
    contractComplete: false,
    commentId: null,
    commentUrl: null,
    updatedAt: null,
  };
}
function normalizeGateMarkerSummary(summary) {
  if (!summary) {
    return emptyGateMarkerSummary();
  }
  return {
    visible: true,
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    contractComplete: summary.contractComplete === true,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
export function buildPreMergeGateCheck(evidence, unresolvedThreadCount = null, staleRunnerCheck = null) {
  const failures = [];
  if (!(evidence.draftGate.visible && evidence.draftGate.verdict === "clean")) {
    failures.push("missing visible clean draft_gate comment");
  }
  const preApproval = evidence.preApprovalGateMarker;
  if (!(
    preApproval.visible
    && preApproval.contractComplete
    && preApproval.verdict === "clean"
    && preApproval.headSha === evidence.currentHeadSha
  )) {
    failures.push("missing visible clean current-head pre_approval_gate comment");
  }
  if (typeof unresolvedThreadCount === "number" && unresolvedThreadCount !== 0) {
    if (unresolvedThreadCount === -1) {
      failures.push("could not fetch review thread state from GitHub API; re-run gate evidence check when API connectivity is restored");
    } else {
      failures.push(`unresolved review threads present (${unresolvedThreadCount}); must resolve all threads before merge`);
    }
  }
  if (staleRunnerCheck && !staleRunnerCheck.ok) {
    for (const failure of staleRunnerCheck.failures) {
      failures.push(failure);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
  };
}
export async function detectCheckpointEvidence(options, { env = process.env, ghCommand = "gh", cwd = process.cwd() } = {}) {
  const runnerOwnership = await ensureAsyncRunnerOwnership({
    repo: options.repo,
    pr: options.pr,
    env,
    cwd,
    claimIfMissing: false,
    requireExisting: false,
  });
  if (!runnerOwnership.ok) {
    const error = new Error(runnerOwnership.message);
    error.runnerOwnership = runnerOwnership;
    throw error;
  }
  const staleRunnerDetection = await detectStaleRunner({
    repo: options.repo,
    pr: options.pr,
    cwd,
  });
  if (!staleRunnerDetection.ok) {
    const error = new Error(staleRunnerDetection.message);
    error.staleRunner = staleRunnerDetection;
    throw error;
  }
  const prPayload = await runGhJson(["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"], { env, ghCommand });
  const commentsPayload = normalizeIssueCommentsPayload(await runGhJson(["api", "--paginate", "--slurp", `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`], { env, ghCommand }));
  const currentHeadSha = typeof prPayload?.headRefOid === "string" && prPayload.headRefOid.trim().length > 0
    ? prPayload.headRefOid.trim()
    : null;
  if (!currentHeadSha) {
    throw new Error("Invalid gh pr view payload: missing headRefOid");
  }
  // Also scan PR reviews for gate comments posted via the review API.
  // This prevents duplicates when an escape-hatch path posted a gate verdict
  // as a PR review rather than an issue comment (root cause 3 from issue #692).
  let prReviews = [];
  try {
    const reviewsRaw = await runGhJson(["api", "--paginate", "--slurp", `repos/${options.repo}/pulls/${options.pr}/reviews?per_page=100`], { env, ghCommand });
    prReviews = normalizePrReviewsPayload(reviewsRaw);
  } catch {
    // Graceful fallback: PR reviews fetch failure is non-fatal.
    // We continue with issue comments only.
  }
  const allComments = [...commentsPayload, ...prReviews];
  const commentSummary = summarizeGateReviewComments(allComments);
  const markerSummary = summarizeGateReviewCommentMarkers(allComments, { headSha: currentHeadSha });
  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    draftGate: normalizeGateSummary(commentSummary.draft_gate),
    preApprovalGate: normalizeGateSummary(commentSummary.pre_approval_gate),
    draftGateMarker: normalizeGateMarkerSummary(markerSummary.draft_gate),
    preApprovalGateMarker: normalizeGateMarkerSummary(markerSummary.pre_approval_gate),
    draftGateSatisfied: commentSummary.draft_gate?.verdict === "clean" && typeof commentSummary.draft_gate?.headSha === "string",
    ...(runnerOwnership.status !== "skipped_no_async_run_id" ? { runnerOwnership } : {}),
    staleRunner: {
      status: staleRunnerDetection.status,
      activeRun: staleRunnerDetection.activeRun,
      exitSignals: staleRunnerDetection.exitSignal?.signals ?? [],
      staleRunner: staleRunnerDetection.staleRunner,
      maxAgeMs: staleRunnerDetection.maxAgeMs,
      filePath: staleRunnerDetection.filePath,
    },
  };
}
async function main() {
  let options;
  try {
    options = parseDetectCheckpointEvidenceCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await detectCheckpointEvidence(options);
    let unresolvedThreadCount = -1;
    try {
      const threadsPayload = await fetchGithubReviewThreadsPayload(options, { env: process.env });
      const parsedThreads = parseReviewThreads(threadsPayload);
      unresolvedThreadCount = parsedThreads?.summary?.unresolvedThreads ?? 0;
    } catch {
      unresolvedThreadCount = -1;
    }
    const staleRunnerCheck = {
      ok: result.staleRunner.status === "fresh_runner" || result.staleRunner.status === "no_owner_record",
      failures: result.staleRunner.status === "stale_runner"
        ? [`stale runner: ${result.staleRunner.staleRunner?.runId} claimed ${result.staleRunner.staleRunner?.claimedAgeMs}ms ago, last updated ${result.staleRunner.staleRunner?.updatedAgeMs}ms ago (max age ${result.staleRunner.staleRunner?.maxAgeMs}ms)`]
        : result.staleRunner.status === "exit_signal_recorded"
        ? [`exit signal recorded for run ${result.staleRunner.activeRun?.runId}: refuse to merge`]
        : [],
    };
    const preMergeGateCheck = buildPreMergeGateCheck(result, unresolvedThreadCount, staleRunnerCheck);
    const output = { ...result, preMergeGateCheck, staleRunnerCheck };
    if (!preMergeGateCheck.ok) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: `Pre-merge gate evidence check failed: ${preMergeGateCheck.failures.join("; ")}`,
        repo: result.repo,
        pr: result.pr,
        currentHeadSha: result.currentHeadSha,
        preMergeGateCheck,
        staleRunnerCheck,
        staleRunner: result.staleRunner,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    if (error && typeof error === "object" && "staleRunner" in error && error.staleRunner) {
      const staleRunnerCheck = {
        ok: false,
        failures: error.staleRunner.status === "stale_runner"
          ? [`stale runner: ${error.staleRunner.staleRunner?.runId} claimed ${error.staleRunner.staleRunner?.claimedAgeMs}ms ago, last updated ${error.staleRunner.staleRunner?.updatedAgeMs}ms ago (max age ${error.staleRunner.staleRunner?.maxAgeMs}ms)`]
          : error.staleRunner.status === "exit_signal_recorded"
          ? [`exit signal recorded for run ${error.staleRunner.activeRun?.runId}: refuse to merge`]
          : [],
      };
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: error.staleRunner.error,
        status: error.staleRunner.status,
        message: error.staleRunner.message,
        staleRunner: {
          status: error.staleRunner.status,
          activeRun: error.staleRunner.activeRun,
          exitSignals: error.staleRunner.exitSignal?.signals ?? [],
          staleRunner: error.staleRunner.staleRunner,
          maxAgeMs: error.staleRunner.maxAgeMs,
          filePath: error.staleRunner.filePath,
        },
        staleRunnerCheck,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    if (error && typeof error === "object" && "runnerOwnership" in error && error.runnerOwnership) {
      process.stderr.write(`${JSON.stringify(error.runnerOwnership)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
