#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildParseError,
  containsBareCopilotSummon,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  parseReviewThreads,
  resolveDraftGateRoundResetMs,
  summarizeCopilotReviews,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildSnapshotFromPrFacts, interpretLoopState } from "@dev-loops/core/loop/copilot-loop-state";
import { resolveConvergenceCarryForward } from "@dev-loops/core/loop/gate-carry-forward";
import { loadDevLoopConfig, resolveEffectiveCopilotRoundCap, resolveRefinement } from "@dev-loops/core/config";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const BLOCKED_BY_COPILOT_COMMENT_STATUS = "blocked_by_copilot_comment";
const SUPPRESSED_SAME_HEAD_CLEAN_STATUS = "suppressed_same_head_clean";
const ROUND_CAP_REACHED_STATUS = "round_cap_reached";
const NO_CHANGES_SINCE_LAST_REVIEW_STATUS = "no_changes_since_last_review";
const SUPPRESSED_POST_CONVERGENCE_DOCS_ONLY_STATUS = "suppressed_post_convergence_docs_only";
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
  --lightweight             This PR is light-dispatched (#1210): enforce the
                            composed round cap min(localImplementation.lightMode.
                            maxCopilotRounds ?? 1, refinement.maxCopilotRounds)
                            instead of refinement.maxCopilotRounds alone.
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
  suppressed_post_convergence_docs_only  At the round cap, the post-convergence head bump is a provable pure doc/prose
                                delta since the last Copilot-reviewed head; no fresh blocking round is forced (the prior
                                converged review stands). Any code/test/config/CI or unclassifiable delta re-opens the round.
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
async function resolveDraftGateAdjustedRounds(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}, before) {
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
// AC2 convergence carry-forward input: the changed-file PATHS between the
// last-Copilot-reviewed head and the current head, via a single gh compare call.
// FAIL-CLOSED — returns null on ANY uncertainty so the caller re-opens the round
// exactly as before:
//   - compare call throws / non-zero exit / unparseable JSON
//   - the advance is not a strict linear ancestor->descendant (status !== "ahead"),
//     so the destination-path file list cannot be trusted as the exact delta
//   - any rename/copy entry, whose destination-path classification could misread a
//     code file moved to a doc path as pure-doc
// Only a provably linear, rename-free delta yields the destination paths, which the
// path-based resolveConvergenceCarryForward can then classify.
async function fetchDeltaChangedFiles({ repo, base, head }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  let result;
  try {
    result = await runChild(ghCommand, ["api", `repos/${repo}/compare/${base}...${head}`], env);
  } catch {
    return null;
  }
  if (result.code !== 0) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (payload?.status !== "ahead") {
    return null;
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  const changed = [];
  for (const file of files) {
    if (file?.status === "renamed" || file?.status === "copied") {
      return null;
    }
    if (typeof file?.filename === "string" && file.filename.length > 0) {
      changed.push(file.filename);
    }
  }
  return changed;
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
async function requestCopilotReview({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
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
export async function performCopilotReviewRequest(options, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
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
  let refinementConfig = { maxCopilotRounds: 5 };
  let maxRounds = 5; // Built-in default; overridden by config when loadable
  // Lightweight fallback when config is unreadable/invalid: fail toward the
  // SAFE (smaller) lightweight cap instead of silently inheriting the
  // full-PR default of 5 above, which would let a light-dispatched PR run
  // far more review rounds than intended whenever the config can't be read.
  const LIGHTWEIGHT_DEFAULT_CAP = 1;
  let configWarning = null;
  try {
    const { config, errors } = await loadDevLoopConfig();
    if (!errors || errors.length === 0) {
      refinementConfig = resolveRefinement(config);
      // Light-dispatched PRs (#1210) enforce the COMPOSED cap —
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
  // Reconcile the completed-round count with detect-pr-gate-coordination-state (#896):
  // when the raw count has reached the cap, re-derive it with the draft-gate round
  // reset applied. A clean draft_gate re-pass on an earlier head resets the count, so
  // a post-reset PR that detect reports as under-cap must NOT be refused here as
  // cap-reached. Only query checkpoint evidence on this (at/over-cap) path.
  let completedRounds = before.completedCopilotReviewRounds ?? 0;
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
    const currentHeadSha = typeof before.prData?.headRefOid === "string" && before.prData.headRefOid.trim().length > 0
      ? before.prData.headRefOid.trim()
      : null;
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
    // AC2 fail-closed convergence carry-forward: at the round cap, a post-convergence
    // head bump whose delta since the last Copilot-reviewed head is PROVABLY a pure
    // doc/prose bump must NOT force a fresh blocking Copilot round — this is the exact
    // choke point (shared by --force-rerequest-review and the auto-rerequest-eligible
    // path) where new commits bypass the cap. Consult the pure, path-based seam
    // resolveConvergenceCarryForward on that delta. DEFAULT-SAFE: the delta lookup
    // fails closed (null) on any uncertainty, and the seam returns carryForward:false
    // on any code/test/config/CI or unclassifiable file (and on an empty delta), so
    // every non-pure-doc case re-opens the round exactly as before. The
    // "significant post-convergence change re-opens a cycle" exception and the round
    // cap itself are untouched for those deltas.
    const deltaChangedFiles = await fetchDeltaChangedFiles(
      { repo: options.repo, base: lastReviewSha, head: currentHeadSha },
      runtime,
    );
    if (deltaChangedFiles !== null) {
      const convergence = resolveConvergenceCarryForward({ changedFiles: deltaChangedFiles });
      if (convergence.carryForward) {
        return withConfigWarning({
          ok: true,
          status: SUPPRESSED_POST_CONVERGENCE_DOCS_ONLY_STATUS,
          repo: options.repo,
          pr: options.pr,
          reviewer: "Copilot",
          detail: `Post-convergence head bump is a pure doc/prose delta (${convergence.reason}); no fresh Copilot round is forced. The prior converged Copilot review still stands — proceed to the gate.`,
          completedRounds,
          maxRounds,
        });
      }
    }
    // Has new (review-relevant) commits — bypass the round cap and proceed with the request
  }
  const sameHeadCleanConverged = await detectSameHeadCleanConvergence(
    options,
    runtime,
    before,
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
  const after = await fetchCopilotReviewState(options, runtime);
  const reviewCountIncreased = after.copilotReviewIds.length > before.copilotReviewIds.length;
  const reviewNowObservablyInProgress = after.requested || after.hasPendingReviewOnCurrentHead || reviewCountIncreased;
  if (!reviewNowObservablyInProgress) {
    throw new Error("Copilot review request did not appear in requested reviewers or fresh/in-progress Copilot reviews after gh pr edit");
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
  } = {},
) {
  const options = parseRequestCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await performCopilotReviewRequest(options, { env, ghCommand });
  // Honest status under --silent: `ok: true` reports "the helper ran without
  // error", not "a review was placed" — a caller checking only exit-code
  // truthiness must NOT read a non-`requested` status (blocked_by_copilot_comment,
  // round_cap_reached, etc.) as a placed request. --silent therefore answers
  // "was a request just placed" specifically: exit 0 only for `requested`,
  // non-zero for every other status. Non-silent output is unaffected — the full
  // JSON body (with `ok: true`) still prints for every documented status; the
  // caller MUST branch on `.status`, not `.ok`.
  const silentOk = options.silent ? result.status === "requested" : undefined;
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr, ok: silentOk });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
