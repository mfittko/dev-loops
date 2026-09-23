// Copilot body-only feedback disposition record.
//
// A body-only Copilot finding (changes recommended, needs closer look, or an
// unrecognized disposition header, with no inline thread) has nothing to reply
// to or resolve, so no GitHub action clears copilotBodyFeedbackUnresolved. The
// sanctioned exit is a trusted PR issue comment naming the exact review and the
// current head (format owned by skills/docs/copilot-loop-state-graph.md):
//   <!-- dev-loops:copilot-body-disposition review=<review id> head=<40-hex> fix=<40-hex> -->
//   <!-- dev-loops:copilot-body-disposition review=<review id> head=<40-hex> operator -->
// `fix` names a commit strictly after the dispositioned review's commit that
// the head contains, so a `fix` record never clears a review of the current
// head. `operator` is a human operator decision with no fixing commit.
//
// FAIL CLOSED: no record, a record for another head, a foreign review id, an
// untrusted author, a fix commit not after the review commit or not in the
// head, an unreadable comment stream, or a marker inside code or a quote all
// leave the finding blocking. Nothing here writes a record.
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import {
  classifyCopilotReviewBodyDisposition,
  COPILOT_DISPOSITION,
  isCopilotLogin,
  stripMarkdownCodeForScan,
} from "@dev-loops/core/github/copilot-helpers";
import { isCommitContainedByHead } from "./_commit-containment.mjs";

const MARKER_RE = /<!--\s*dev-loops:copilot-body-disposition\s+review=(\S+)\s+head=([0-9a-fA-F]{40})\s+(?:fix=([0-9a-fA-F]{40})|operator)\s*-->/;

// Trusted authors: a human with OWNER/MEMBER/COLLABORATOR standing on the repo.
// Any bot login (Copilot included) is rejected regardless of association.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Only bare markdown counts: fenced blocks, inline code spans, and `>` quote
// lines are dropped before matching, so a quoted or code-formatted marker is
// never a record.
export function parseCopilotBodyDispositionMarker(body) {
  if (typeof body !== "string") return null;
  const bare = stripMarkdownCodeForScan(body)
    .split("\n")
    .filter((bodyLine) => !/^\s*>/.test(bodyLine))
    .join("\n");
  const match = MARKER_RE.exec(bare);
  if (!match) return null;
  return {
    reviewId: match[1],
    headSha: match[2].toLowerCase(),
    fixSha: match[3] ? match[3].toLowerCase() : null,
    operator: !match[3],
  };
}

export function isTrustedDispositionAuthor(comment) {
  const login = typeof comment?.user?.login === "string" ? comment.user.login : "";
  if (login.length === 0) return false;
  if (isCopilotLogin(login)) return false;
  if (/\[bot\]$/i.test(login)) return false;
  if (typeof comment?.user?.type === "string" && comment.user.type.toLowerCase() === "bot") return false;
  const association = typeof comment?.author_association === "string" ? comment.author_association.toUpperCase() : "";
  return TRUSTED_ASSOCIATIONS.has(association);
}

