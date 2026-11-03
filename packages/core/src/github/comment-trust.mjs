// ADR 0238: the one trust predicate for comment, review and thread text that can
// reach an agent. Owner rule: GATE-REVIEW-COMMENT-TRUST in
// skills/docs/gate-review-sub-loop-contract.md.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// The sanctioned Copilot pull-request reviewer, matched exactly (GraphQL login, with or without
// the [bot] suffix, and the bare `Copilot` login the REST API emits for the same Bot).
const SANCTIONED_COPILOT_REVIEWER = /^(?:copilot-pull-request-reviewer(?:\[bot\])?|copilot)$/i;

/** Exact match on the sanctioned Copilot reviewer login; `copilot-helper[bot]` and other lookalikes are false. */
export function isSanctionedCopilotReviewerLogin(login) {
  return typeof login === "string" && SANCTIONED_COPILOT_REVIEWER.test(login);
}

/**
 * @param {{ login?: unknown, type?: unknown, association?: unknown }} author
 * @param {{ allowCopilot?: boolean }} [options] allowCopilot admits the sanctioned Copilot reviewer (a Bot whose login is exactly copilot-pull-request-reviewer, with an optional [bot] suffix, or Copilot).
 */
export function isTrustedCommentAuthor({ login, type, association } = {}, { allowCopilot = false } = {}) {
  const name = typeof login === "string" ? login : "";
  if (name.length === 0) return false;
  const isBot = (typeof type === "string" && type.toLowerCase() === "bot") || /\[bot\]$/i.test(name);
  if (allowCopilot && SANCTIONED_COPILOT_REVIEWER.test(name) && isBot) return true;
  // Exact sanctioned login only: a human login such as `copilot-fan` is judged by association like any other.
  if (SANCTIONED_COPILOT_REVIEWER.test(name) || isBot) return false;
  return TRUSTED_ASSOCIATIONS.has(typeof association === "string" ? association.toUpperCase() : "");
}

/** GraphQL comment node: `author { login __typename }` plus `authorAssociation`. A missing association is untrusted. The viewer's own comments (`viewerDidAuthor`, set by GitHub, never by the commenter) are trusted so a gate posting under a bot identity keeps its own threads. */
export function isTrustedGraphqlComment(comment, options) {
  return comment?.viewerDidAuthor === true || isTrustedCommentAuthor({ login: comment?.author?.login, type: comment?.author?.__typename ?? comment?.author?.type, association: comment?.authorAssociation }, options);
}

/** REST comment or review: `user.login`, `user.type`, `author_association`. */
export function isTrustedRestComment(comment, options) {
  return isTrustedCommentAuthor({ login: comment?.user?.login, type: comment?.user?.type, association: comment?.author_association }, options);
}

export const UNTRUSTED_COMMENT_REMEDY = "a maintainer (OWNER, MEMBER or COLLABORATOR) replies to or resolves the thread, or restates the finding";
