/**
 * Registry of operator-owned comment lines (OPERATOR-OWNED-LINE). The operator
 * and the agents share one GitHub credential, so every reader trusts a line it
 * finds as an operator line. The write side is the only place the boundary
 * holds: every sanctioned comment writer refuses these lines through
 * guardCommentBodyNoIssuePrIds. Adding a line is one new entry.
 *
 * Each `matches` refuses at least every text its reader accepts.
 * `standingAuthorization` says whether `--standing-authorization` clears the entry.
 * Pure; no I/O.
 */
import { hasOperatorDispositionMarker, operatorMarkerWrapPattern } from "./copilot-body-disposition-marker.mjs";
import { stripNonAssertionMarkdown } from "./non-assertion-markdown.mjs";
import { detectGrillProvenance } from "../loop/refinement-grill-state.mjs";

const APPROVE_MERGE_LINE_RE = /^[ \t>*-]*approve\s+merge(?:\s|$)/imu;
// No `u` flag: the flags match the reader's, so U+017F and U+212A stay non-word for `\b`.
const APPROVE_RELEASE_RE = /\bapprove\s+release\s+v?\d/i;
const WAIVER_LINE_RE = /^\s*adr-tripwire:allow(?:\s|$)/mu;

const refusal = (label, tail) => `OPERATOR-OWNED-LINE: refusing a comment with ${label}. ${tail} The human posts the line.`;

export const OPERATOR_OWNED_LINES = Object.freeze([
  Object.freeze({
    id: "approve-merge",
    label: "a line that opens with `approve merge`",
    matches: (body) => APPROVE_MERGE_LINE_RE.test(body),
    standingAuthorization: false,
    refusal: refusal("a line that opens with `approve merge`", "That line is the operator's per-merge approval. No agent writes it and no flag overrides this."),
  }),
  Object.freeze({
    id: "approve-release",
    label: "`approve release v<version>`",
    matches: (body) => APPROVE_RELEASE_RE.test(stripNonAssertionMarkdown(body)),
    standingAuthorization: false,
    refusal: refusal("`approve release v<version>`", "That phrase is the operator's stable-release approval. No agent writes it and no flag overrides this."),
  }),
  Object.freeze({
    id: "adr-tripwire-allow",
    label: "an `adr-tripwire:allow` line",
    matches: (body) => WAIVER_LINE_RE.test(body),
    standingAuthorization: false,
    refusal: refusal("an `adr-tripwire:allow` line", "That line is the ADR tripwire waiver. Only `dev-loops pr waive-adr-tripwire` writes it, in the PR body. No flag overrides this."),
  }),
  Object.freeze({
    id: "copilot-body-disposition-operator",
    label: "a Copilot body-disposition `operator` marker",
    matches: hasOperatorDispositionMarker,
    standingAuthorization: true,
    refusal: refusal("a Copilot body-disposition `operator` marker", "Subagents never post it. The orchestrator posts it only through a comment wrapper with `--standing-authorization` that asserts a recorded standing operator authorization."),
  }),
  Object.freeze({
    id: "grill-provenance-bypass",
    label: "a grill provenance `bypass: operator-authorized by <handle>` line",
    matches: (body) => detectGrillProvenance([body]).bypass,
    standingAuthorization: false,
    refusal: refusal("a grill provenance `bypass: operator-authorized by <handle>` line", "That line records the operator's authorization to skip the grill. No agent writes it and no flag overrides this."),
  }),
]);

/** Refusal text of the first matching entry the flag does not clear, else null. */
export function findOperatorOwnedLineRefusal(body, { standingAuthorization = false } = {}) {
  if (typeof body !== "string") return null;
  for (const entry of OPERATOR_OWNED_LINES) {
    if (standingAuthorization === true && entry.standingAuthorization) continue;
    if (entry.matches(body)) return entry.refusal;
  }
  return null;
}

// Gate surfaces (verdict review, finding comments, findings comment, deferred
// summary, close/reject replies) render reviewer, judge and Copilot free text.
// Per the operator decision of 2026-11-08 (ADR 0258) those writers wrap every
// bare operator-owned phrase in a code span instead of refusing the round. The
// readers strip code spans, so a wrapped phrase asserts nothing, and a wrapped
// line-start phrase no longer opens its line. The guard stays strict and every
// non-gate writer keeps refusing. One pattern per registry entry; the marker
// pattern also accepts the entity-encoded delimiters the renderers emit.
const WRAP_RES = Object.freeze([
  /approve\s+merge/gi,
  /approve\s+release/gi,
  /adr-tripwire:allow/gi,
  operatorMarkerWrapPattern(),
  // Last: the release reader strips a code span between `approve` and `release`, so a bare
  // `release [v]<digit>` run must not survive for it to read as the approval's tail.
  // Horizontal whitespace only, so ordinary text such as `release` then a numbered list line keeps its newline.
  /(?<!`)\brelease[ \t]+v?\d[\w-]*(?:\.\w[\w-]*)*/gi,
]);

// The reader accepts a newline between `release` and the version when `approve` precedes it, so the tail
// of an approval split by a code span (`approve `x` release\nv1.2.3`) wraps across that newline.
const APPROVAL_TAIL_RE = /(?<=^\s*)release\s+v?\d[\w-]*(?:\.\w[\w-]*)*/i;

const CODE_SPAN_RE = /(`[^`\n]*`)/;

/**
 * `text` with every operator-owned phrase wrapped in a code span (whitespace inside it collapsed to
 * one line). Text inside a balanced code span the author wrote stays unchanged.
 */
export function wrapOperatorOwnedPhrases(text) {
  // The capture group puts each author span at an odd index; only the even parts are bare text.
  const parts = String(text).split(CODE_SPAN_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    // A bare part holds only unpaired backticks, which the reader blanks too. Blank them here so a
    // phrase right after one still wraps and the wrap never nests a span in it.
    let out = part.replace(/`/g, " ");
    const wrap = (match) => `\`${match.replace(/\s+/g, " ")}\``;
    // Only author spans and whitespace may sit between `approve` and the tail.
    if (i >= 2 && /\bapprove(?:\s+|`[^`\n]*`)+$/i.test(parts.slice(0, i).join(""))) out = out.replace(APPROVAL_TAIL_RE, wrap);
    for (const re of WRAP_RES) out = out.replace(re, wrap);
    return out;
  }).join("");
}
