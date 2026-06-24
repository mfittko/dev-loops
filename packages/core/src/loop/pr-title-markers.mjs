/**
 * Merge-blocking marker detection for PR titles (issue #842).
 *
 * The PR title is the single most visible contract surface of a pull request:
 * it shows up in the PR list, in notifications, in the merge commit, and in the
 * changelog. A "WIP"/"DRAFT"/"DO NOT MERGE" title on an otherwise merge-ready PR
 * directly contradicts the gate's assertion that the work is done. The gate
 * pipeline historically only inspected the PR body, so a stale work-in-progress
 * title could slip through both the mark-ready transition and the final-approval
 * boundary. This module provides the pure detection seam used at both points.
 *
 * It is intentionally pure and side-effect free.
 */

/**
 * Canonical merge-blocking markers and how to detect them.
 *
 * Word-boundary matching is used for the alphabetic markers so that real words
 * are not false-positives (e.g. "swipe"/"wiped" must not match WIP;
 * "drafting"/"redraft" must not match DRAFT). Bracket/paren/colon punctuation
 * (`[WIP]`, `(wip)`, `WIP:`) are non-word characters, so `\b` boundaries still
 * match those variants. The construction emoji has no word boundary, so it is
 * matched literally anywhere in the title.
 */
const MARKER_MATCHERS = [
  { label: "WIP", pattern: /\bWIP\b/i },
  { label: "DRAFT", pattern: /\bDRAFT\b/i },
  // Flexible (any) whitespace between the phrase words, case-insensitive.
  { label: "DO NOT MERGE", pattern: /\bDO\s+NOT\s+MERGE\b/i },
  { label: "🚧", pattern: /🚧/u },
];

/**
 * Finds merge-blocking markers in a PR title.
 *
 * Returns the canonical labels of every matched marker, de-duped and in a
 * stable order (the declaration order of {@link MARKER_MATCHERS}). Returns an
 * empty array when the title is clean, empty, or not a string.
 *
 * @param {unknown} title - The PR title to inspect.
 * @returns {string[]} Canonical labels of matched markers, e.g. ["WIP"] or
 *   ["DO NOT MERGE", "🚧"]. Empty when no markers are present.
 */
export function findBlockingTitleMarkers(title) {
  if (typeof title !== "string" || title.length === 0) {
    return [];
  }

  const matched = [];
  for (const { label, pattern } of MARKER_MATCHERS) {
    if (pattern.test(title) && !matched.includes(label)) {
      matched.push(label);
    }
  }
  return matched;
}
