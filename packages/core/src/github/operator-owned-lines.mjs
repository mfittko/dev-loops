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
import { hasOperatorDispositionMarker } from "./copilot-body-disposition-marker.mjs";
import { stripNonAssertionMarkdown } from "./non-assertion-markdown.mjs";

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
    refusal: refusal("a Copilot body-disposition `operator` marker", "Only the orchestrator posts it, through a comment wrapper with `--standing-authorization` that asserts a recorded standing operator authorization."),
  }),
]);

/** Refusal text of the first matching entry the flag does not clear, else null. */
export function findOperatorOwnedLineRefusal(body, { standingAuthorization = false } = {}) {
  if (typeof body !== "string") return null;
  for (const entry of OPERATOR_OWNED_LINES) {
    if (standingAuthorization && entry.standingAuthorization) continue;
    if (entry.matches(body)) return entry.refusal;
  }
  return null;
}
