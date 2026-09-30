// Pure text helpers for the inline gate-finding layout: sentence-boundary
// cuts, per-field caps, the filler-phrase lint, and the same-defect merge
// rule. Everything here works on raw reviewer text, before any sanitizer runs.

import { resolveFindingFile, severityRank } from "@dev-loops/core/loop/gate-fanin";

// Per-field caps in characters. The problem cap is the summary bound. The
// recommendation has its own bound. The durable ledger keeps the full text.
export const PROBLEM_CAP = 400;
export const FAILING_CASE_CAP = 240;
export const RECOMMENDATION_CAP = 500;
export const MAX_FIX_STEPS = 5;

// Marks each index of `text` that lies inside a code span or code fence.
function codeMask(text) {
  const mask = new Array(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") { i += 1; continue; }
    let run = 1;
    while (text[i + run] === "`") run += 1;
    // A run followed by whitespace is a stray backtick, not a span opener, so
    // it cannot pair with the opener of the next real span.
    if (run === 1 && i + run < text.length && /\s/.test(text[i + run])) { i += run; continue; }
    // A run of backticks closes at the next run of the same length; an
    // unclosed run is plain text.
    const closer = text.indexOf("`".repeat(run), i + run);
    if (closer === -1) { i += run; continue; }
    const end = closer + run;
    for (let k = i; k < end; k += 1) mask[k] = true;
    i = end;
  }
  return mask;
}

// A `.` that ends a bare list number (`1.`) or a known abbreviation is not a
// sentence end. ponytail: fixed abbreviation list, extend when a new one splits.
const ABBREVIATION_TAIL = /(?:^|[.!?]\s+)\d+$|(?:^|\n)[ \t]*\d+$|(?:^|\s)(?:e\.g|i\.e|vs|etc|cf)$/i;

// Indices just after each sentence end: `.`, `!` or `?` outside code, followed
// by whitespace or the end of the text.
function sentenceEnds(text) {
  const mask = codeMask(text);
  const ends = [];
  for (let i = 0; i < text.length; i += 1) {
    if (mask[i] || !".!?".includes(text[i])) continue;
    if (i + 1 !== text.length && !/\s/.test(text[i + 1])) continue;
    if (text[i] === "." && i + 1 !== text.length && ABBREVIATION_TAIL.test(text.slice(0, i))) continue;
    ends.push(i + 1);
  }
  // A newline that starts a numbered list line also ends the previous step,
  // so an unpunctuated newline list splits at each marker.
  const marker = /\n(?=[ \t]*\d+[.)]\s)/g;
  for (let m = marker.exec(text); m; m = marker.exec(text)) {
    if (!mask[m.index] && !ends.includes(m.index)) ends.push(m.index);
  }
  ends.sort((a, b) => a - b);
  return ends;
}

export function splitSentences(text) {
  const trimmed = String(text).trim();
  const sentences = [];
  let start = 0;
  for (const end of sentenceEnds(trimmed)) {
    sentences.push(trimmed.slice(start, end).trim());
    start = end;
  }
  const rest = trimmed.slice(start).trim();
  if (rest.length > 0) sentences.push(rest);
  return sentences;
}

// Cuts `text` to at most `cap` characters at the last sentence boundary that
// fits. Never splits a code span or fence. With no sentence boundary inside the
// cap, cuts at the last whitespace outside code and appends an ellipsis.
export function cutAtSentence(text, cap) {
  const trimmed = String(text).trim();
  if (trimmed.length <= cap) return { text: trimmed, cut: false };
  const fitting = sentenceEnds(trimmed).filter((end) => end <= cap);
  if (fitting.length > 0) return { text: trimmed.slice(0, fitting[fitting.length - 1]).trim(), cut: true };
  const mask = codeMask(trimmed);
  for (let i = cap; i > 0; i -= 1) {
    if (/\s/.test(trimmed[i]) && !mask[i]) return { text: `${trimmed.slice(0, i).trim()}…`, cut: true };
  }
  // No whitespace outside code before cap. If cap lands inside a code span,
  // cut before the span starts.
  let end = cap;
  if (mask[cap]) while (end > 0 && mask[end - 1]) end -= 1;
  return { text: `${trimmed.slice(0, end).trim()}…`, cut: true };
}

// Reviewer filler the style rules forbid. The lint flags and never rewrites.
const FILLER_PATTERNS = [
  /\bit is worth (?:noting|mentioning)\b/i,
  /\bit should be noted\b/i,
  /\bnote that\b/i,
  /\bthis (?:pr|change|diff|commit|patch) (?:adds|introduces|changes|updates|refactors|modifies)\b/i,
  /\bin summary\b/i,
  /\bto summari[sz]e\b/i,
  /\bI (?:think|believe)\b/i,
  /\bit seems\b/i,
  /\bperhaps\b/i,
  /\byou (?:might|may) want to\b/i,
  /\bhope this helps\b/i,
  /\blet me know\b/i,
];

export function lintFillerPhrases(text) {
  const source = String(text);
  const matches = [];
  for (const pattern of FILLER_PATTERNS) {
    const found = pattern.exec(source);
    if (found) matches.push({ phrase: found[0], index: found.index });
  }
  return matches.sort((a, b) => a.index - b.index);
}

// Same-defect rule for the pre-post merge. Two findings merge only when ALL of:
//   1. they share files[0] and line (both present),
//   2. they are both questions or both non-questions,
//   3. they carry the same judgeDisposition (both absent counts as the same),
//   4. their summaries overlap: at least five shared word stems (first five
//      letters) of words of four or more letters outside code spans, and the shared words are at least half of the smaller summary's
//      word set.
// Findings on one line that describe different defects share few words and stay
// separate. The rule is conservative: a missed merge only costs an extra thread.
// Common words carry no defect identity, so they never count toward overlap.
const STOPWORDS = new Set(["when", "that", "this", "with", "from", "then", "than", "into", "which", "where", "while", "does", "have", "will", "also", "only", "each", "they", "them", "there", "their", "been", "being", "should", "could", "would", "because", "after", "before"]);
function summaryWords(summary) {
  // Code-span text is an identifier; same-line findings share identifiers, so it carries no defect identity.
  return new Set(String(summary).replace(/`[^`]*`/g, " ").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !STOPWORDS.has(word)).map((word) => word.slice(0, 5)));
}

export function isSameDefect(a, b) {
  const fileA = resolveFindingFile(a);
  if (!fileA || fileA !== resolveFindingFile(b)) return false;
  if (!Number.isInteger(a.line) || a.line !== b.line) return false;
  if ((a.severity === "question") !== (b.severity === "question")) return false;
  if ((a.judgeDisposition ?? null) !== (b.judgeDisposition ?? null)) return false;
  const wordsA = summaryWords(a.summary);
  const wordsB = summaryWords(b.summary);
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared >= 5 &&shared * 2 >= Math.min(wordsA.size, wordsB.size);
}

// Groups same-defect findings. Every group of one is returned unchanged. A
// merged group is the highest-severity finding (first wins a tie) plus
// `mergedFindings` (every member, in input order), so the renderer keeps each
// member's fingerprint and angle.
export function mergeSameDefectFindings(findings) {
  const groups = [];
  for (const finding of findings) {
    const group = groups.find((members) => isSameDefect(members[0], finding));
    if (group) group.push(finding);
    else groups.push([finding]);
  }
  return groups.map((members) => {
    if (members.length === 1) return members[0];
    const primary = members.reduce((best, m) => (severityRank(m.severity) < severityRank(best.severity) ? m : best));
    return { ...primary, operatorVisible: members.some((m) => m.operatorVisible === true), mergedFindings: members };
  });
}
