#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildParseError,
  containsBareCopilotSummon,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  parseReviewThreads,
  resolveCopilotReviewPresence,
  resolveDraftGateRoundResetMs,
  summarizeCopilotReviews,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { fetchGateEvidenceComments } from "./_gate-finding-surface.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildSnapshotFromPrFacts, interpretLoopState } from "@dev-loops/core/loop/copilot-loop-state";
import { loadDevLoopConfig, resolveEffectiveCopilotRoundCap, resolveRefinement } from "@dev-loops/core/config";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveCopilotReviewRequestStatus } from "../loop/_copilot-review-request-status.mjs";
import { getLastCopilotReviewHeadSha, resolveCarriedConvergence, resolvePostConvergenceReviewSuppressed } from "../loop/_copilot-convergence-carry.mjs";
const BLOCKED_BY_COPILOT_COMMENT_STATUS = "blocked_by_copilot_comment";
const SUPPRESSED_SAME_HEAD_CLEAN_STATUS = "suppressed_same_head_clean";
const ROUND_CAP_REACHED_STATUS = "round_cap_reached";
const NO_CHANGES_SINCE_LAST_REVIEW_STATUS = "no_changes_since_last_review";
const SUPPRESSED_POST_CONVERGENCE_DOCS_ONLY_STATUS = "suppressed_post_convergence_docs_only";
const SUPPRESSED_DRAFT_STATUS = "suppressed_draft";
// The app-style Copilot reviewer login. The REST requested_reviewers endpoint
// only registers the Copilot bot under this exact `[bot]`-suffixed login.
const COPILOT_REVIEWER_BOT_LOGIN = "copilot-pull-request-reviewer[bot]";
// The requested-reviewer / review-list reads that verify a review request
// landed are eventually consistent: an immediate read can still see stale
// (empty) state even though the request already succeeded. Re-read on this
// fixed backoff before declaring failure — bounded, not open-ended, so a
// genuine failure (Copilot truly unavailable on the repo) still fails closed
// after ~30s total instead of hanging indefinitely.
const VERIFICATION_RETRY_DELAYS_MS = [5000, 10000, 15000];
const USAGE = `Usage: request-copilot-review.mjs --repo <owner/name> --pr <number>
Request Copilot as a reviewer on a GitHub pull request.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --force-rerequest-review  Bypass the round cap when new commits exist since
                            the last Copilot review. Refused when the PR head
                            has not changed since the last review.
  --lightweight             This PR is light-dispatched (#1210): enforce the
                            composed round cap min(localImplementation.lightMode.
                            maxCopilotRounds ?? 1, refinement.maxCopilotRounds)
                            instead of refinement.maxCopilotRounds alone.
Verification:
  After requesting Copilot as a reviewer, the requested-reviewer/review-list
  read is retried on a fixed backoff (~30s total) before declaring failure,
  because that read is eventually consistent and can briefly still show stale
  (empty) state right after a genuinely successful request. The request
  itself is issued exactly once and never re-issued per probe. A GraphQL
  cross-check (reviewRequests + review nodes, any state incl. PENDING) is
  additionally consulted, since it observes an active request/in-progress
  Copilot review that the REST reads above can miss (#1980). If the POST
  succeeded (exit 0) but nothing is observable via either surface within the
  window, this reports "requested" with an eventually-consistent detail
  instead of failing — a genuine 422 (Copilot truly unavailable) still fails
  as "unavailable".
Debug:
  DEVLOOPS_DEBUG=1      Emit stderr traces when best-effort same-head clean
                            convergence detection falls back to unsuppressed behavior
Output (stdout, JSON):
  { "ok": true, "status": "requested"|"already-requested"|"unavailable"|"suppressed_same_head_clean"|"blocked_by_copilot_comment"|"round_cap_reached"|"no_changes_since_last_review"|"suppressed_post_convergence_docs_only"|"suppressed_draft",
    "repo": "...", "pr": N, "reviewer": "Copilot", "detail"?: "...",
    "sameHeadCleanConverged"?: true, "violationCommentIds"?: [N], "completedRounds"?: N, "maxRounds"?: N,
    "configWarning"?: "..." (present only when --lightweight and dev-loop config failed to load/validate;
                             the lightweight default cap of 1 was applied instead of the full-PR default) }
Request statuses:
  requested                     Copilot review was successfully requested
  already-requested             Copilot review was already observably in progress; no new request needed
  unavailable                   Copilot review is not enabled/requestable and no in-progress evidence was found
  suppressed_same_head_clean    Current head is already clean-converged; no new request is made
  blocked_by_copilot_comment    A non-Copilot PR comment contains @copilot or /copilot; delete the comment(s) first
  round_cap_reached             Maximum Copilot review rounds reached; no further re-requests will be made
  no_changes_since_last_review  --force-rerequest-review used but PR head has not changed since the last review
  suppressed_post_convergence_docs_only  Carried convergence, at or below the round cap. Returned only when
                                all of these hold: no request is outstanding, zero review threads are unresolved,
                                the delta since the last Copilot-reviewed head is a provable pure doc/prose bump OR an
                                integrate-only base-move (base-relative reduction empties the delta), and the prior
                                review is not a body-only changes-recommended/unrecognized review (unless a trusted
                                copilot-body-disposition record names it for the current head). The gate
                                coordination detector reports postConvergenceReviewSuppressed from the same shared
                                predicate, so pre_approval_gate is legal on exactly these heads. Any unresolved
                                thread or code/test/config/CI/unclassifiable delta re-opens the round. The round-cap
                                return carries completedRounds/maxRounds; the below-cap return omits them. An
                                operator suppression marker written by withdraw-copilot-review-request.mjs for this
                                exact head is honored under the same thread and delta checks; any further push
                                invalidates it.
  suppressed_draft              PR is in draft state; review requests are blocked until the PR is marked ready for review
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Status contract: "ok": true means the helper ran without error, NOT that a
review was placed. Callers MUST branch on "status", never on "ok" truthiness
alone — every non-"requested" status (including blocked_by_copilot_comment)
is a caller-must-branch outcome, not a silent success.
--silent exit code: 0 only when status is "requested" (a new request was just
placed this run); non-zero for every other status, including
already-requested/suppressed_same_head_clean/unavailable/blocked_by_copilot_comment/
round_cap_reached/no_changes_since_last_review/suppressed_post_convergence_docs_only/
suppressed_draft. Without
--silent the JSON body always prints regardless of status. --jq combined with
--silent keeps the shared jq-stream truthiness semantics (exit reflects the
filtered value) and is exempt from the status-based rule above.
Exit codes:
  0  Success (including unavailable); with --silent, only when status is "requested"
  1  Argument error, gh failure, or (--silent) any non-"requested" status
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
export function parseRequestCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "force-rerequest-review": { type: "boolean" },
      lightweight: { type: "boolean" },
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
    lightweight: false,
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
    if (token.name === "lightweight") {
      options.lightweight = true;
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
  // detect-pr-gate-coordination-state computes: when the draft gate has
  // re-passed clean on an earlier head, only reviews after that re-pass count.
  const reviewSummary = summarizeCopilotReviews(payload?.reviews, { headSha, draftGateResetAtMs });
  return {
    prData: payload,
    headSha,
    copilotReviewIds: reviewSummary.copilotReviewIds,
    copilotReviewPresent: reviewSummary.copilotReviewPresent,
    hasCopilotPendingReviewOnCurrentHead: reviewSummary.hasPendingReviewOnCurrentHead,
    hasCopilotSubmittedReviewOnCurrentHead: reviewSummary.hasSubmittedReviewOnCurrentHead,
    latestSubmittedReviewOnCurrentHeadAt: reviewSummary.latestSubmittedReviewOnCurrentHeadAt ?? null,
    completedCopilotReviewRounds: reviewSummary.completedCopilotReviewRounds,
    hasBodyFindingOnCurrentHead: reviewSummary.hasBodyFindingOnCurrentHead,
  };
}
async function fetchRequestedReviewers({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
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
async function fetchCopilotReviewIds({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
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

// Re-derives the completed round count with the draft-gate round reset applied
// so it agrees with detect-pr-gate-coordination-state: a clean
// draft_gate re-pass on an earlier head resets the count, excluding post-reset
// reviews from the cap. Queried lazily, only once the raw count already hits
// the cap, so the common under-cap path adds no API round-trip; reuses the
// shared gate-evidence comment reader, not the full checkpoint pipeline.
// Best-effort: a fetch failure falls back to the raw count, never disabling
// the cap.
async function resolveDraftGateAdjustedRounds(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}, before) {
  try {
    const currentHeadSha = typeof before?.prData?.headRefOid === "string" && before.prData.headRefOid.trim().length > 0
      ? before.prData.headRefOid.trim()
      : null;
    const comments = await fetchGateEvidenceComments(
      { repo: options.repo, pr: options.pr },
      { env, ghCommand, runChild },
    );
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

// Review-surface presence: Copilot is present when it is a requested reviewer
// OR has submitted any review on this PR — never decided by assignee
// membership. A reviewer-configured repo (`copilot-pull-request-reviewer[bot]`)
// auto-reviews without appearing in requested_reviewers and `@copilot` can be a
// silent no-op, so prior submitted reviews prove presence and must not be
// misreported as "Copilot absent / not enabled".
function isReviewNowObservablyInProgress(before, after) {
  const reviewCountIncreased = after.copilotReviewIds.length > before.copilotReviewIds.length;
  const reviewPresence = resolveCopilotReviewPresence({
    requested: after.requested,
    reviews: after.prData?.reviews ?? [],
  });
  return after.requested
    || after.hasPendingReviewOnCurrentHead
    || reviewCountIncreased
    || reviewPresence.present;
}
// Shared verification-read step: re-fetch review state and check presence in
// one call, so the initial post-request read and every in-loop retry read below
// share one implementation instead of two copies that could drift.
async function checkReviewObservablyInProgress(options, runtime, before) {
  const after = await fetchCopilotReviewState(options, runtime);
  return isReviewNowObservablyInProgress(before, after);
}

// GraphQL verification surface: the two REST reads above go blind
// once a request transitions into an in-progress review (GET
// requested_reviewers empties out; `gh pr view --json reviews` never returns
// another actor's PENDING review). GraphQL's reviewRequests/review nodes (any
// state, incl. PENDING) DO observe both. VERIFICATION only, never a mutation
// path. Fail-soft: any gh/parse error here means "not observed", never a
// throw, since this signal only ever ADDS a success path.
const COPILOT_REVIEW_GRAPHQL_QUERY = [
  "query($owner: String!, $name: String!, $pr: Int!) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $pr) {",
  "      reviewRequests(first: 20) {",
  "        nodes {",
  "          requestedReviewer {",
  "            __typename",
  "            ... on Bot { login }",
  "            ... on User { login }",
  "          }",
  "        }",
  "      }",
  "      reviews(last: 20) {",
  "        nodes {",
  "          state",
  "          author { login }",
  "          commit { oid }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");
export async function isCopilotReviewObservableViaGraphql(
  { repo, pr, headSha = null },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {},
) {
  try {
    const { owner, name } = parseRepoSlug(repo);
    const result = await runChild(
      ghCommand,
      [
        "api",
        "graphql",
        "--field",
        `owner=${owner}`,
        "--field",
        `name=${name}`,
        "--field",
        `pr=${pr}`,
        "--field",
        `query=${COPILOT_REVIEW_GRAPHQL_QUERY}`,
      ],
      env,
    );
    if (result.code !== 0) return false;
    const payload = JSON.parse(result.stdout);
    const pullRequest = payload?.data?.repository?.pullRequest;
    const requestNodes = Array.isArray(pullRequest?.reviewRequests?.nodes) ? pullRequest.reviewRequests.nodes : [];
    if (requestNodes.some((node) => isCopilotLogin(node?.requestedReviewer?.login))) {
      return true;
    }
    const reviewNodes = Array.isArray(pullRequest?.reviews?.nodes) ? pullRequest.reviews.nodes : [];
    return reviewNodes.some((node) => {
      if (!isCopilotLogin(node?.author?.login)) return false;
      // Only current-head reviews count — a stale review on an old head must
      // not be misread as "the current request/round is already covered"
      // (mirrors the REST hasPendingReviewOnCurrentHead head-scoping above).
      // Fail CLOSED when the head SHA itself is unverifiable (null): an
      // unverifiable head must never satisfy this check on its own — the
      // independent reviewRequests branch above still covers an active
      // Copilot review request regardless of head SHA availability.
      if (headSha === null) return false;
      return node?.commit?.oid === headSha;
    });
  } catch {
    return false;
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
    latestSubmittedReviewOnCurrentHeadAt: reviews.latestSubmittedReviewOnCurrentHeadAt ?? null,
    completedCopilotReviewRounds: reviews.completedCopilotReviewRounds,
    hasBodyFindingOnCurrentHead: reviews.hasBodyFindingOnCurrentHead ?? false,
  };
}
async function detectSameHeadCleanConvergence(options, runtime, priorReviewState = {}, refinementConfig = {}) {
  const {
    requested = false,
    prData = null,
    copilotReviewPresent = false,
    hasPendingReviewOnCurrentHead = false,
    hasSubmittedReviewOnCurrentHead = false,
    latestSubmittedReviewOnCurrentHeadAt = null,
    hasBodyFindingOnCurrentHead = false,
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
    const copilotReviewRequestStatus = await resolveCopilotReviewRequestStatus(
      {
        repo: options.repo,
        pr: options.pr,
        reviewSummary: { hasPendingReviewOnCurrentHead, hasSubmittedReviewOnCurrentHead, latestSubmittedReviewOnCurrentHeadAt },
        copilotRequested: requested,
      },
      runtime,
    );
    const snapshot = buildSnapshotFromPrFacts({
      prData,
      prNumber: options.pr,
      copilotReviewRequestStatus,
      copilotReviewPresent,
      copilotReviewOnCurrentHead: hasSubmittedReviewOnCurrentHead,
      unresolvedThreadCount: parsedThreads.summary.unresolvedThreads,
      actionableThreadCount: parsedThreads.summary.actionableThreads,
      copilotReviewRoundCount: priorReviewState.completedCopilotReviewRounds ?? 0,
      copilotBodyFeedbackUnresolved: hasBodyFindingOnCurrentHead,
    });
    const interpretation = interpretLoopState(snapshot, refinementConfig);
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
    latestSubmittedReviewOnCurrentHeadAt = null,
    hasBodyFindingOnCurrentHead = false,
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
    const copilotReviewRequestStatus = await resolveCopilotReviewRequestStatus(
      {
        repo: options.repo,
        pr: options.pr,
        reviewSummary: { hasPendingReviewOnCurrentHead, hasSubmittedReviewOnCurrentHead, latestSubmittedReviewOnCurrentHeadAt },
        copilotRequested: requested,
      },
      runtime,
    );
    const snapshot = buildSnapshotFromPrFacts({
      prData,
      prNumber: options.pr,
      copilotReviewRequestStatus,
      copilotReviewPresent,
      copilotReviewOnCurrentHead: hasSubmittedReviewOnCurrentHead,
      unresolvedThreadCount: parsedThreads.summary.unresolvedThreads,
      actionableThreadCount: parsedThreads.summary.actionableThreads,
      copilotReviewRoundCount: priorReviewState.completedCopilotReviewRounds ?? 0,
      copilotBodyFeedbackUnresolved: hasBodyFindingOnCurrentHead,
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
async function requestCopilotReview({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  // REST requested_reviewers with the app-style `[bot]`-suffixed login:
  // `gh pr edit --add-reviewer @copilot` / the GraphQL requestReviews
  // mutation silently register no reviewer on repos whose Copilot reviewer is
  // the bot, and the plain (non-`[bot]`) login 422s. A genuine 422 (Copilot
  // truly unavailable) is still classified `unavailable` below.
  const result = await runChild(
    ghCommand,
    [
      "api",
      `repos/${repo}/pulls/${pr}/requested_reviewers`,
      "-X",
      "POST",
      "-f",
      `reviewers[]=${COPILOT_REVIEWER_BOT_LOGIN}`,
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    const classified = classifyRequestFailure(detail);
    if (classified === "unavailable") {
      let existing;
      try {
        existing = await fetchCopilotReviewIds({ repo, pr }, { env, ghCommand, runChild });
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
export async function checkForCopilotComments({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
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
    // Exempt bare-text occurrences inside inline code spans/fenced blocks: a
    // gate-evidence comment legitimately quotes the anti-summon rule itself.
    if (containsBareCopilotSummon(body)) {
      violationCommentIds.push(comment.id);
    }
  }
  return {
    blocked: violationCommentIds.length > 0,
    violationCommentIds,
  };
}
export async function performCopilotReviewRequest(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    runChild = defaultRunChild,
    delayImpl = delay,
    repoRoot = process.cwd(),
  } = {},
) {
  const runtime = { env, ghCommand, runChild };
  const before = await fetchCopilotReviewState(options, runtime);
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
    const copilotCommentCheck = await checkForCopilotComments(options, runtime);
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
  // Operator-marker suppression, checked BEFORE the round-cap logic so a
  // below-cap re-request cannot immediately re-strand the withdrawn head. The
  // shared resolver is the one the gate coordination detector calls; it
  // refuses on any unresolved thread and re-verifies the delta live.
  const currentHeadSha = typeof before.prData?.headRefOid === "string" && before.prData.headRefOid.trim().length > 0
    ? before.prData.headRefOid.trim()
    : null;
  if (currentHeadSha && !before.requested && !before.hasPendingReviewOnCurrentHead && !before.hasSubmittedReviewOnCurrentHead) {
    const markerSuppressed = await resolvePostConvergenceReviewSuppressed(
      { repo: options.repo, pr: options.pr, currentHeadSha, prData: before.prData, copilotReviewRequestStatus: "none" },
      { ...runtime, checkpointDir: options.checkpointDir },
    );
    if (markerSuppressed) {
      return {
        ok: true,
        status: SUPPRESSED_POST_CONVERGENCE_DOCS_ONLY_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: "An operator explicitly withdrew a stranded Copilot review request for this exact head; no review thread is unresolved and the delta since Copilot's last submitted review is still provably docs-only or integrate-only, so no fresh Copilot round is forced. The prior converged Copilot review still stands — proceed to the gate.",
      };
    }
  }
  // The carried-convergence sites below run only when no request is
  // outstanding (the cap site and the below-cap site both sit behind
  // !requested && !pending), so the shared predicate sees status "none".
  const resolveCarried = () => resolveCarriedConvergence(
    { repo: options.repo, pr: options.pr, currentHeadSha, prData: before.prData, copilotReviewRequestStatus: "none" },
    runtime,
  );
  let refinementConfig = { maxCopilotRounds: 5 };
  let maxRounds = 5; // Built-in default; overridden by config when loadable
  // Lightweight fallback when config is unreadable/invalid: fail toward the
  // SAFE (smaller) lightweight cap instead of silently inheriting the
  // full-PR default of 5 above, which would let a light-dispatched PR run
  // far more review rounds than intended whenever the config can't be read.
  const LIGHTWEIGHT_DEFAULT_CAP = 1;
  let configWarning = null;
  try {
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    if (!errors || errors.length === 0) {
      refinementConfig = resolveRefinement(config);
      // Light-dispatched PRs enforce the COMPOSED cap —
      // min(lightMode.maxCopilotRounds ?? 1, refinement.maxCopilotRounds) — so
      // this enforcement backstop cannot permit rounds beyond the lightweight cap.
      const effectiveCap = options.lightweight
        ? resolveEffectiveCopilotRoundCap(config, { lightweight: true })
        : refinementConfig.maxCopilotRounds;
      // >= 0 (not > 0): maxCopilotRounds: 0 is documented as "disable Copilot
      // rounds"; it must be honored as an immediate refusal, not silently
      // ignored in favor of the built-in default of 5.
      if (Number.isFinite(effectiveCap) && effectiveCap >= 0) {
        maxRounds = effectiveCap;
      }
      if (options.lightweight) {
        refinementConfig = { ...refinementConfig, maxCopilotRounds: effectiveCap };
      }
    } else if (options.lightweight) {
      maxRounds = LIGHTWEIGHT_DEFAULT_CAP;
      refinementConfig = { ...refinementConfig, maxCopilotRounds: LIGHTWEIGHT_DEFAULT_CAP };
      configWarning = `dev-loop config could not be validated; using the lightweight default cap of ${LIGHTWEIGHT_DEFAULT_CAP} instead of the full-PR default. errors=${JSON.stringify(errors)}`;
    }
  } catch (err) {
    if (options.lightweight) {
      maxRounds = LIGHTWEIGHT_DEFAULT_CAP;
      refinementConfig = { ...refinementConfig, maxCopilotRounds: LIGHTWEIGHT_DEFAULT_CAP };
      configWarning = `dev-loop config could not be loaded; using the lightweight default cap of ${LIGHTWEIGHT_DEFAULT_CAP} instead of the full-PR default. error=${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Every remaining return in this function is config-dependent (round-cap
  // decisions, the request itself); surface a config-load fallback on all of
  // them rather than just the path a given test happens to exercise.
  const withConfigWarning = (result) => (configWarning ? { ...result, configWarning } : result);
  // Reconcile the completed-round count with detect-pr-gate-coordination-state:
  // when the raw count has reached the cap, re-derive it with the draft-gate round
  // reset applied. A clean draft_gate re-pass on an earlier head resets the count, so
  // a post-reset PR that detect reports as under-cap must NOT be refused here as
  // cap-reached. Only query checkpoint evidence on this (at/over-cap) path.
  let completedRounds = before.completedCopilotReviewRounds ?? 0;
  // Tracks whether the cap path already evaluated the convergence-carry decision
  // below, so the below-cap consumption site does not double-compare.
  let convergenceCarryEvaluated = false;
  if (completedRounds >= maxRounds
      && !before.requested
      && !before.hasPendingReviewOnCurrentHead) {
    completedRounds = await resolveDraftGateAdjustedRounds(options, runtime, before);
  }
  if (completedRounds >= maxRounds
      && !before.requested
      && !before.hasPendingReviewOnCurrentHead) {
    if (!options.forceRerequestReview) {
      const roundCapAutoRerequest = await detectRoundCapAutoRerequestEligibility(
        options,
        runtime,
        before,
        refinementConfig,
      );
      if (!roundCapAutoRerequest.eligible) {
        return withConfigWarning({
          ok: true,
          status: ROUND_CAP_REACHED_STATUS,
          repo: options.repo,
          pr: options.pr,
          reviewer: "Copilot",
          completedRounds,
          maxRounds,
          detail: `Round cap of ${maxRounds} reached with ${completedRounds} completed rounds. No further re-requests will be made.`,
        });
      }
    }
    // --force-rerequest-review: only bypass when there are new commits since the last review
    const lastReviewSha = getLastCopilotReviewHeadSha(before.prData);
    const canCompare = currentHeadSha !== null && lastReviewSha !== null;
    const hasNewCommits = canCompare && currentHeadSha !== lastReviewSha;
    if (!canCompare) {
      return withConfigWarning({
        ok: true,
        status: ROUND_CAP_REACHED_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: `Round cap of ${maxRounds} reached with ${completedRounds} completed rounds. --force-rerequest-review was supplied but commit SHA data is unavailable, so change-since-last-review could not be evaluated.`,
        completedRounds,
        maxRounds,
      });
    }
    if (!hasNewCommits) {
      return withConfigWarning({
        ok: true,
        status: NO_CHANGES_SINCE_LAST_REVIEW_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: "No changes since last Copilot review. --force-rerequest-review requires new commits on the PR head.",
        completedRounds,
        maxRounds,
      });
    }
    // At the round cap, a carried convergence (shared predicate: docs-only or
    // integrate-only delta, zero unresolved threads) must not force a fresh
    // blocking round.
    const convergence = await resolveCarried();
    if (convergence.carried) {
      return withConfigWarning({
        ok: true,
        status: SUPPRESSED_POST_CONVERGENCE_DOCS_ONLY_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: `Post-convergence head bump is provably outside Copilot's review surface (${convergence.reason}); no fresh Copilot round is forced. The prior converged Copilot review still stands — proceed to the gate.`,
        completedRounds,
        maxRounds,
      });
    }
    convergenceCarryEvaluated = true;
    // Has new (review-relevant) commits — bypass the round cap and proceed with the request
  }
  const sameHeadCleanConverged = await detectSameHeadCleanConvergence(
    options,
    runtime,
    before,
    refinementConfig,
  );
  if (sameHeadCleanConverged) {
    return withConfigWarning({
      ok: true,
      status: SUPPRESSED_SAME_HEAD_CLEAN_STATUS,
      repo: options.repo,
      pr: options.pr,
      reviewer: "Copilot",
      sameHeadCleanConverged: true,
      detail: "Current head already has a clean submitted Copilot review; same-head clean-convergence suppression is always enforced.",
    });
  }
  if (before.requested || before.hasPendingReviewOnCurrentHead) {
    return withConfigWarning({
      ok: true,
      status: "already-requested",
      repo: options.repo,
      pr: options.pr,
      reviewer: "Copilot",
    });
  }
  // Below the round cap, a carried convergence must NOT force a redundant
  // Copilot round — consume the same shared predicate the cap path uses. Skipped when the cap path
  // already evaluated it (avoids a double compare on the cap+genuine-change
  // fall-through) and when there is no prior submitted review / no head advance
  // (fail-safe: a genuine PR-own change or a first review still requests).
  if (!convergenceCarryEvaluated) {
    const convergence = await resolveCarried();
    if (convergence.carried) {
      return withConfigWarning({
        ok: true,
        status: SUPPRESSED_POST_CONVERGENCE_DOCS_ONLY_STATUS,
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
        detail: `Post-convergence head bump is provably outside Copilot's review surface (${convergence.reason}); no fresh Copilot round is forced. The prior converged Copilot review still stands — proceed to the gate.`,
      });
    }
  }
  const requestResult = await requestCopilotReview(options, runtime);
  if (requestResult.status === "unavailable") {
    const after = await fetchCopilotReviewState(options, runtime);
    if (after.requested || after.hasPendingReviewOnCurrentHead || after.hasSubmittedReviewOnCurrentHead) {
      return withConfigWarning({
        ok: true,
        status: "already-requested",
        repo: options.repo,
        pr: options.pr,
        reviewer: "Copilot",
      });
    }
    return withConfigWarning({
      ...requestResult,
    });
  }
  if (requestResult.status === "already-requested") {
    return withConfigWarning(requestResult);
  }
  // Bounded retry against the read-after-write race documented above: only the
  // verification READ repeats here, never the requested_reviewers POST itself. A
  // transient throw from ANY verification read — the initial post-request read
  // included — consumes the next scheduled delay and re-probes instead of
  // aborting immediately; the error only propagates if the final attempt in
  // the window also throws, in which case that last error is what the caller
  // sees (not the generic empty-result message below, which is reserved for
  // the case where every read succeeds but the review never shows up).
  let reviewNowObservablyInProgress = false;
  let lastReadError = null;
  try {
    reviewNowObservablyInProgress = await checkReviewObservablyInProgress(options, runtime, before);
  } catch (error) {
    lastReadError = error;
  }
  // ponytail: GraphQL cross-check queried once here, not re-queried per retry
  // attempt below — GraphQL's reviewRequests/reviews state doesn't flicker
  // the way the REST eventual-consistency race the retry loop exists for
  // does, so one cross-check is enough; add per-retry querying only if that
  // assumption proves wrong in practice. Skipped when the REST read itself
  // threw (a real error, not a benign "not yet observable" gap) so the
  // existing error-propagation branch below stays untouched.
  if (!reviewNowObservablyInProgress && !lastReadError) {
    const currentHeadSha = typeof before.prData?.headRefOid === "string" && before.prData.headRefOid.trim().length > 0
      ? before.prData.headRefOid.trim()
      : null;
    reviewNowObservablyInProgress = await isCopilotReviewObservableViaGraphql(
      { repo: options.repo, pr: options.pr, headSha: currentHeadSha },
      runtime,
    );
  }
  for (let attempt = 0; !reviewNowObservablyInProgress && attempt < VERIFICATION_RETRY_DELAYS_MS.length; attempt += 1) {
    await delayImpl(VERIFICATION_RETRY_DELAYS_MS[attempt]);
    try {
      reviewNowObservablyInProgress = await checkReviewObservablyInProgress(options, runtime, before);
      lastReadError = null;
    } catch (error) {
      lastReadError = error;
      continue;
    }
  }
  if (!reviewNowObservablyInProgress) {
    if (lastReadError) {
      throw lastReadError;
    }
    // Fallback: the requested_reviewers POST already returned exit 0
    // — the request is genuinely real — but neither REST nor the GraphQL
    // cross-check above observed it within the bounded verification window.
    // Treat this as eventually consistent instead of a hard failure; a truly
    // unavailable Copilot reviewer is already classified `unavailable` above
    // via the 422 path and never reaches here.
    return withConfigWarning({
      ...requestResult,
      detail: "Copilot review request POST succeeded but was not yet observable via requested_reviewers/reviews or GraphQL within the verification window; treating as eventually consistent rather than failing.",
    });
  }
  return withConfigWarning({
    ...requestResult,
  });
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
    runChild = defaultRunChild,
    delayImpl = delay,
    repoRoot = process.cwd(),
    setExitCode = (code) => { process.exitCode = code; },
  } = {},
) {
  const options = parseRequestCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await performCopilotReviewRequest(options, {
    env,
    ghCommand,
    runChild,
    delayImpl,
    repoRoot,
  });
  // --silent exit-code contract (see USAGE "Status contract" above): 0 only
  // for status "requested", never derived from `ok`.
  const silentOk = options.silent ? result.status === "requested" : undefined;
  setExitCode(emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: silentOk }));
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
