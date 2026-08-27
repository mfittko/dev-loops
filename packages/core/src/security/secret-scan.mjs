/**
 * Fail-closed secret scan over the ADDED lines of a unified git diff.
 *
 * No external dependency (no gitleaks/trufflehog): this module is a small,
 * self-contained detector set, deliberately kept auditable rather than
 * outsourced. It is deterministic and side-effect free — it never reads or
 * writes anything itself; callers (the CLI, the git hook) supply the diff
 * text and act on the result.
 *
 * Three detector classes (see DETECTOR_CLASSES):
 *  - literal-credential: a known provider token PREFIX (ghp_, xoxb-, AKIA...,
 *    a PEM private-key header, ...), literal OR base64-encoded.
 *  - high-entropy: a long single-token run whose Shannon entropy is above a
 *    tuned threshold — catches a credential with no recognized prefix.
 *  - sink-pattern: a secret-NAMED variable (*TOKEN*, *SECRET*, ...) and an
 *    output sink (echo/printf/tee/base64/redirect/workflow `::` directive)
 *    on the SAME line — no literal secret value has to be present in the diff
 *    for this to fire; it is what catches a secret-named var piped into a
 *    logged/echoed stream.
 *
 * A finding NEVER carries the matched value — only file/line/detector-class
 * and a canned, value-free reason string. A secret, once flagged, is treated
 * as unrecoverable: there is no "show me the match" affordance anywhere in
 * this module.
 *
 * Allowlisting: an inline `secret-scan:allow` marker plus a trailing reason
 * (comment syntax is irrelevant — this is a plain substring test) on the SAME
 * line exempts that one line from every detector. There is no global disable
 * and no central baseline file — every exemption is visible in the diff it
 * exempts.
 */

export const DETECTOR_CLASSES = Object.freeze({
  LITERAL_CREDENTIAL: "literal-credential",
  HIGH_ENTROPY: "high-entropy",
  SINK_PATTERN: "sink-pattern",
});

export const ALLOW_MARKER = "secret-scan:allow";
const ALLOW_RE = /secret-scan:allow\s+(\S.*?)\s*$/u;

/**
 * Known provider token/credential PREFIX formats. Each pattern requires the
 * full token shape (prefix + a plausible body length), not just the prefix
 * alone — a bare mention of a prefix constant (as in this module's own
 * source) is short of the required body length and never self-matches.
 */
const LITERAL_PATTERNS = [
  { name: "github-pat-classic", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "github-pat-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "github-oauth-token", re: /\bgho_[A-Za-z0-9]{20,}\b/ },
  { name: "github-user-to-server-token", re: /\bghu_[A-Za-z0-9]{20,}\b/ },
  { name: "github-server-to-server-token", re: /\bghs_[A-Za-z0-9]{20,}\b/ },
  { name: "github-refresh-token", re: /\bghr_[A-Za-z0-9]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "pem-private-key", re: /-----BEGIN [A-Z0-9]+(?: [A-Z0-9]+)* PRIVATE KEY-----/ },
];

/** True when `text` matches any known literal credential prefix format. */
function matchLiteralPattern(text) {
  for (const pattern of LITERAL_PATTERNS) {
    if (pattern.re.test(text)) return pattern.name;
  }
  return null;
}

// A base64-shaped run long enough to plausibly carry an encoded credential.
// `g` (global) so every candidate run on the line is checked, not just the
// first.
const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/]{20,}={0,2}/gu;

/**
 * Whether `text` contains a base64-shaped substring that DECODES to a known
 * literal credential format — the "value stored encoded" case a plain
 * literal-prefix scan over the RAW diff text would miss.
 */
function matchBase64Credential(text) {
  const candidates = text.match(BASE64_CANDIDATE_RE) ?? [];
  for (const candidate of candidates) {
    let decoded;
    try {
      decoded = Buffer.from(candidate, "base64").toString("utf8");
    } catch {
      continue;
    }
    const hit = matchLiteralPattern(decoded);
    if (hit) return hit;
  }
  return null;
}

/**
 * Shannon entropy in bits/character. Pure math, no I/O — exported so the
 * threshold this module tunes is independently testable.
 * @param {string} str
 * @returns {number}
 */
