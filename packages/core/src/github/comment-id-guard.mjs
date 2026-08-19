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
 * `allowedRefs: ["1670"]`. Aside from a genuine HTML numeric character
 * reference (`&#<digits>;`, e.g. `&#91;` for `[`) — each such OCCURRENCE is
 * skipped; the same digit run appearing elsewhere as a bare token still
 * refuses — this is the ONLY sanctioned way a generated comment body may
 * carry a `#<digits>` token. Extraction is decode-aware on BOTH sides of the
 * token: the body is also scanned after a single left-to-right decode of the
 * entity forms GitHub's renderer resolves (numeric character references,
 * zero-padding and hex included at cmark-gfm's 8-digit bound, plus the named
 * hash entity),
 * so a hash or any digit of the id smuggled as an entity — `&#35;123`,
 * `&num;123`, `#&#49;23`, any mix — still refuses. The decode is single-pass
 * like the renderer's: a double-encoded form (`&amp;#35;123`) renders as
 * inert literal text and the decode pass never manufactures a refusal of its
 * INNER id — though the raw scan still refuses the outer digit run of the
 * numeric form as a pre-existing fail-closed near-miss (the outer entity's
 * semicolon sits before the hash, so the well-formed-entity exclusion does
 * not apply). Case-variants of the named hash entity are decoded too even
 * where GitHub would not (`&NUM;`): deliberate over-refusal, keeping the
 * guard fail-closed. Keep the allowlist small and deliberate.
 */

// Matches a bare GitHub auto-link issue/PR reference: `#<digits>`. Bound to
// 1..9 digits to avoid absurd ids while covering the full GitHub id space.
// A match is excluded only when it forms a well-formed HTML numeric character
// reference — preceded by `&` AND immediately followed by `;` (e.g. `&#91;`,
// the entity-encoded form of `[`). Any other shape (a bare `#123`, an
// `&`-preceded run with no terminating `;`, or a `;`-followed run with no
// preceding `&`) is not a well-formed entity and still refuses as a genuine
// auto-link candidate.
const ISSUE_PR_ID_RE = /#(\d{1,9})/g;

function isNumericCharacterReference(body, match) {
  return body[match.index - 1] === "&" && body[match.index + match[0].length] === ";";
}

// Entity forms the renderer resolves that can participate in assembling a
// rendered `#<digits>` auto-link: numeric character references (any code
// point — the hash AND the digits themselves are smuggleable) plus the named
// hash entity. The digit bounds match cmark-gfm's numeric-entity parser
// (up to 8 digits, decimal or hex) so nothing GitHub decodes escapes the
// pass. Single non-rescanning replace = one decode, like the renderer, so a
// double-encoded form's output is never re-read as a fresh entity.
const DECODABLE_ENTITY_RE = /&(?:#(?:\d{1,8}|x[0-9a-f]{1,8})|num);/gi;

function decodeRenderedText(body) {
  return body.replace(DECODABLE_ENTITY_RE, (entity) => {
    const inner = entity.slice(1, -1).toLowerCase();
    if (inner === "num") return "#";
    const code = inner[1] === "x" ? Number.parseInt(inner.slice(2), 16) : Number.parseInt(inner.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return entity;
    }
  });
}

function collectBareIds(text, found) {
  for (const m of text.matchAll(ISSUE_PR_ID_RE)) {
    if (isNumericCharacterReference(text, m)) continue;
    found.add(m[1]);
  }
}

/**
 * Extract the raw issue/PR id tokens found in a body (as strings, deduped).
 * Scans the body as written AND after a single renderer-like entity decode,
 * so an id assembled from entity-encoded pieces is still found. Returns []
 * for non-string input (and for a body with no `#<digits>`).
 */
export function extractIssuePrIds(body) {
  if (typeof body !== "string" || body.length === 0) return [];
  const found = new Set();
  collectBareIds(body, found);
  const decoded = decodeRenderedText(body);
  if (decoded !== body) collectBareIds(decoded, found);
  return [...found];
}

// A caller-supplied allowlist is normally already an array (or other
// iterable) of ids. Guard the one mis-shaped input that would otherwise
// silently produce the wrong set: a plain CSV string. `Array.from` over a
// string character-splits it ("1670" -> ["1","6","7","0"]), which would
// spuriously allowlist single-digit refs while still refusing the id the
// caller meant to allow. Mirrors parseAllowedRefsCsv's comma-split (trim,
// drop empties) — deliberately without its numeric validation, since this is
// a permissive low-level guard, not the CLI arg parser.
function normalizeAllowedRefs(allowedRefs) {
  if (allowedRefs == null) return [];
  if (typeof allowedRefs === "string") {
    return allowedRefs.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return Array.from(allowedRefs, (id) => String(id));
}

/**
 * Fail-closed guard: returns `body` unchanged when it contains no raw
 * issue/PR id (or every id it contains is explicitly allowlisted). Throws
 * otherwise, refusing to emit the body.
 *
 * @param {string} body - the generated comment body to guard.
 * @param {object} [opts]
 * @param {string} [opts.ref] - human label for the guarded surface (error context).
 * @param {Iterable<number|string>|string} [opts.allowedRefs] - explicit
 *   allowlist of deliberate cross-reference ids permitted to appear in the
 *   body. A plain string is treated as a comma-separated list (like a CLI
 *   `--allowed-refs` value), never character-split.
 * @returns {string} the (unchanged, since no stripping) body.
 */
export function guardCommentBodyNoIssuePrIds(body, { ref = "generated comment body", allowedRefs = [] } = {}) {
  if (typeof body !== "string") return body;
  const allow = new Set(normalizeAllowedRefs(allowedRefs));
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
