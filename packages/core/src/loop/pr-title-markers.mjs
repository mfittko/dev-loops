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
 * Builds a status-marker tester for a bare word like "WIP" or "DRAFT".
 *
 * A status marker asserts, on its own, that the PR is unfinished: bracketed
 * (`[WIP]`), parenthesized (`(draft)`), colon-suffixed (`WIP:`), a trailing
 * tag set off by a real dash character (`Fix login flow — WIP`, an em/en
 * dash — never a plain hyphen, see below), or the entire title with nothing
 * else attached (a bare standalone `DRAFT`). A plain `\bWORD\b` match also
 * hits the same word inside a compound noun phrase that names a component
 * instead — `draft-gate`, `draft_gate`, `draft gate`, `wip-branch` — because
 * a hyphen, underscore, or space is itself a word boundary. None of those
 * forms satisfy any construction below, so a component name is left
 * unflagged while a real status claim still is. "swipe"/"wiped"/"drafting"
 * already fail every construction because there is no boundary between the
 * marker word and the letters that follow it; a hyphen-prefixed compound
 * like "re-draft" DOES create such a boundary (`\b` sees the hyphen), so the
 * colon construction explicitly excludes a marker immediately preceded by a
 * hyphen — "re-draft: cleanup" is one compound word split by a hyphen, not a
 * status tag.
 *
 * The bracket/paren constructions require the opening delimiter to sit at
 * the start of the title or after whitespace — never directly after a
 * letter or `/` — so a conventional-commit scope (`fix(draft): support x`)
 * or a path segment (`app/[draft]/page.tsx`) is read as a component name,
 * not a status claim, the same exemption class as the hyphen/underscore/
 * space compound nouns above.
 *
 * The trailing-dash construction deliberately requires an em dash (—) or en
 * dash (–), never a plain ASCII hyphen: a spaced hyphen (`WIP - add
 * feature`) is a common, low-signal general-purpose separator that reads as
 * ordinary title punctuation, while a typographic dash set specifically
 * around the marker word is a much stronger, unambiguous status-tag signal.
 */
function statusMarkerTester(word) {
  const bracket = new RegExp(`(?:^|\\s)\\[\\s*${word}\\s*\\]`, "i");
  const paren = new RegExp(`(?:^|\\s)\\(\\s*${word}\\s*\\)`, "i");
  const colon = new RegExp(`(?<!-)\\b${word}\\s*:`, "i");
  const standalone = new RegExp(`^\\s*${word}\\s*$`, "i");
  const dashTrailing = new RegExp(`[–—]\\s*${word}\\b`, "i");
  return (title) => bracket.test(title) || paren.test(title) || colon.test(title)
    || standalone.test(title) || dashTrailing.test(title);
}

/**
 * Canonical merge-blocking markers and how to detect them.
 *
 * "DO NOT MERGE" is a three-word phrase with no plausible compound-noun
 * reading, so it keeps simple word-boundary matching. The construction emoji
 * has no word boundary at all, so it is matched literally anywhere in the
 * title.
 */
const MARKER_MATCHERS = [
  { label: "WIP", test: statusMarkerTester("WIP") },
  { label: "DRAFT", test: statusMarkerTester("DRAFT") },
  // Flexible (any) whitespace between the phrase words, case-insensitive.
  { label: "DO NOT MERGE", test: (title) => /\bDO\s+NOT\s+MERGE\b/i.test(title) },
  { label: "🚧", test: (title) => /🚧/u.test(title) },
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
  for (const { label, test } of MARKER_MATCHERS) {
    if (test(title) && !matched.includes(label)) {
      matched.push(label);
    }
  }
  return matched;
}
