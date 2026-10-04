/**
 * Shared helpers for `adr-tripwire:allow` PR-body waiver lines
 * (ADR-TRIPWIRE-STANDING-WAIVER). Pure; no I/O.
 *
 * No agent hand-writes a waiver line. edit-pr.mjs and create-pr.mjs refuse a
 * body whose set of marker lines differs from the PR's current set. The one
 * sanctioned writer is waive-adr-tripwire.mjs, which emits the head-pinned
 * standing-authorization line built here.
 */

export const WAIVER_MARKER = "adr-tripwire:allow";
export const STANDING_REASON_PREFIX = "standing-authorization";
export const WAIVER_WRITER_COMMAND = "dev-loops pr waive-adr-tripwire";

const MARKER_LINE_RE = /^\s*adr-tripwire:allow(?:\s|$)/u;
const STANDING_REASON_RE = /^standing-authorization(?:\s|$)/u;
const HEAD_FIELD_RE = /(?:^|\s)head=([0-9a-f]{40})(?=\s|$)/u;

/** Every body line carrying the waiver marker, trimmed, in order. */
export function extractWaiverLines(body) {
  if (typeof body !== "string" || body.length === 0) return [];
  return body.split("\n").map((l) => l.trim()).filter((l) => MARKER_LINE_RE.test(l));
}

const canonicalSet = (lines) => JSON.stringify([...lines].sort());

/**
 * Refusal text when `nextBody` changes the set of marker lines relative to
 * `currentBody` (add, change or remove); null when the sets are equal.
 * For create, pass currentBody "" so any marker line is a change.
 */
export function waiverLineChangeRefusal({ currentBody, nextBody, action }) {
  const before = extractWaiverLines(currentBody);
  const after = extractWaiverLines(nextBody);
  if (canonicalSet(before) === canonicalSet(after)) return null;
  return (
    `ADR-TRIPWIRE-STANDING-WAIVER: refusing to ${action} a PR body that adds, changes or removes an \`${WAIVER_MARKER}\` line. ` +
    `No agent hand-writes a waiver marker. Run \`${WAIVER_WRITER_COMMAND} --repo <owner/name> --pr <n>\` (it writes the line only under a standing authorization on the default branch). ` +
    `An operator who writes a waiver by hand does so in the GitHub UI.`
  );
}

/** The head-pinned standing-authorization waiver line. */
export function buildStandingWaiverLine({ head, issue, grantedBy, expires, paths }) {
  return `${WAIVER_MARKER} ${STANDING_REASON_PREFIX} head=${head} issue=${issue} granted-by=${grantedBy} expires=${expires} paths=${paths.join(",")}`;
}

/**
 * Classify a waiver reason. `{ standing: false }` for a hand-written reason;
 * `{ standing: true, head }` for a reason starting with `standing-authorization`
 * (head is null when the line carries no well-formed `head=<40-hex>`).
 */
export function classifyWaiverReason(reason) {
  if (typeof reason !== "string" || !STANDING_REASON_RE.test(reason)) return { standing: false };
  const m = HEAD_FIELD_RE.exec(reason);
  return { standing: true, head: m ? m[1] : null };
}

/** Body with every standing-authorization waiver line dropped, every other line kept. */
export function withoutStandingWaiverLines(body) {
  return body
    .split("\n")
    .filter((line) => {
      if (!MARKER_LINE_RE.test(line)) return true;
      return !STANDING_REASON_RE.test(line.trim().slice(WAIVER_MARKER.length).trim());
    })
    .join("\n");
}

/** Replace any earlier standing line with `line`, appended after a blank line; other lines stay. */
export function replaceStandingWaiverLine(body, line) {
  const kept = withoutStandingWaiverLines(body).replace(/\s+$/u, "");
  return `${kept}\n\n${line}\n`;
}
