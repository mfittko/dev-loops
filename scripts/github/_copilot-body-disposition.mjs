// Copilot body-only feedback disposition record.
//
// A body-only Copilot finding (changes recommended, needs closer look, or an
// unrecognized disposition header, with no inline thread) has nothing to reply
// to or resolve, so no GitHub action clears copilotBodyFeedbackUnresolved. The
// sanctioned exit is a trusted PR issue comment naming the exact review and the
// current head (format owned by skills/docs/copilot-loop-state-graph.md):
//   <!-- dev-loops:copilot-body-disposition review=<review id> head=<40-hex> fix=<40-hex> -->
//   <!-- dev-loops:copilot-body-disposition review=<review id> head=<40-hex> operator -->
// `fix` names a commit that must be the head or one of its ancestors;
// `operator` is an explicit human disposition with no fixing commit.
//
// FAIL CLOSED: no record, a record for another head, a foreign review id, an
// untrusted author, an unreachable fix commit, or an unreadable comment stream
// all leave the finding blocking. Nothing here writes a record.
import { runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { isCopilotLogin } from "@dev-loops/core/github/copilot-helpers";
import { isCommitContainedByHead } from "./_commit-containment.mjs";

const MARKER_RE = /<!--\s*dev-loops:copilot-body-disposition\s+review=(\S+)\s+head=([0-9a-fA-F]{40})\s+(?:fix=([0-9a-fA-F]{40})|operator)\s*-->/;

// Trusted authors: a human with OWNER/MEMBER/COLLABORATOR standing on the repo.
// Any bot login (Copilot included) is rejected regardless of association.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function parseCopilotBodyDispositionMarker(body) {
  if (typeof body !== "string") return null;
  const match = MARKER_RE.exec(body);
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

/**
 * Whether a trusted record clears the body finding of Copilot review
 * `reviewId` for `headSha` (always the PR's current head).
 *
 * @returns {Promise<{ cleared: boolean, disposition: object|null, reason: string }>}
 */
export async function resolveCopilotBodyDisposition({ repo, pr, headSha, reviewId }, runtime = {}) {
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
    const containment = await isCommitContainedByHead({ repo, commitSha: marker.fixSha, headSha: normalizedHead }, runtime);
    if (containment.contained) {
      return { cleared: true, disposition: marker, reason: `fix commit ${marker.fixSha} disposes review ${marker.reviewId} at head ${normalizedHead}` };
    }
  }
  return notCleared("no trusted disposition record names this review for the current head");
}

/**
 * The shared current-head body-feedback resolver used by both detectors.
 * `reviewSummary` comes from summarizeCopilotReviews. The comment stream is
 * read only when a current-head body finding exists.
 *
 * @returns {Promise<{ copilotBodyFeedbackUnresolved: boolean, bodyDisposition: object|null }>}
 */
export async function resolveCurrentHeadBodyFeedback({ repo, pr, headSha, reviewSummary }, runtime = {}) {
  if (reviewSummary?.hasBodyFindingOnCurrentHead !== true) {
    return { copilotBodyFeedbackUnresolved: false, bodyDisposition: null };
  }
  const record = await resolveCopilotBodyDisposition({ repo, pr, headSha, reviewId: reviewSummary.bodyFindingReviewId }, runtime);
  return record.cleared
    ? { copilotBodyFeedbackUnresolved: false, bodyDisposition: record.disposition }
    : { copilotBodyFeedbackUnresolved: true, bodyDisposition: null };
}