export function shannonEntropy(str) {
  if (str.length === 0) return 0;
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// A candidate is a single unbroken run (no whitespace, no `=`) of the
// characters a token/secret literal is typically made of. `=` is
// deliberately EXCLUDED from the run (unlike the base64-candidate pattern
// above, which keeps it for trailing padding): an ordinary `KEY=value`
// shell/env assignment is otherwise read as one inflated, higher-entropy
// candidate spanning both sides of the `=` — splitting there scores the key
// and the value separately, each far more likely to fall under the length or
// digit/letter floor below on its own. Tuned length/threshold: 20 chars is
// short enough to catch a real secret, long enough that ordinary identifiers
// rarely reach it; 4.3 bits/char sits between plain lowercase English (~4.0
// max, usually much lower) and true base64/hex randomness (~4.5-6). Both
// digit AND letter are required so a long plain word (no digits) never
// qualifies — false positives here cost only an allowlist line; a missed
// real secret costs a leak, so the length/threshold pair leans toward
// catching more, not fewer.
const ENTROPY_CANDIDATE_RE = /[A-Za-z0-9+/_.-]{20,}/gu;
const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_THRESHOLD = 4.3;

function hasHighEntropyToken(text) {
  const candidates = text.match(ENTROPY_CANDIDATE_RE) ?? [];
  for (const candidate of candidates) {
    if (candidate.length < ENTROPY_MIN_LENGTH) continue;
    if (!/[0-9]/.test(candidate) || !/[A-Za-z]/.test(candidate)) continue;
    if (shannonEntropy(candidate) >= ENTROPY_THRESHOLD) return true;
  }
  return false;
}

// A variable/env-key NAME that reads as a secret. Substring match for
// TOKEN/SECRET/PASSWORD(/PASSWD) (`API_TOKEN`, `authToken`, `DB_PASSWORD`,
// ...), suffix match for `_PAT`/`_KEY` (deliberately a suffix, not a
// substring — "_KEY" alone would otherwise fire on ordinary words like
// "keyboard"), plus the literal incident-motivating name.
const SECRET_NAME_RE = /\w*(?:TOKEN|SECRET|PASSWORD|PASSWD)\w*|\w*_PAT\b|\w*_KEY\b|\bBUNDLE_GITHUB__COM\b/iu;

// Output sinks named in the motivating incident: echo/printf/tee, base64
// (encode-then-emit), a `>`/`>>` redirect, and a GitHub Actions workflow
// `::directive::`. This is deliberately a same-line, no-literal-value-
// required class, so a variable name reaching a sink is enough on its own.
// A workflow mask directive next to the sink call does not change the
// verdict: masking only redacts what CI's log renderer shows LATER, so a
// value still reaches this stream unmasked, and the flow is still a hit.
// The redirect branch excludes `=>`/`->`/`>=` (lookbehind/lookahead around the
// bare `>`/`>>`) — those are an arrow function or a comparison in ordinary
// source, not a shell redirect, and would otherwise fire on nearly any JS/TS
// line that also happens to name a *TOKEN*/*SECRET*/... variable.
const SINK_RE = /\b(?:echo|printf|tee|base64)\b|(?<![=-])>{1,2}(?!=)|::[A-Za-z][\w-]*::/u;

function hasSecretNameToSinkFlow(text) {
  return SECRET_NAME_RE.test(text) && SINK_RE.test(text);
}

/**
 * The reason a matched line is allowlisted, or `null` when it is not. Any
 * comment syntax works (`#`, `//`, `<!--`, ...): this is a plain substring
 * test, not a language-aware parse — the `secret-scan:allow` marker plus a
 * trailing reason exempts the ONE line it appears on, nothing else.
 * @param {string} text
 * @returns {string|null}
 */
export function allowlistReason(text) {
  const match = ALLOW_RE.exec(text);
  return match ? match[1] : null;
}

/**
 * Scan one added line's text against all three detector classes.
 * @param {string} text
 * @returns {{ detectorClass: string, reason: string }[]}
 */
export function scanLineText(text) {
  if (allowlistReason(text) !== null) return [];
  const findings = [];
  const literal = matchLiteralPattern(text) ?? matchBase64Credential(text);
  if (literal) {
    findings.push({
      detectorClass: DETECTOR_CLASSES.LITERAL_CREDENTIAL,
      reason: `matches known credential format (${literal})`,
    });
  }
  if (hasHighEntropyToken(text)) {
    findings.push({
      detectorClass: DETECTOR_CLASSES.HIGH_ENTROPY,
      reason: "high-entropy token-shaped literal",
    });
  }
  if (hasSecretNameToSinkFlow(text)) {
    findings.push({
      detectorClass: DETECTOR_CLASSES.SINK_PATTERN,
      reason: "secret-named variable flows into an output sink on this line",
    });
  }
  return findings;
}

/**
 * Parse a unified diff (`git diff --cached` output) into `{ file, line, text
 * }` entries — one per ADDED line, `line` the new-file 1-based line number.
 * Removed/context lines are skipped (but context lines still advance the
 * new-file line counter). A binary-file diff (no `@@` hunk) yields no
 * entries for that file.
 * @param {string} diffText
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function parseAddedLines(diffText) {
  const entries = [];
  let file = null;
  let newLine = 0;
  // `+++ `/`--- ` are STRUCTURAL file headers only before the first `@@`
  // hunk of a file — inside a hunk, a line starting with `+` (even `++ ` or
  // `--- `-shaped content) is added/removed CONTENT, never a header. Gate the
  // header checks on hunk position (`inHunk`), not a naive prefix test alone,
  // so a planted credential on a line whose content happens to start with
  // `+ ` can never be misread as a header and skipped from every detector.
  let inHunk = false;
  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).replace(/\t.*$/u, "");
      file = target === "/dev/null" ? null : target.replace(/^b\//u, "");
      continue;
    }
    if (!inHunk && rawLine.startsWith("--- ")) continue;
    if (rawLine.startsWith("@@")) {
      const match = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      inHunk = true;
      continue;
    }
    if (rawLine.startsWith("+")) {
      entries.push({ file, line: newLine, text: rawLine.slice(1) });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) continue; // removed line — never advances the new-file counter
    if (rawLine.startsWith("\\")) continue; // "\ No newline at end of file"
    // A context line (leading space) or a blank line inside a hunk both
    // still exist in the new file, so both advance the counter.
    if (newLine > 0) newLine += 1;
  }
  return entries;
}

/**
 * Scan a full unified diff. Findings never carry the matched substring —
 * only file/line/detectorClass/reason.
 * @param {string} diffText
 * @returns {{ ok: boolean, findings: { file: string, line: number, detectorClass: string, reason: string }[] }}
 */
export function scanDiffText(diffText) {
  const findings = [];
  for (const entry of parseAddedLines(diffText)) {
    for (const hit of scanLineText(entry.text)) {
      findings.push({ file: entry.file, line: entry.line, ...hit });
    }
  }
  return { ok: findings.length === 0, findings };
}