// Every trusted, well-formed disposition record on the PR's issue-comment
// stream. Throws on a gh failure; resolveCopilotBodyDisposition turns that
// into "not cleared".
export async function fetchCopilotBodyDispositionMarkers({ repo, pr }, { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {}) {
  const result = await runChild(ghCommand, ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--jq", ".[]"], env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const markers = [];
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    let comment;
    try {
      comment = JSON.parse(line);
    } catch {
      continue;
    }
    const marker = parseCopilotBodyDispositionMarker(comment?.body);
    if (!marker || !isTrustedDispositionAuthor(comment)) continue;
    markers.push({ ...marker, commentId: comment?.id ?? null, author: comment?.user?.login ?? null });
  }
  return markers;
}

// A fix commit disposes a review only when it is strictly after the review's
// commit (the review commit is a proper ancestor of the fix) and the head
// contains it. An unknown review commit refuses.
async function isFixAfterReviewAndInHead({ repo, fixSha, reviewCommitSha, headSha }, runtime) {
  if (typeof reviewCommitSha !== "string" || reviewCommitSha.trim().length === 0) return false;
  const reviewCommit = reviewCommitSha.trim().toLowerCase();
  if (reviewCommit === fixSha) return false;
  const after = await isCommitContainedByHead({ repo, commitSha: reviewCommit, headSha: fixSha }, runtime);
  if (!after.contained) return false;
  return (await isCommitContainedByHead({ repo, commitSha: fixSha, headSha }, runtime)).contained;
}

/**
 * Whether a trusted record clears the body finding of Copilot review
 * `reviewId` for `headSha` (always the PR's current head). `reviewCommitSha`
 * is the commit the review was submitted on; a `fix` record clears only when
 * its commit is strictly after that commit and contained in the head.
 *
 * @returns {Promise<{ cleared: boolean, disposition: object|null, reason: string }>}
 */
export async function resolveCopilotBodyDisposition({ repo, pr, headSha, reviewId, reviewCommitSha }, runtime = {}) {
  const notCleared = (reason) => ({ cleared: false, disposition: null, reason });
  if (typeof headSha !== "string" || headSha.trim().length === 0 || reviewId === null || reviewId === undefined) {
    return notCleared("no head or source review to disposition");
  }
  const normalizedHead = headSha.trim().toLowerCase();
  let markers;
  try {
    markers = await fetchCopilotBodyDispositionMarkers({ repo, pr }, runtime);
  } catch (error) {
    return notCleared(`disposition records unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const marker of markers) {
    if (marker.headSha !== normalizedHead || marker.reviewId !== String(reviewId)) continue;
    if (marker.operator) {
      return { cleared: true, disposition: marker, reason: `operator disposition recorded for review ${marker.reviewId} at head ${normalizedHead}` };
    }
    if (await isFixAfterReviewAndInHead({ repo, fixSha: marker.fixSha, reviewCommitSha, headSha: normalizedHead }, runtime)) {
      return { cleared: true, disposition: marker, reason: `fix commit ${marker.fixSha} disposes review ${marker.reviewId} at head ${normalizedHead}` };
    }
  }
  return notCleared("no trusted disposition record names this review for the current head; the body finding stays blocked (COPILOT-STATE-BODY-DISPOSITION-RECORD)");
}

const BODY_ONLY_BLOCKING_DISPOSITIONS = new Set([
  COPILOT_DISPOSITION.CHANGES_RECOMMENDED,
  COPILOT_DISPOSITION.UNRECOGNIZED,
]);

export function isBodyOnlyBlockingReview(review) {
  return BODY_ONLY_BLOCKING_DISPOSITIONS.has(classifyCopilotReviewBodyDisposition(review?.state, review?.body));
}

// The raw submittedAt string (GraphQL or REST shape), or null. Compared as a
// string, exactly as summarizeCopilotReviews and evaluateCopilotConvergence
// compare it, so all three pick the same latest review.
function reviewSubmittedAt(review) {
  if (typeof review?.submittedAt === "string") return review.submittedAt;
  return typeof review?.submitted_at === "string" ? review.submitted_at : null;
}

/**
 * The most recent SUBMITTED (non-PENDING) Copilot review. A PENDING review on
 * a stale head is never selected. Tolerates GraphQL (commit.oid, submittedAt)
 * and REST (commit_id, submitted_at) shapes. The latest is the greatest raw
 * submittedAt string; a review without one loses to any review with one, and
 * when no review has one, all are tied.
 *
 * FAIL CLOSED on a tie (equal strings, or all missing): a tied
 * changes-recommended or unrecognized review wins over a tied clean one, so
 * array order never drops a body finding. `ambiguousBlockingTie` is true when
 * two or more tied latest reviews are body-blocking: no single review owns
 * the finding, so no disposition record can clear it.
 *
 * @returns {{ review: object|null, ambiguousBlockingTie: boolean }}
 */
export function resolveLatestCopilotReview(prData) {
  const reviews = Array.isArray(prData?.reviews) ? prData.reviews : [];
  const candidates = reviews.filter((r) => r?.state !== "PENDING" && isCopilotLogin(r?.author?.login));
  if (candidates.length === 0) return { review: null, ambiguousBlockingTie: false };
  let latestAt = null;
  for (const review of candidates) {
    const at = reviewSubmittedAt(review);
    if (at !== null && (latestAt === null || at > latestAt)) latestAt = at;
  }
  // Later array position wins among tied reviews of equal blocking weight.
  const tied = candidates.filter((review) => reviewSubmittedAt(review) === latestAt).reverse();
  const blocking = tied.filter(isBodyOnlyBlockingReview);
  return {
    review: blocking[0] ?? tied[0],
    ambiguousBlockingTie: blocking.length > 1,
  };
}

// Whether `reviewId` opened at least one review thread. A thread with no
// review attribution (reviewId null) never counts, so unknown attribution
// fails closed.
export function reviewHasOwnThread(reviewThreads, reviewId) {
  return reviewId !== null && Array.isArray(reviewThreads) && reviewThreads.some((thread) => thread?.reviewId === reviewId);
}

/**
 * The shared body-feedback resolver used by both detectors and the request
 * tool. `reviewSummary` comes from summarizeCopilotReviews; `reviewThreads`
 * is the parsed thread list (parseReviewThreads().threads).
 *
 * Current head: a body finding on a current-head review stays unresolved
 * unless an `operator` record names it (its review commit is the head, so no
 * `fix` commit can be after it).
 *
 * Earlier head: when the latest Copilot review sits on an earlier head and is
 * body-only changes-recommended or unrecognized (no thread of its own), its
 * body feedback stays unresolved (`copilotPriorHeadBodyFeedbackUnresolved`)
 * until a trusted record names it: a `fix` record whose commit is after that
 * review's commit and in the head, or an `operator` record for the current
 * head. The loop interpreter consumes this only at the round cap, where no
 * fresh Copilot review can supersede the earlier one.
 *
 * The comment stream is read only when one of those two findings exists.
 *
 * `dispositionRequired` names the exit when either flag blocks: the review a
 * copilot-body-disposition record must name (`reviewId`, null for an
 * ambiguous tie that no record can clear), its commit, and the reason. It is
 * null when neither flag blocks.
 *
 * @returns {Promise<{ copilotBodyFeedbackUnresolved: boolean, copilotPriorHeadBodyFeedbackUnresolved: boolean, bodyDisposition: object|null, dispositionRequired: { reviewId: string|null, reviewCommitSha: string|null, reason: string }|null }>}
 */
export async function resolveCurrentHeadBodyFeedback({ repo, pr, headSha, reviewSummary, reviewThreads }, runtime = {}) {
  const settled = { copilotBodyFeedbackUnresolved: false, copilotPriorHeadBodyFeedbackUnresolved: false, bodyDisposition: null, dispositionRequired: null };
  if (reviewSummary?.hasBodyFindingOnCurrentHead === true) {
    const record = await resolveCopilotBodyDisposition(
      { repo, pr, headSha, reviewId: reviewSummary.bodyFindingReviewId, reviewCommitSha: headSha },
      runtime,
    );
    return record.cleared
      ? { ...settled, bodyDisposition: record.disposition }
      : {
        ...settled,
        copilotBodyFeedbackUnresolved: true,
        dispositionRequired: {
          reviewId: reviewSummary.bodyFindingReviewId ?? null,
          reviewCommitSha: headSha,
          reason: "the current-head Copilot review carries body feedback with no trusted operator copilot-body-disposition record",
        },
      };
  }
  const { review, ambiguousBlockingTie } = resolveLatestCopilotReview({ reviews: reviewSummary?.effectiveCopilotReviews });
  const reviewCommitSha = review?.commit?.oid ?? review?.commit_id ?? null;
  if (!review || typeof headSha !== "string" || reviewCommitSha === headSha || !isBodyOnlyBlockingReview(review)) {
    return settled;
  }
  if (ambiguousBlockingTie) {
    return {
      ...settled,
      copilotPriorHeadBodyFeedbackUnresolved: true,
      dispositionRequired: {
        reviewId: null,
        reviewCommitSha,
        reason: "two or more tied latest Copilot reviews carry body-only feedback, so no single copilot-body-disposition record can clear it",
      },
    };
  }
  const reviewId = review.id !== null && review.id !== undefined ? String(review.id) : null;
  if (reviewHasOwnThread(reviewThreads, reviewId)) {
    return settled;
  }
  const record = await resolveCopilotBodyDisposition({ repo, pr, headSha, reviewId, reviewCommitSha }, runtime);
  return record.cleared
    ? { ...settled, bodyDisposition: record.disposition }
    : {
      ...settled,
      copilotPriorHeadBodyFeedbackUnresolved: true,
      dispositionRequired: {
        reviewId,
        reviewCommitSha,
        reason: "the latest Copilot review, on an earlier head, carries body-only feedback with no trusted copilot-body-disposition record",
      },
    };
}
