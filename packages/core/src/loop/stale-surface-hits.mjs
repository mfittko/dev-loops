/**
 * stale-surface-hits.mjs: the deterministic stale-surface check of the pre-push delta review
 * (skills/docs/pre-pr-review-contract.md, PRE-PUSH-DELTA-INPUT and PRE-PUSH-DELTA-RESULT).
 *
 * A fix can remove a sentence or rename an identifier while another tracked file still carries
 * the old text. This module extracts the removed sentences (Markdown and test hunks) and removed
 * identifiers (code hunks) from a unified diff and asks a caller-supplied `grep` for the remaining
 * hits at the candidate head. Pure: the caller owns git.
 */

const MIN_SENTENCE = 20;
const MIN_IDENTIFIER = 6;
const MAX_HITS_PER_NEEDLE = 20;
const MAX_HITS = 100;

const isMarkdown = (file) => /\.md$/i.test(file);
const isTestFile = (file) => /(^|\/)test\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

/** Per file: the removed and added line texts of a unified diff. */
function parseDiff(diffText) {
  const files = [];
  let current = null;
  for (const line of String(diffText).split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { current = { file: header[1], removed: [], added: [] }; files.push(current); continue; }
    if (!current || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return files;
}

function sentencesOf(file, removed, added) {
  const addedText = added.join(" ");
  const candidates = isMarkdown(file)
    ? removed.join(" ").split(/(?<=[.!?])\s+/u)
    : removed.flatMap((line) => [...line.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/gu)].map((m) => m[1] ?? m[2] ?? m[3]));
  return candidates.map((s) => s.trim()).filter((s) => s.length >= MIN_SENTENCE && !addedText.includes(s));
}

function identifiersOf(removed, added) {
  const words = (lines) => new Set(lines.join("\n").match(/[A-Za-z_$][\w$]*/gu) ?? []);
  const kept = words(added);
  return [...words(removed)].filter((w) => w.length >= MIN_IDENTIFIER && !kept.has(w));
}

/**
 * @param {{ diffText: string, grep: (needle: string, options: { word: boolean }) => Array<{ file: string, line: number }> }} input
 *   grep lists tracked-file hits of a fixed string at the candidate head.
 * @returns {Array<{ kind: "sentence"|"identifier", needle: string, file: string, line: number, site: string }>}
 */
export function collectStaleSurfaceHits({ diffText, grep }) {
  const hits = [];
  for (const { file: source, removed, added } of parseDiff(diffText)) {
    const items = [];
    if (isMarkdown(source) || isTestFile(source)) items.push(...sentencesOf(source, removed, added).map((needle) => ({ kind: "sentence", needle })));
    if (!isMarkdown(source)) items.push(...identifiersOf(removed, added).map((needle) => ({ kind: "identifier", needle })));
    for (const { kind, needle } of items) {
      const found = grep(needle, { word: kind === "identifier" });
      // An identifier that still occurs in the file that dropped it was not removed.
      if (kind === "identifier" && found.some((h) => h.file === source)) continue;
      for (const { file, line } of found.slice(0, MAX_HITS_PER_NEEDLE)) hits.push({ kind, needle, file, line, site: `${file}:${line}` });
    }
  }
  return hits.slice(0, MAX_HITS);
}
