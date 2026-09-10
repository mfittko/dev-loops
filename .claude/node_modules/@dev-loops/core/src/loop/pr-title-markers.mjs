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
 * (`[WIP]`), parenthesized (`(draft)`), colon-suffixed (`WIP:`), or the
 * entire title with nothing else attached (a bare standalone `DRAFT`). A
 * plain `\bWORD\b` match also hits the same word inside a compound noun
 * phrase that names a component instead — `draft-gate`, `draft gate`,
 * `wip-branch` — because a hyphen or a space is itself a word boundary. An
 * underscore is a word character, so `draft_gate` never matched `\bDRAFT\b`
 * to begin with; it is listed among the exempt forms for consistency, not
 * because it was ever flagged. None of those forms satisfy any construction
 * below, so a component name is left unflagged while a real status claim
 * still is. "swipe"/"wiped"/"drafting" already fail every construction
 * because there is no boundary between the marker word and the letters that
 * follow it; a hyphen-prefixed compound like "re-draft" DOES create such a
 * boundary (`\b` sees the hyphen).
 *
 * A trailing tag set off by a dash (`Fix login flow — WIP`) is deliberately
 * NOT its own construction, even though it reads as a real status claim.
 * Any dash-based construction narrow enough to close a title's tag also
 * reopens the compound-noun false positive whenever the joiner is a
 * different dash character (`Handle en dash–draft–gate naming`), and any fix
 * for that narrows the construction until it drops real status claims that
 * were previously caught (`Fix login flow — WIP.`, `— WIP (rebasing)`). The
 * bracket/paren/colon/standalone set stays free of both failure modes, so a
 * dash-set-off marker is left unflagged; `WIP:`/`DRAFT:` remains one
 * keystroke away and stays flagged, the same trade already accepted for
 * `WIP foo bar`.
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
 */
function statusMarkerTester(word) {
  const bracket = new RegExp(`(?:^|\\s)\\[\\s*${word}\\s*\\]`, "i");
  const paren = new RegExp(`(?:^|\\s)\\(\\s*${word}\\s*\\)`, "i");
  const colon = new RegExp(`(?:^|\\s)${word}\\s*:(?:\\s|$)`, "i");
  const standalone = new RegExp(`^\\s*${word}\\s*$`, "i");
  return (title) => bracket.test(title) || paren.test(title) || colon.test(title)
    || standalone.test(title);
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
 * Returns the canonical labels of every matched marker, in a stable order
 * (the declaration order of {@link MARKER_MATCHERS}). Each label can appear
 * at most once: MARKER_MATCHERS visits each entry exactly once and every
 * entry's label is distinct, so the result is de-duped by construction —
 * there is no separate dedupe step to fail. Returns an empty array when the
 * title is clean, empty, or not a string.
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
    if (test(title)) {
      matched.push(label);
    }
  }
  return matched;
}
