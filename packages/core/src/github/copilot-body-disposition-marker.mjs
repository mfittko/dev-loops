// The one Copilot body-disposition marker parser. The reader
// (scripts/github/_copilot-body-disposition.mjs) and the operator-owned-line
// registry (operator-owned-lines.mjs) both import it: no second marker regex.
import { stripMarkdownCodeForScan } from "./copilot-helpers.mjs";

const markerBody = (form) => `\\s*dev-loops:copilot-body-disposition\\s+review=(\\S+)\\s+head=([0-9a-fA-F]{40})\\s+${form}\\s*`;
const MARKER_RE = new RegExp(`<!--${markerBody("(?:fix=(?<fix>[0-9a-fA-F]{40})|(?<action>reject|defer)=(?<gate>draft_gate|pre_approval_gate)|(?<operator>operator))")}-->`);

/** Global, case-insensitive pattern for an `operator`-form marker, also in its entity-encoded delimiter spelling. Built from the same grammar as the parser. */
export const operatorMarkerWrapPattern = () => new RegExp(`(?:<|&lt;)!--${markerBody("operator")}--(?:>|&gt;)`, "gi");

// Only bare markdown counts: fenced blocks, inline code spans, and `>` quote
// lines are dropped before matching, so a quoted or code-formatted marker is
// never a record. The review-body marker also drops 4-space and tab indented
// lines (`dropIndented`); the Copilot record keeps them, as before.
export const bareMarkdown = (body, { dropIndented = false } = {}) => stripMarkdownCodeForScan(body)
  .split("\n")
  .filter((bodyLine) => !/^\s*>/.test(bodyLine) && !(dropIndented && /^(?: {4}|\t)/.test(bodyLine)))
  .join("\n");

export function parseCopilotBodyDispositionMarker(body) {
  if (typeof body !== "string") return null;
  const bare = bareMarkdown(body);
  const match = MARKER_RE.exec(bare);
  if (!match) return null;
  const { fix, action, gate } = match.groups;
  return {
    reviewId: match[1],
    headSha: match[2].toLowerCase(),
    fixSha: fix ? fix.toLowerCase() : null,
    operator: match.groups.operator !== undefined,
    // The judge-bound forms (`reject=` / `defer=`) also carry the gate whose ledger they bind to.
    ...(action ? { judgeBinding: { action, gate } } : {}),
  };
}

/** True when the bare markdown of `body` holds any `operator`-form marker (every match, not the first). */
export function hasOperatorDispositionMarker(body) {
  if (typeof body !== "string") return false;
  return [...bareMarkdown(body).matchAll(new RegExp(MARKER_RE.source, "g"))].some((match) => match.groups.operator !== undefined);
}
