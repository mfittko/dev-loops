#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildParseError,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  parseReviewThreads,
  resolveDraftGateRoundResetMs,
  summarizeCopilotReviews,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildSnapshotFromPrFacts, interpretLoopState } from "@dev-loops/core/loop/copilot-loop-state";
import { loadDevLoopConfig, resolveRefinement } from "@dev-loops/core/config";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const BLOCKED_BY_COPILOT_COMMENT_STATUS = "blocked_by_copilot_comment";
const SUPPRESSED_SAME_HEAD_CLEAN_STATUS = "suppressed_same_head_clean";
const ROUND_CAP_REACHED_STATUS = "round_cap_reached";
const NO_CHANGES_SINCE_LAST_REVIEW_STATUS = "no_changes_since_last_review";
const SUPPRESSED_DRAFT_STATUS = "suppressed_draft";
const USAGE = `Usage: request-copilot-review.mjs --repo <owner/name> --pr <number>
Request Copilot as a reviewer on a GitHub pull request.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --force-rerequest-review  Bypass the round cap when new commits exist since
                            the last Copilot review. Refused when the PR head
                            has not changed since the last review.
Debug:
  DEVLOOPS_DEBUG=1      Emit stderr traces when best-effort same-head clean
                            convergence detection falls back to unsuppressed behavior
Output (stdout, JSON):
  { "ok": true, "status": "requested"|"already-requested"|"unavailable"|"suppressed_same_head_clean"|"blocked_by_copilot_comment"|"round_cap_reached"|"no_changes_since_last_review"|"suppressed_draft",
    "repo": "...", "pr": N, "reviewer": "Copilot", "detail"?: "...",
    "sameHeadCleanConverged"?: true, "violationCommentIds"?: [N], "completedRounds"?: N, "maxRounds"?: N }
Request statuses:
  requested                     Copilot review was successfully requested
  already-requested             Copilot review was already observably in progress; no new request needed
  unavailable                   Copilot review is not enabled/requestable and no in-progress evidence was found
  suppressed_same_head_clean    Current head is already clean-converged; no new request is made
  blocked_by_copilot_comment    A non-Copilot PR comment contains @copilot or /copilot; delete the comment(s) first
  round_cap_reached             Maximum Copilot review rounds reached; no further re-requests will be made
  no_changes_since_last_review  --force-rerequest-review used but PR head has not changed since the last review
  suppressed_draft              PR is in draft state; review requests are blocked until the PR is marked ready for review
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (including unavailable)
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
export function parseRequestCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "force-rerequest-review": { type: "boolean" },
      repo: { type: "string" },
      pr: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    forceRerequestReview: false,
  };
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
    if (token.name === "force-rerequest-review") {
      options.forceRerequestReview = true;
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Requesting Copilot review requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function parseRequestedReviewersPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from gh: ${text.trim() || "<empty>"}`);
  }
  const users = Array.isArray(payload?.users) ? payload.users : [];
  const teams = Array.isArray(payload?.teams) ? payload.teams : [];
  return {
    users,
    teams,
    requested: users.some((user) => isCopilotLogin(user?.login)),
  };
}
function parseReviewsPayload(text, { draftGateResetAtMs = null } = {}) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from gh: ${text.trim() || "<empty>"}`);
  }
  const headSha = typeof payload?.headRefOid === "string" && payload.headRefOid.trim().length > 0
    ? payload.headRefOid.trim()
    : null;
  // Apply the draft-gate round reset so the completed round count matches what
  // detect-pr-gate-coordination-state computes (#896): when the draft gate has
  // re-passed clean on an earlier head, only reviews after that re-pass count.
  const reviewSummary = summarizeCopilotReviews(payload?.reviews, { headSha, draftGateResetAtMs });
  return {
    prData: payload,
    headSha,
    copilotReviewIds: reviewSummary.copilotReviewIds,
    copilotReviewPresent: reviewSummary.copilotReviewPresent,
    hasCopilotPendingReviewOnCurrentHead: reviewSummary.hasPendingReviewOnCurrentHead,
    hasCopilotSubmittedReviewOnCurrentHead: reviewSummary.hasSubmittedReviewOnCurrentHead,
    completedCopilotReviewRounds: reviewSummary.completedCopilotReviewRounds,
  };
}
async function fetchRequestedReviewers({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseRequestedReviewersPayload(result.stdout);
}
async function fetchCopilotReviewIds({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseReviewsPayload(result.stdout);
}

// Re-derive the completed Copilot round count with the draft-gate round reset
// applied, mirroring detect-pr-gate-coordination-state so both scripts agree on the
// completed count and therefore on round-cap-reached (#896). A clean draft_gate
// re-pass on an earlier head resets the count, so post-reset reviews must not be
// counted toward the cap.
//
// Queried lazily — only when the raw (un-reset) count has already hit the cap — so
// the common (under-cap) request path keeps its existing gh-call contract and adds
// no API round-trip. Uses a single issue-comments fetch (the same source the gate
// detector uses for the latest clean draft_gate marker), not the full checkpoint-
// evidence pipeline, to keep the added surface minimal. Best-effort: a fetch failure
// falls back to the raw count, so the cap is never silently disabled.
async function resolveDraftGateAdjustedRounds(options, { env = process.env, ghCommand = "gh" } = {}, before) {
  try {
    const currentHeadSha = typeof before?.prData?.headRefOid === "string" && before.prData.headRefOid.trim().length > 0
      ? before.prData.headRefOid.trim()
      : null;
    const result = await runChild(
      ghCommand,
      ["api", "--paginate", "--slurp", `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`],
      env,
    );
    if (result.code !== 0) {
      return before.completedCopilotReviewRounds ?? 0;
    }
    let comments;
    try {
      const payload = JSON.parse(result.stdout);
      comments = Array.isArray(payload) ? payload.flat() : [];
    } catch {
      return before.completedCopilotReviewRounds ?? 0;
    }
    const gateSummary = summarizeGateReviewComments(comments);
    const draftGateResetAtMs = resolveDraftGateRoundResetMs({ draftGate: gateSummary?.draft_gate, currentHeadSha });
    if (draftGateResetAtMs == null) {
      return before.completedCopilotReviewRounds ?? 0;
    }
    const adjusted = parseReviewsPayload(JSON.stringify(before.prData ?? {}), { draftGateResetAtMs });
    return adjusted.completedCopilotReviewRounds ?? 0;
  } catch {
    return before.completedCopilotReviewRounds ?? 0;
  }
}

async function fetchCopilotReviewState(options, runtime) {
  const requestedReviewers = await fetchRequestedReviewers(options, runtime);
  const reviews = await fetchCopilotReviewIds(options, runtime);
  return {
    requested: requestedReviewers.requested,
    prData: reviews.prData,
    copilotReviewIds: reviews.copilotReviewIds,
    copilotReviewPresent: reviews.copilotReviewPresent,
    hasPendingReviewOnCurrentHead: reviews.hasCopilotPendingReviewOnCurrentHead,
    hasSubmittedReviewOnCurrentHead: reviews.hasCopilotSubmittedReviewOnCurrentHead,
    completedCopilotReviewRounds: reviews.completedCopilotReviewRounds,
  };
}
async function detectSameHeadCleanConvergence(options, runtime, priorReviewState = {}) {
  const {
    requested = false,
    prData = null,
    copilotReviewPresent = false,
    hasPendingReviewOnCurrentHead = false,
    hasSubmittedReviewOnCurrentHead = false,
  } = priorReviewState;
  if (typeof options.sameHeadCleanConverged === "boolean") {
    return options.sameHeadCleanConverged;
  }
  if (hasPendingReviewOnCurrentHead || !hasSubmittedReviewOnCurrentHead || prData === null) {
    return false;
  }
  try {
    const threadsPayload = await fetchGithubReviewThreadsPayload(
      { repo: options.repo, pr: options.pr },
      runtime,
    );
    const parsedThreads = parseReviewThreads(threadsPayload);
    const snapshot = buildSnapshotFromPrFacts({
      prData,
      prNumber: options.pr,
      copilotReviewRequestStatus: hasPendingReviewOnCurrentHead || requested ? "requested" : "none",
      copilotReviewPresent,
      copilotReviewOnCurrentHead: hasSubmittedReviewOnCurrentHead,
      unresolvedThreadCount: parsedThreads.summary.unresolvedThreads,
      actionableThreadCount: parsedThreads.summary.actionableThreads,
      copilotReviewRoundCount: priorReviewState.completedCopilotReviewRounds ?? 0,
    });
    const interpretation = interpretLoopState(snapshot);
    return interpretation.sameHeadCleanConverged;
  } catch (error) {
    if (runtime?.env?.DEVLOOPS_DEBUG === "1") {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[request-copilot-review] same-head clean-convergence detection unavailable: ${detail}\n`);
    }
    return false;
  }
}
async function detectRoundCapAutoRerequestEligibility(options, runtime, priorReviewState = {}, refinementConfig = {}) {
  const {
    requested = false,
    prData = null,
    copilotReviewPresent = false,
    hasPendingReviewOnCurrentHead = false,
    hasSubmittedReviewOnCurrentHead = false,
  } = priorReviewState;
  if (prData === null) {
    return { eligible: false, interpretation: null };
  }
  try {
    const threadsPayload = await fetchGithubReviewThreadsPayload(
      { repo: options.repo, pr: options.pr },
      runtime,
    );
    const parsedThreads = parseReviewThreads(threadsPayload);
    const snapshot = buildSnapshotFromPrFacts({
      prData,
      prNumber: options.pr,
      copilotReviewRequestStatus: hasPendingReviewOnCurrentHead || requested ? "requested" : "none",
      copilotReviewPresent,
      copilotReviewOnCurrentHead: hasSubmittedReviewOnCurrentHead,
      unresolvedThreadCount: parsedThreads.summary.unresolvedThreads,
      actionableThreadCount: parsedThreads.summary.actionableThreads,
      copilotReviewRoundCount: priorReviewState.completedCopilotReviewRounds ?? 0,
    });
    const interpretation = interpretLoopState(snapshot, refinementConfig);
    return {
      eligible: interpretation.state === "ready_to_rerequest_review" && interpretation.autoRerequestEligible === true,
      interpretation,
    };
  } catch (error) {
    if (runtime?.env?.DEVLOOPS_DEBUG === "1") {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[request-copilot-review] round-cap auto-rerequest detection unavailable: ${detail}\n`);
    }
    return { eligible: false, interpretation: null };
  }
}
function getLastCopilotReviewHeadSha(prData) {
  const reviews = Array.isArray(prData?.reviews) ? prData.reviews : [];
  // Only consider submitted (non-PENDING) Copilot reviews.
  // A PENDING review on a stale head could be selected as "most recent"
  // and cause incorrect round-cap bypass decisions.
  const copilotReviews = reviews.filter(
    (r) => r?.state !== "PENDING" && isCopilotLogin(r?.author?.login),
  );
  if (copilotReviews.length === 0) return null;
  // Select the most recent Copilot review: sort by submittedAt descending,
  // falling back to original array position when timestamps are missing
  // (later index = more recent).
  const indexed = copilotReviews.map((r, i) => ({ review: r, index: i }));
  indexed.sort((a, b) => {
    const parseTs = (r) => {
      if (typeof r?.submittedAt === "string") {
        const v = Date.parse(r.submittedAt);
        if (!Number.isNaN(v)) return v;
      }
      if (typeof r?.submitted_at === "string") {
        const v = Date.parse(r.submitted_at);
        if (!Number.isNaN(v)) return v;
      }
      return NaN;
    };
    const aTs = parseTs(a.review);
    const bTs = parseTs(b.review);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs)) return bTs - aTs;
    if (Number.isNaN(aTs) && Number.isNaN(bTs)) return b.index - a.index;
    return Number.isNaN(aTs) ? 1 : -1;
  });
  const lastReview = indexed[0].review;
  // Tolerate both GraphQL commit.oid and REST commit_id shapes
  const sha = lastReview?.commit?.oid ?? lastReview?.commit_id;
  return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
}
function classifyRequestFailure(detail) {
  const normalized = detail.toLowerCase();
  if (
    normalized.includes("not a collaborator") ||
    normalized.includes("not requestable") ||
    normalized.includes("copilot review") ||
    normalized.includes("reviews may only be requested")
  ) {
    return "unavailable";
  }
  return undefined;
}
async function requestCopilotReview({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "edit", String(pr), "--repo", repo, "--add-reviewer", "@copilot"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    const classified = classifyRequestFailure(detail);
    if (classified === "unavailable") {
      let existing;
      try {
        existing = await fetchCopilotReviewIds({ repo, pr }, { env, ghCommand });
      } catch {
        // Best-effort: if gh pr view fails transiently (rate limit, network, auth),
        // return unavailable rather than throwing — the 422 failure is already stable.
        return {
          ok: true,
          status: "unavailable",
          repo,
          pr,
          reviewer: "Copilot",
          detail,
        };
      }
      if (existing.hasCopilotPendingReviewOnCurrentHead || existing.hasCopilotSubmittedReviewOnCurrentHead) {
        return {
          ok: true,
          status: "already-requested",
          repo,
          pr,
          reviewer: "Copilot",
        };
      }
      return {
        ok: true,
        status: "unavailable",
        repo,
        pr,
        reviewer: "Copilot",
        detail,
      };
    }
    throw new Error(`gh command failed: ${detail}`);
  }
  return {
    ok: true,
    status: "requested",
    repo,
    pr,
    reviewer: "Copilot",
  };
}
export async function checkForCopilotComments({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", ".[]"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  let comments;
  try {
    comments = lines.map((line) => JSON.parse(line));
  } catch (e) {
    throw new Error(`Invalid JSON from gh: ${e.message} (${result.stdout.trim().slice(0, 200) || "<empty>"})`);
  }
  if (!Array.isArray(comments)) {
    return { blocked: false, violationCommentIds: [] };
  }
  const violationCommentIds = [];
  for (const comment of comments) {
    const author = comment?.user?.login ?? "";
    const body = comment?.body ?? "";
    if (isCopilotLogin(author)) {
      continue;
    }
    if (/(?:^|\W)(@copilot|\/copilot)(?:$|\W)/i.test(body)) {
      violationCommentIds.push(comment.id);
    }
  }
  return {
    blocked: violationCommentIds.length > 0,
    violationCommentIds,
  };
}
export async function performCopilotReviewRequest(options, { env = process.env, ghCommand = "gh" } = {}) {
  const before = await fetchCopilotReviewState(options, { env, ghCommand });
  if (before.prData?.isDraft) {
    return {
      ok: true,
      status: SUPPRESSED_DRAFT_STATUS,
      repo: options.repo,
      pr: options.pr,
      reviewer: "Copilot",
      detail: "PR is in draft state; review requests are blocked until the PR is marked ready for review.",
    };
  }
  if (!env.GH_SEQUENCE_PATH) {
    const copilotCommentCheck = await checkForCopilotComments(options, { env, ghCommand });
    if (copilotCommentCheck.blocked) {
      return {
        ok: true,
        status: BLOCKED_BY_COPILOT_COMMENT_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: "Non-Copilot PR comment(s) detected containing @copilot or /copilot. Delete the violating comment(s) and re-run this helper instead.",
        violationCommentIds: copilotCommentCheck.violationCommentIds,
      };
    }
  }
  let refinementConfig = { maxCopilotRounds: 5 };
  let maxRounds = 5; // Built-in default; overridden by config when loadable
  try {
    const { config, errors } = await loadDevLoopConfig();
    if (!errors || errors.length === 0) {
      refinementConfig = resolveRefinement(config);
      if (Number.isFinite(refinementConfig.maxCopilotRounds) && refinementConfig.maxCopilotRounds > 0) {
        maxRounds = refinementConfig.maxCopilotRounds;
      }
    }
  } catch {
  }
  // Reconcile the completed-round count with detect-pr-gate-coordination-state (#896):
  // when the raw count has reached the cap, re-derive it with the draft-gate round
  // reset applied. A clean draft_gate re-pass on an earlier head resets the count, so
  // a post-reset PR that detect reports as under-cap must NOT be refused here as
  // cap-reached. Only query checkpoint evidence on this (at/over-cap) path.
  let completedRounds = before.completedCopilotReviewRounds ?? 0;
  if (completedRounds >= maxRounds
      && !before.requested
      && !before.hasPendingReviewOnCurrentHead) {
    completedRounds = await resolveDraftGateAdjustedRounds(options, { env, ghCommand }, before);
  }
  if (completedRounds >= maxRounds
      && !before.requested
      && !before.hasPendingReviewOnCurrentHead) {
    if (!options.forceRerequestReview) {
      const roundCapAutoRerequest = await detectRoundCapAutoRerequestEligibility(
        options,
        { env, ghCommand },
        before,
        refinementConfig,
      );
      if (!roundCapAutoRerequest.eligible) {
        return {
          ok: true,
          status: ROUND_CAP_REACHED_STATUS,
          repo: options.repo,
          pr: options.pr,
          reviewer: "Copilot",
          completedRounds,
          maxRounds,
          detail: `Round cap of ${maxRounds} reached with ${completedRounds} completed rounds. No further re-requests will be made.`,
        };
      }
    }
    // --force-rerequest-review: only bypass when there are new commits since the last review
    const currentHeadSha = typeof before.prData?.headRefOid === "string" && before.prData.headRefOid.trim().length > 0
      ? before.prData.headRefOid.trim()
      : null;
    const lastReviewSha = getLastCopilotReviewHeadSha(before.prData);
    const canCompare = currentHeadSha !== null && lastReviewSha !== null;
    const hasNewCommits = canCompare && currentHeadSha !== lastReviewSha;
    if (!canCompare) {
      return {
        ok: true,
        status: ROUND_CAP_REACHED_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: `Round cap of ${maxRounds} reached with ${completedRounds} completed rounds. --force-rerequest-review was supplied but commit SHA data is unavailable, so change-since-last-review could not be evaluated.`,
        completedRounds,
        maxRounds,
      };
    }
    if (!hasNewCommits) {
      return {
        ok: true,
        status: NO_CHANGES_SINCE_LAST_REVIEW_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: "No changes since last Copilot review. --force-rerequest-review requires new commits on the PR head.",
        completedRounds,
        maxRounds,
      };
    }
    // Has new commits — bypass the round cap and proceed with the request
  }
  const sameHeadCleanConverged = await detectSameHeadCleanConvergence(
    options,
    { env, ghCommand },
    before,
  );
  if (sameHeadCleanConverged) {
    return {
      ok: true,
      status: SUPPRESSED_SAME_HEAD_CLEAN_STATUS,
      repo: options.repo,
      pr: options.pr,
      reviewer: "Copilot",
      sameHeadCleanConverged: true,
      detail: "Current head already has a clean submitted Copilot review; same-head clean-convergence suppression is always enforced.",
    };
  }
  if (before.requested || before.hasPendingReviewOnCurrentHead) {
    return {
      ok: true,
      status: "already-requested",
      repo: options.repo,
      pr: options.pr,
      reviewer: "Copilot",
    };
  }
  const requestResult = await requestCopilotReview(options, { env, ghCommand });
  if (requestResult.status === "unavailable") {
    const after = await fetchCopilotReviewState(options, { env, ghCommand });
    if (after.requested || after.hasPendingReviewOnCurrentHead || after.hasSubmittedReviewOnCurrentHead) {
      return {
        ok: true,
        status: "already-requested",
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
      };
    }
    return {
      ...requestResult,
    };
  }
  if (requestResult.status === "already-requested") {
    return requestResult;
  }
  const after = await fetchCopilotReviewState(options, { env, ghCommand });
  const reviewCountIncreased = after.copilotReviewIds.length > before.copilotReviewIds.length;
  const reviewNowObservablyInProgress = after.requested || after.hasPendingReviewOnCurrentHead || reviewCountIncreased;
  if (!reviewNowObservablyInProgress) {
    throw new Error("Copilot review request did not appear in requested reviewers or fresh/in-progress Copilot reviews after gh pr edit");
  }
  return {
    ...requestResult,
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseRequestCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await performCopilotReviewRequest(options, { env, ghCommand });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
