/**
 * Secret scan over the ADDED lines of a unified git diff.
 *
 * Detection runs through the maintained `@secretlint/core` engine with the
 * `@secretlint/secretlint-rule-preset-recommend` rule set (provider token
 * formats, private keys, basic-auth URLs, ...). This module is a thin adapter:
 * it owns the diff parsing, the allow marker and the finding shape, and it adds
 * no detector of its own. The fuzzy part (a prefixless secret, a secret value
 * written to a log or file) is judged by the gate reviewer, not here.
 *
 * Enforcement split: the merge gate (`scripts/github/merge-pr.mjs`,
 * precondition `secret_scan`) blocks fail-closed; the local pre-commit hook is
 * the early signal and warns (issue 1858 moves it from blocking to warning).
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
const SECRETLINT_CONFIG = {
  rules: [{
    id: recommendedPreset.meta.id,
    rule: recommendedPreset,
    rules: [{ id: "@secretlint/secretlint-rule-aws", options: { enableIDScanRule: true } }],
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
  // `+ ` can never be misread as a header and skipped.
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
 * Scan a full unified diff. The added lines of each file are linted as one
 * source, so a multi-line credential (a PEM block) is still seen whole.
 * Throws when the library fails; callers treat a throw as a refusal.
 * @param {string} diffText
 * @returns {Promise<{ ok: boolean, findings: { file: string|null, line: number, ruleId: string, reason: string }[] }>}
 */
export async function scanDiffText(diffText) {
  const byFile = Map.groupBy(parseAddedLines(diffText), (entry) => entry.file);
  const findings = [];
  for (const [file, entries] of byFile) {
    const result = await lintSource({
      source: { filePath: file ?? "unknown", content: entries.map((e) => e.text).join("\n"), contentType: "text" },
      options: { config: SECRETLINT_CONFIG, maskSecrets: true, noPhysicFilePath: true },
    });
    for (const message of result.messages) {
      // An unmappable location falls back to the first line so a hit is never dropped.
      const entry = entries[(message.loc?.start?.line ?? 1) - 1] ?? entries[0];
      if (allowlistReason(entry.text) !== null) continue;
      findings.push({ file, line: entry.line, ruleId: message.ruleId, reason: `matches secretlint rule ${message.ruleId} (${message.messageId})` });
    }
  }
  return { ok: findings.length === 0, findings };
}
