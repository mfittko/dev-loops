// ADR 0247: one visible PR note per head when comments from non-maintainers were skipped (ADR 0238, AC4).
import { ghJson } from "@dev-loops/core/github/gh";
import { UNTRUSTED_COMMENT_REMEDY } from "@dev-loops/core/github/comment-trust";
import { findMarkedComment, sanitizeCodeSpan } from "./post-gate-findings.mjs";

export function untrustedSkipNoteMarker(headSha) {
  return `<!-- dev-loops:untrusted-comments-skipped head=${headSha} -->`;
}

/** Logins and counts only; never comment text. `skipped` is the `skipped` array of fetchAllReviewThreadsWithSkips. */
export function renderUntrustedSkipNote(headSha, skipped) {
  const logins = [...new Set(skipped.flatMap((entry) => entry.authors ?? []))].map((login) => `\`${sanitizeCodeSpan(login)}\``);
  return [
    untrustedSkipNoteMarker(headSha),
    `Skipped ${skipped.length} review thread(s) from non-maintainers at ${String(headSha).slice(0, 7)} (authors: ${logins.join(", ")}). Their text is not read by any agent.`,
    `Remedy: ${UNTRUSTED_COMMENT_REMEDY}.`,
  ].join("\n");
}

/** Posts the note once per head. Idempotency reads only the viewer's own comments, so a forged marker cannot suppress it. */
export async function postUntrustedSkipNote({ repo, pr, headSha, skipped, issueComments, login }, { env, ghCommand, runChild }) {
  if (skipped.length === 0 || findMarkedComment(issueComments, untrustedSkipNoteMarker(headSha), { author: login })) return false;
  await ghJson(["api", `repos/${repo}/issues/${pr}/comments`, "-f", `body=${renderUntrustedSkipNote(headSha, skipped)}`], { env, ghCommand, runChild });
  return true;
}
