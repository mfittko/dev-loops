/**
 * ISSUE/PR-ID GUARD for generated comment bodies.
 *
 * Mandate (#1731, operator directive): generated gate/review/verdict comment
 * bodies must NEVER emit raw issue or PR ids. Public comment surfaces are
 * world-readable, and a bare `#<digits>` in a comment body is auto-linked by
 * GitHub to that issue/PR — leaking internal cross-references and violating
 * the no-ids-in-comments rule.
 *
 * This helper fails CLOSED: it refuses (throws) a body that contains a raw
 * `#<digits>` token, unless that id is explicitly allowlisted as a deliberate
 * cross-reference (`allowedRefs`). There is deliberately NO silent stripping —
 * a stripped id could silently drop a needed cross-ref while still posting;
 * refusal forces the caller to make the cross-ref deliberate (or reword).
 *
 * Wire this into every comment/review write helper that posts a GENERATED
 * body (verdict comments, gate findings reviews, inline finding comments,
 * review-thread replies, and the generic comment/edit writers). Applying it at
 * the low-level POST/PATCH write point means current AND future comment flows
 * are guarded automatically — a future writer that routes through these
 * helpers cannot emit an issue/PR id without an explicit allowlist entry.
 *
 * Deliberate cross-reference mechanism: pass the id(s) to allow as
 * `allowedRefs: ["1670"]`. This is the ONLY sanctioned way a generated comment
 * body may reference an issue/PR id. Keep the allowlist small and deliberate.
 */

// Matches a bare GitHub auto-link issue/PR reference: `#<digits>`. Bound to
// 1..9 digits to avoid absurd ids while covering the full GitHub id space.
// Excludes a `#<digits>` preceded by `&`, since that's a numeric character
// reference (e.g. `&#91;`, the entity-encoded form of `[`) rather than an
// issue/PR auto-link.
const ISSUE_PR_ID_RE = /(?<!&)#(\d{1,9})/g;

/**
 * Extract the raw issue/PR id tokens found in a body (as strings, deduped).
 * Returns [] for non-string input (and for a body with no `#<digits>`).
 */
export function extractIssuePrIds(body) {
  if (typeof body !== "string" || body.length === 0) return [];
  const found = new Set();
  for (const m of body.matchAll(ISSUE_PR_ID_RE)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Fail-closed guard: returns `body` unchanged when it contains no raw
 * issue/PR id (or every id it contains is explicitly allowlisted). Throws
 * otherwise, refusing to emit the body.
 *
 * @param {string} body - the generated comment body to guard.
 * @param {object} [opts]
 * @param {string} [opts.ref] - human label for the guarded surface (error context).
 * @param {Iterable<number|string>} [opts.allowedRefs] - explicit allowlist of
 *   deliberate cross-reference ids permitted to appear in the body.
 * @returns {string} the (unchanged, since no stripping) body.
 */
export function guardCommentBodyNoIssuePrIds(body, { ref = "generated comment body", allowedRefs = [] } = {}) {
  if (typeof body !== "string") return body;
  const allow = new Set(Array.from(allowedRefs ?? [], (id) => String(id)));
  const offending = extractIssuePrIds(body).filter((id) => !allow.has(id));
  if (offending.length > 0) {
    throw new Error(
      `comment-id-guard refused to emit ${ref}: contains raw issue/PR id reference(s) ` +
        `#${offending.join(", #")}. Bare #digits in generated comment bodies violate the ` +
        `no-ids-in-comments rule (public leakage). Reword to a generic reference, or pass the ` +
        `id(s) to allowedRefs on the guarded write to make an explicit deliberate cross-reference.`,
    );
  }
  return body;
}
