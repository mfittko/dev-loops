/**
 * Secret scan over a unified git diff. The added and context lines of each
 * file are linted as one source; only matches touching an added line count.
 *
 * Detection runs through the maintained `@secretlint/core` engine with the
 * `@secretlint/secretlint-rule-preset-recommend` rule set (provider token
 * formats, private keys, basic-auth URLs, ...). This module is a thin adapter:
 * it owns the diff parsing, the allow marker and the finding shape, and it adds
 * no detector of its own. The fuzzy part (a prefixless secret, a secret value
 * written to a log or file) is judged by the gate reviewer, not here.
 *
 * Enforcement split: warn locally, block at merge. The merge gate
 * (`scripts/github/merge-pr.mjs`, precondition `secret_scan`) blocks
 * fail-closed. The local pre-commit hook is the early signal: it prints each
 * candidate to stderr and exits 0, and the agent judges the candidate.
 * A blocking false positive costs an agent loop a stopped pass, an extra
 * dispatch and a reworded line, so no home-built heuristic sits in a blocking
 * path.
 *
 * A finding never carries the matched value: only file, line, rule id and a
 * canned reason.
 *
 * Allowlisting: a `secret-scan:allow <reason>` marker on the SAME line
 * exempts that one line from every rule. A marker without a reason exempts
 * nothing. There is no global disable and no central baseline file.
 */
import { lintSource } from "@secretlint/core";
import { creator as recommendedPreset } from "@secretlint/secretlint-rule-preset-recommend";

export const ALLOW_MARKER = "secret-scan:allow";
const ALLOW_RE = /secret-scan:allow\s+(\S.*?)\s*$/u;

// The preset default skips a bare AWS access key id; enableIDScanRule turns it on.
// filter-comments is disabled: its `secretlint-disable` comments would be a
// reason-free, multi-line exemption beside the same-line allow marker.
const SECRETLINT_CONFIG = {
  rules: [{
    id: recommendedPreset.meta.id,
    rule: recommendedPreset,
    rules: [
      { id: "@secretlint/secretlint-rule-aws", options: { enableIDScanRule: true } },
      { id: "@secretlint/secretlint-rule-filter-comments", disabled: true },
    ],
  }],
};

/**
 * The reason a line is allowlisted, or `null` when it is not. Any comment
 * syntax works: this is a plain substring test.
 * @param {string} text
 * @returns {string|null}
 */
export function allowlistReason(text) {
  const match = ALLOW_RE.exec(text);
  return match ? match[1] : null;
}

/**
 * Parse a unified diff (`git diff --cached` output) into `{ file, line, text,
 * added }` entries, one per ADDED or context line of the new file; `line` is
 * the new-file 1-based line number. Removed lines are skipped. A binary-file
 * diff (no `@@` hunk) yields no entries for that file.
 * @param {string} diffText
 * @returns {{ file: string, line: number, text: string, added: boolean }[]}
 */
export function parseDiffLines(diffText) {
  const entries = [];
  let file = null;
  let newLine = 0;
  // `+++ `/`--- ` are STRUCTURAL file headers only before the first `@@`
  // hunk of a file — inside a hunk, a line starting with `+` (even `++ ` or
  // `--- `-shaped content) is added/removed CONTENT, never a header. Gate the
  // header checks on hunk position (`inHunk`), not a naive prefix test alone,
  // so a planted credential on a line whose content happens to start with
  // `+ ` can never be misread as a header and skipped.
  let inHunk = false;
  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      newLine = 0; // the next file's index/mode/rename headers are not context lines
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
      entries.push({ file, line: newLine, text: rawLine.slice(1), added: true });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) continue; // removed line — never advances the new-file counter
    if (rawLine.startsWith("\\")) continue; // "\ No newline at end of file"
    // A context line (leading space) or a blank line inside a hunk both
    // still exist in the new file, so both advance the counter.
    if (newLine > 0) {
      entries.push({ file, line: newLine, text: rawLine.slice(1), added: false });
      newLine += 1;
    }
  }
  return entries;
}

/**
 * Scan a full unified diff. The added AND context lines of each file are linted as one
 * source, so a multi-line credential (a PEM block) is seen whole; only matches touching an added line count. Readers pass a huge `-U` so the context is the whole file.
 * Throws when the library fails; callers treat a throw as a refusal.
 * @param {string} diffText
 * @returns {Promise<{ ok: boolean, findings: { file: string|null, line: number|null, ruleId: string, reason: string }[] }>}
 */
export async function scanDiffText(diffText) {
  const byFile = Map.groupBy(parseDiffLines(diffText), (entry) => entry.file);
  const findings = [];
  for (const [file, entries] of byFile) {
    // secretlint also breaks lines on a lone CR, U+2028 (\p{Zl}) and U+2029
    // (\p{Zp}); a length-preserving space keeps its line N equal to entries[N - 1].
    const content = entries.map((e) => e.text.replace(/[\r\p{Zl}\p{Zp}]/gu, " ")).join("\n");
    const result = await lintSource({
      source: { filePath: file ?? "unknown", content, contentType: "text" },
      options: { config: SECRETLINT_CONFIG, maskSecrets: true, noPhysicFilePath: true },
    });
    for (const message of result.messages) {
      const start = message.loc?.start?.line ?? 0;
      const end = Math.max(start, message.loc?.end?.line ?? start);
      const first = entries[start - 1];
      let line = null;
      if (!first) {
        // An unmappable location is still reported, and no allow marker applies to it.
      } else {
        // Keep the finding while any ADDED line in the matched range lacks a valid marker.
        const open = entries.slice(start - 1, end).find((e) => e.added && allowlistReason(e.text) === null);
        if (!open) continue;
        line = open.line;
      }
      findings.push({ file, line, ruleId: message.ruleId, reason: `matches secretlint rule ${message.ruleId} (${message.messageId})` });
    }
  }
  return { ok: findings.length === 0, findings };
}
