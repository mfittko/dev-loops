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
 * like "re-draft" DOES create such a boundary (`\b` sees the hyphen).
 *
 * The bracket/paren/colon constructions all require the opening delimiter
 * (`[`, `(`, or the marker word itself for colon) to sit at the start of the
 * title or after whitespace — never directly after a letter, `/`, or `-` —
 * so a conventional-commit scope (`fix(draft): support x`), a path segment
 * (`app/[draft]/page.tsx`), a scoped label (`feat/draft: x`, `docs/wip:
 * notes`), and a hyphen-prefixed compound (`re-draft: cleanup`) are all read
 * as a component name, not a status claim — the same anchoring rule as the
 * hyphen/underscore/space compound-noun exemption above. This does introduce
 * one accepted false-negative class: a marker preceded by punctuation other
 * than whitespace with no space of its own, e.g. `Fix bug,(draft)` or `Fix
 * login(wip)`. Widening the anchor to "start, whitespace, or punctuation"
 * would also re-admit the very forms (`/`, `-`) the anchor exists to
 * exclude, so the narrower, whitespace-only anchor is kept and this
 * false-negative class is accepted as its cost.
 *
 * The colon construction additionally requires the colon itself to CLOSE the
 * tag — followed by whitespace or the end of the title, never directly by
 * another character — so a scheme/tag/ref that merely starts with the
 * marker word (`draft://`, `draft:latest`, `wip:branch`) is read as an
 * unrelated identifier, not a status claim.
 *
 * The trailing-dash construction deliberately requires an em dash (—) or en
 * dash (–), never a plain ASCII hyphen: a spaced hyphen (`WIP - add
 * feature`) is a common, low-signal general-purpose separator that reads as
 * ordinary title punctuation, while a typographic dash set specifically
 * around the marker word is a much stronger, unambiguous status-tag signal.
 * It also requires the tag to CLOSE — the marker word must be followed by
 * the end of the title or another dash, never by other words — so a
 * dash-introduced clause that merely CONTAINS the marker word as part of a
 * longer phrase or compound (`Rework the pipeline — draft-gate override`,
 * `Refactor — draft gate coordination`, `Retry — wip branch pipeline`) is
 * read as ordinary prose, not a standalone status tag.
 */
function statusMarkerTester(word) {
  const bracket = new RegExp(`(?:^|\\s)\\[\\s*${word}\\s*\\]`, "i");
  const paren = new RegExp(`(?:^|\\s)\\(\\s*${word}\\s*\\)`, "i");
  const colon = new RegExp(`(?:^|\\s)${word}\\s*:(?:\\s|$)`, "i");
  const standalone = new RegExp(`^\\s*${word}\\s*$`, "i");
  const dashTrailing = new RegExp(`[–—]\\s*${word}\\s*(?:$|[–—])`, "i");
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
