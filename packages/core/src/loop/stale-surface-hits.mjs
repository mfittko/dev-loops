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
// An identifier found in more files than this is too common to be a specific stale reference.
const MAX_FILES_PER_IDENTIFIER = 5;

const isMarkdown = (file) => /\.md$/i.test(file);
const isTestFile = (file) => /(^|\/)test\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
// Tests and docs come first so the caps drop source hits before the hits that pin old text.
const priority = (file) => (isTestFile(file) ? 0 : isMarkdown(file) ? 1 : 2);

/**
 * Per file: the removed and added line texts of a unified diff. Hunk state is tracked so a removed
 * line that starts with `--` is content, and a deleted file (`+++ /dev/null`) keeps its old path.
 */
function parseDiff(diffText) {
  const files = [];
  let current = null;
  let oldPath = null;
  let inHunk = false;
  for (const line of String(diffText).split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; current = null; oldPath = null; continue; }
    if (!inHunk) {
      // Git appends one TAB to a header path that holds a space.
      const from = /^--- (?:a\/(.+?)|\/dev\/null)\t?$/.exec(line);
      if (from) { oldPath = from[1] ?? null; continue; }
      const to = /^\+\+\+ (?:b\/(.+?)|\/dev\/null)\t?$/.exec(line);
      if (to) {
        const file = to[1] ?? oldPath;
        if (file) { current = { file, removed: [], added: [] }; files.push(current); }
        continue;
      }
      // Fail closed: a C-quoted or otherwise unparseable header would drop the file's removed lines.
      if (/^(?:---|\+\+\+) /.test(line)) throw new Error(`stale-surface diff header could not be parsed: ${line}`);
      if (line.startsWith("@@")) { inHunk = true; current?.removed.push(""); }
      continue;
    }
    if (line.startsWith("@@")) { current?.removed.push(""); continue; }
    if (!current) throw new Error(`stale-surface diff hunk line has no parsed file header: ${line}`);
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return files;
}

// Code with string literals and comments removed, so only identifiers remain.
function codeOnly(line) {
  if (/^\s*(\*|\/\*|\/\/|#)/u.test(line)) return "";
  return line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gu, '""').replace(/\/\*.*?\*\//gu, "").replace(/\/\/.*$/u, "");
}

const wordsOf = (lines) => new Set(lines.join("\n").match(/[A-Za-z_$][\w$]*/gu) ?? []);
const escapeRe = (s) => s.replace(/[$]/gu, "\\$");

// A removed identifier counts when a removed line declares it (function, class, binding, method or property).
function isDeclaredIn(name, codeLines) {
  const n = escapeRe(name);
  const declaration = new RegExp(`\\b(?:function\\*?|class|const|let|var|def|fn|func|type|interface|enum|struct)\\s+${n}(?![\\w$])|(?:^|[\\s,{])(?:async\\s+)?${n}\\s*(?:[:=](?!=)|\\([^)]*\\)\\s*\\{)`, "u");
  return codeLines.some((line) => declaration.test(line));
}

const squash = (s) => s.replace(/\s+/gu, " ");

// Removed Markdown lines as blocks: a list item, heading or table row starts a block, a blank line
// (or a hunk boundary) ends one, and the markers are stripped. Table cells are separate blocks.
function markdownBlocks(removed) {
  const blocks = [];
  let block = null;
  const flush = () => { if (block) blocks.push(block.join(" ")); block = null; };
  for (const line of removed) {
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|/u.test(line)) {
      flush();
      blocks.push(...line.trim().replace(/^\||\|$/gu, "").split("|"));
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line) ?? /^\s*#{1,6}\s+(.*)$/u.exec(line);
    if (item) { flush(); block = [item[1]]; continue; }
    (block ??= []).push(line);
  }
  flush();
  return blocks;
}

function sentencesOf(file, removed, addedAll) {
  const candidates = isMarkdown(file)
    ? markdownBlocks(removed).flatMap((b) => squash(b).split(/(?<=[.!?])\s+/u))
    : removed.flatMap((line) => [...line.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/gu)].map((m) => m[1] ?? m[2] ?? m[3]));
  return candidates.map((s) => squash(s).trim()).filter((s) => s.length >= MIN_SENTENCE && !addedAll.includes(s));
}

function identifiersOf(removed, addedCode) {
  const code = removed.map(codeOnly);
  return [...wordsOf(code)].filter((w) => w.length >= MIN_IDENTIFIER && isDeclaredIn(w, code) && !isDeclaredIn(w, addedCode));
}

/**
 * @param {{ diffText: string, grep: (needle: string, options: { word: boolean }) => Array<{ file: string, line: number }> }} input
 *   grep lists tracked-file hits of a fixed string at the candidate head.
 * @returns {{ hits: Array<{ kind: "sentence"|"identifier", needle: string, file: string, line: number, site: string }>, truncated: boolean }}
 *   truncated is true when a cap dropped hits; truncatedNeedles names the identifiers dropped as too common.
 */
export function collectStaleSurface({ diffText, grep }) {
  const files = parseDiff(diffText);
  // "Still added" is diff-wide: text moved to another file is not removed.
  const addedLines = files.flatMap((f) => f.added);
  const addedAll = squash(addedLines.join(" "));
  // Only a declaration shape on an added code line re-adds an identifier: a call or a Markdown mention does not.
  const addedCode = files.filter((f) => !isMarkdown(f.file)).flatMap((f) => f.added).map(codeOnly);
  const hits = [];
  let truncated = false;
  const truncatedNeedles = [];
  for (const { file: source, removed } of files) {
    const items = [];
    if (isMarkdown(source) || isTestFile(source)) items.push(...sentencesOf(source, removed, addedAll).map((needle) => ({ kind: "sentence", needle })));
    if (!isMarkdown(source)) items.push(...identifiersOf(removed, addedCode).map((needle) => ({ kind: "identifier", needle })));
    for (const { kind, needle } of items) {
      const found = grep(needle, { word: kind === "identifier" });
      // An identifier that still occurs in the file that dropped it was not removed.
      if (kind === "identifier" && found.some((h) => h.file === source)) continue;
      if (kind === "identifier" && new Set(found.map((h) => h.file)).size > MAX_FILES_PER_IDENTIFIER) {
        truncated = true;
        truncatedNeedles.push({ kind, needle, fileCount: new Set(found.map((h) => h.file)).size });
        continue;
      }
      const ordered = [...found].sort((a, b) => priority(a.file) - priority(b.file));
      if (ordered.length > MAX_HITS_PER_NEEDLE) truncated = true;
      for (const { file, line } of ordered.slice(0, MAX_HITS_PER_NEEDLE)) hits.push({ kind, needle, file, line, site: `${file}:${line}` });
    }
  }
  if (hits.length > MAX_HITS) truncated = true;
  const kept = hits.map((hit, index) => ({ hit, index })).sort((a, b) => priority(a.hit.file) - priority(b.hit.file) || a.index - b.index).slice(0, MAX_HITS);
  return { hits: kept.sort((a, b) => a.index - b.index).map((k) => k.hit), truncated, truncatedNeedles };
}

/** The hits only; use `collectStaleSurface` to learn whether a cap dropped some. */
export const collectStaleSurfaceHits = (input) => collectStaleSurface(input).hits;
