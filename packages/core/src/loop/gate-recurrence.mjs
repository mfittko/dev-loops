/**
 * gate-recurrence.mjs: recurrence escalation for repeated fixer passes on one
 * surface (skills/docs/gate-review-sub-loop-contract.md,
 * GATE-EXEC-RECURRENCE-ESCALATION).
 *
 * A surface key is `(file, symbol)`. `symbol` is a backticked identifier in the
 * finding summary that the file defines at the current head. The count is
 * computed from the current round and the closed prior-round ledgers of the same
 * gate and PR; nothing here persists a counter.
 *
 * Pure and offline: the caller injects file sources and the prior ledgers.
 */
import path from "node:path";

import { resolveFindingFile } from "./gate-fanin.mjs";

/** Act items on one surface in this many counted rounds escalate. */
export const ESCALATION_THRESHOLD = 3;

const BACKTICKED = /`([A-Za-z_$][\w$-]*)(?:\(\))?`/g;

/** The finding's file in one posix form, so `./a\b.mjs` and `a/b.mjs` key alike; null when it has none. */
function recurrenceFile(finding) {
  const file = resolveFindingFile(finding);
  return file ? path.posix.normalize(file.replaceAll("\\", "/")) : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** Backticked identifiers in a summary, in order of appearance, without repeats. */
export function backtickedIdentifiers(summary) {
  if (typeof summary !== "string") return [];
  return [...new Set([...summary.matchAll(BACKTICKED)].map((m) => m[1]))];
}

/**
 * Whether `source` (the content of `file` at the current head) defines `symbol`:
 * a `function`, `class`, `const`, `let` or `var` declaration in a source file,
 * or a `<!-- rule: <ID> -->` marker in a markdown file.
 */
export function definesSymbol(file, source, symbol) {
  if (typeof source !== "string") return false;
  const name = escapeRegExp(symbol);
  if (/\.md$/i.test(file)) return new RegExp(`<!--\\s*rule:\\s*${name}\\s*-->`).test(source);
  return new RegExp(`\\b(?:function\\*?|class|const|let|var)\\s+${name}(?![\\w$])`).test(source);
}

/**
 * Every surface key of a finding: one per backticked summary identifier the
 * file defines, so keying does not depend on mention order. Empty when the
 * summary names no defined symbol (such a finding is not counted).
 * @param {object} finding
 * @param {Map<string, string>} sources file path -> content at the current head
 * @returns {Array<{ file: string, symbol: string }>}
 */
export function surfaceKeysOf(finding, sources) {
  const file = recurrenceFile(finding);
  if (!file) return [];
  const source = sources.get(file);
  return backtickedIdentifiers(finding?.summary)
    .filter((id) => definesSymbol(file, source, id))
    .map((symbol) => ({ file, symbol }));
}

/** The first surface key of a finding, or null when it has none. */
export function surfaceKeyOf(finding, sources) {
  return surfaceKeysOf(finding, sources)[0] ?? null;
}

const keyString = (key) => `${key.file}\u0000${key.symbol}`;

/** Every file a recurrence check needs to read: the act items' and the prior act items' files. */
export function recurrenceFiles(actFindings, priorLogs) {
  const files = new Set();
  for (const f of actFindings) if (recurrenceFile(f)) files.add(recurrenceFile(f));
  for (const log of priorLogs) {
    for (const f of Array.isArray(log?.findings) ? log.findings : []) {
      if (f?.judgeDisposition === "act" && recurrenceFile(f)) files.add(recurrenceFile(f));
    }
  }
  return [...files];
}

/**
 * Find the act items whose surface appears in act items of at least
 * ESCALATION_THRESHOLD counted rounds. A prior round counts only when its
 * recorded `specAuthority.specDigest` equals `specDigest`; a ledger written
 * before spec authority existed has none and never counts.
 *
 * @param {object} input
 * @param {object[]} input.actFindings the current round's judge act findings
 * @param {object[]} input.priorLogs closed prior-round ledgers of the same gate and PR
 * @param {string} input.specDigest the current round's spec digest
 * @param {string} input.headSha the current round's head
 * @param {Map<string, string>} input.sources file path -> content at the current head
 * @returns {Array<{ index: number, surfaceKey: { file: string, symbol: string }, rounds: number, heads: string[] }>}
 *   `index` is the position in `actFindings`
 */
export function findEscalations({ actFindings, priorLogs, specDigest, headSha, sources }) {
  const counted = priorLogs.filter((log) => typeof specDigest === "string" && log?.specAuthority?.specDigest === specDigest);
  const priorKeys = counted.map((log) => ({
    head: log.headSha,
    keys: new Set(
      (Array.isArray(log.findings) ? log.findings : [])
        .filter((f) => f?.judgeDisposition === "act")
        .flatMap((f) => surfaceKeysOf(f, sources))
        .map(keyString),
    ),
  }));
  const escalations = [];
  actFindings.forEach((finding, index) => {
    // The key with the most counted rounds wins; ties keep mention order.
    let best = null;
    for (const surfaceKey of surfaceKeysOf(finding, sources)) {
      const matching = priorKeys.filter((round) => round.keys.has(keyString(surfaceKey)));
      if (!best || matching.length > best.matching.length) best = { surfaceKey, matching };
    }
    if (best && best.matching.length + 1 >= ESCALATION_THRESHOLD) {
      escalations.push({ index, surfaceKey: best.surfaceKey, rounds: best.matching.length + 1, heads: [...best.matching.map((r) => r.head), headSha] });
    }
  });
  return escalations;
}
