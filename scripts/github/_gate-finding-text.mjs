// Pure text helpers for the inline gate-finding layout: sentence-boundary
// cuts, per-field caps, the filler-phrase lint, and the same-defect merge
// rule. No imports: everything here works on raw reviewer text, before any
// sanitizer runs.

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

// Indices just after each sentence end: `.`, `!` or `?` outside code, followed
// by whitespace or the end of the text.
function sentenceEnds(text) {
  const mask = codeMask(text);
  const ends = [];
  for (let i = 0; i < text.length; i += 1) {
    if (mask[i] || !".!?".includes(text[i])) continue;
    if (i + 1 === text.length || /\s/.test(text[i + 1])) ends.push(i + 1);
  }
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
  return { text: `${trimmed.slice(0, cap).trim()}…`, cut: true };
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
//   2. they carry the same judgeDisposition (both absent counts as the same),
//   3. their summaries overlap: at least three shared words of four or more
//      letters, and the shared words are at least half of the smaller summary's
//      word set.
// Findings on one line that describe different defects share few words and stay
// separate. The rule is conservative: a missed merge only costs an extra thread.
function summaryWords(summary) {
  return new Set(String(summary).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
}

export function isSameDefect(a, b) {
  const fileA = Array.isArray(a.files) ? a.files[0] : undefined;
  const fileB = Array.isArray(b.files) ? b.files[0] : undefined;
  if (!fileA || fileA !== fileB) return false;
  if (!Number.isInteger(a.line) || a.line !== b.line) return false;
  if ((a.judgeDisposition ?? null) !== (b.judgeDisposition ?? null)) return false;
  const wordsA = summaryWords(a.summary);
  const wordsB = summaryWords(b.summary);
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared >= 3 && shared >= Math.min(wordsA.size, wordsB.size) / 2;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, question: 3, nit: 4 };

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
    const primary = members.reduce((best, m) => ((SEVERITY_RANK[m.severity] ?? 9) < (SEVERITY_RANK[best.severity] ?? 9) ? m : best));
    return { ...primary, mergedFindings: members };
  });
}
