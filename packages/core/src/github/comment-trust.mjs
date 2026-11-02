import { isCopilotLogin } from "./copilot-helpers.mjs";

// ADR 0238: the one trust predicate for comment, review and thread text that can
// reach an agent. Owner rule: GATE-REVIEW-COMMENT-TRUST in
// skills/docs/gate-review-sub-loop-contract.md.
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * @param {{ login?: unknown, type?: unknown, association?: unknown }} author
 * @param {{ allowCopilot?: boolean }} [options] allowCopilot admits the sanctioned Copilot reviewer (a Bot whose login matches isCopilotLogin).
 */
export function isTrustedCommentAuthor({ login, type, association } = {}, { allowCopilot = false } = {}) {
  const name = typeof login === "string" ? login : "";
  if (name.length === 0) return false;
  const isBot = (typeof type === "string" && type.toLowerCase() === "bot") || /\[bot\]$/i.test(name);
  if (allowCopilot && isCopilotLogin(name) && isBot) return true;
  if (isCopilotLogin(name) || isBot) return false;
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
