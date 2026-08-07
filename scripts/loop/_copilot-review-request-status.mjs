// Shared request-settled reconciliation for Copilot review request status (#1588).
//
// Two detectors previously derived `copilotReviewRequestStatus` from the same
// GitHub facts and disagreed: `detect-copilot-loop-state.mjs` reconciled a
// lingering `requested_reviewers` entry against the latest same-head submitted
// review (a request older than the latest review is stale → status `none`),
// while `detect-pr-gate-coordination-state.mjs` mapped `requested → "requested"`
// unconditionally. The unreconciled status caused the gate-coordination
// evaluator's `applyUnsettledCopilotReviewEntryGuard` (#1190) to discard a
// `RUN_PRE_APPROVAL_GATE` grant and dead-end the loop into `stop` even though
// all pre-approval preconditions were met (clean review + 0 threads + green CI).
//
// This module is the single source of truth for that reconciliation. Every
// `copilotReviewRequestStatus` derivation routes through `resolveCopilotReviewRequestStatus`:
//   - `detect-copilot-loop-state.mjs`
//   - `detect-pr-gate-coordination-state.mjs`
//   - `request-copilot-review.mjs` (re-derivation in sameHeadCleanConvergence /
//     roundCapAutoRerequestEligibility)

import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { isCopilotLogin, parseJsonText } from "../_core-helpers.mjs";

// Whether Copilot is currently listed in the PR's `requested_reviewers`.
export async function fetchCopilotRequested({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout, { label: "gh requested reviewers" });
  const users = Array.isArray(payload?.users) ? payload.users : [];
  return users.some((user) => isCopilotLogin(user?.login));
}

// Latest `review_requested` timeline event timestamp for Copilot, or null when
// the timeline is unavailable / no Copilot request event exists. Used by the
// reconciliation to decide whether a lingering `requested_reviewers` entry is
// stale (predates the latest same-head submitted review) or genuinely active.
export async function fetchLatestCopilotReviewRequestAt({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
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
      // skip unparseable timeline lines
    }
  }
  return latestAt;
}

// Resolve the reconciled Copilot review request status.
//
// Reconciliation rule (#1588): a submitted clean review on the current head
// satisfies an outstanding formal request when the request is not newer than
// the latest submitted review timestamp. A request newer than the latest
// review is genuinely outstanding (re-requested after convergence). An
// unknown request timestamp fails closed to "requested" (never silently
// settle an unverifiable request).
//
// @param {object} params
// @param {string} params.repo - "owner/name"
// @param {number} params.pr
// @param {object} params.reviewSummary - from summarizeCopilotReviews()
// @param {string} [params.reviewRequestStatusOverride] - explicit override
// @param {boolean} [params.copilotRequested] - pre-fetched requested_reviewers result (avoids duplicate API call)
// @param {object} runtime - { env, ghCommand, runChild }
// @returns {Promise<"none"|"requested"|"already-requested"|"unavailable"|"failed">}
export async function resolveCopilotReviewRequestStatus(
  { repo, pr, reviewSummary, reviewRequestStatusOverride, copilotRequested },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {},
) {
  if (reviewRequestStatusOverride !== undefined) {
    return reviewRequestStatusOverride;
  }
  // A PENDING review on the current head is genuinely unsettled (Copilot is
  // actively reviewing); do not reconcile it away.
  if (reviewSummary?.hasPendingReviewOnCurrentHead) {
    return "requested";
  }
  if (copilotRequested === undefined) {
    copilotRequested = await fetchCopilotRequested({ repo, pr }, { env, ghCommand, runChild });
  }
  if (!copilotRequested) {
    return "none";
  }
  // Copilot is formally requested but has not submitted a review on the current
  // head — the request is genuinely outstanding.
  if (!reviewSummary?.hasSubmittedReviewOnCurrentHead) {
    return "requested";
  }
  // Convergence reconciliation (#1588): a submitted clean review on the
  // current head satisfies an outstanding formal request when the request is
  // not newer than the latest submitted review. A request newer than the
  // latest review is genuinely outstanding (re-requested after convergence).
  // An unknown request OR review timestamp fails closed to "requested".
  const latestRequestAt = await fetchLatestCopilotReviewRequestAt({ repo, pr }, { env, ghCommand, runChild });
  const latestReviewAt = reviewSummary?.latestSubmittedReviewOnCurrentHeadAt ?? null;
  if (latestRequestAt === null || latestReviewAt === null) {
    return "requested";
  }
  if (latestRequestAt > latestReviewAt) {
    return "requested";
  }
  return "none";
}
