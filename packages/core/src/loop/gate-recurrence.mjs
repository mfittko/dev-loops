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
import { resolveFindingFile } from "./gate-fanin.mjs";

/** Act items on one surface in this many counted rounds escalate. */
export const ESCALATION_THRESHOLD = 3;

const BACKTICKED = /`([A-Za-z_$][\w$-]*)`/g;

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
 * The surface key of a finding, or null when its summary names no symbol the
 * file defines (such a finding is not counted).
 * @param {object} finding
 * @param {Map<string, string>} sources file path -> content at the current head
 * @returns {{ file: string, symbol: string }|null}
 */
export function surfaceKeyOf(finding, sources) {
  const file = resolveFindingFile(finding);
  if (!file) return null;
  const source = sources.get(file);
  const symbol = backtickedIdentifiers(finding?.summary).find((id) => definesSymbol(file, source, id));
  return symbol ? { file, symbol } : null;
}

const keyString = (key) => `${key.file}\u0000${key.symbol}`;

/** Every file a recurrence check needs to read: the act items' and the prior act items' files. */
export function recurrenceFiles(actFindings, priorLogs) {
  const files = new Set();
  for (const f of actFindings) if (resolveFindingFile(f)) files.add(resolveFindingFile(f));
  for (const log of priorLogs) {
    for (const f of Array.isArray(log?.findings) ? log.findings : []) {
      if (f?.judgeDisposition === "act" && resolveFindingFile(f)) files.add(resolveFindingFile(f));
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
        .map((f) => surfaceKeyOf(f, sources))
        .filter(Boolean)
        .map(keyString),
    ),
  }));
  const escalations = [];
  actFindings.forEach((finding, index) => {
    const surfaceKey = surfaceKeyOf(finding, sources);
    if (!surfaceKey) return;
    const matching = priorKeys.filter((round) => round.keys.has(keyString(surfaceKey)));
    if (matching.length + 1 >= ESCALATION_THRESHOLD) {
      escalations.push({ index, surfaceKey, rounds: matching.length + 1, heads: [...matching.map((r) => r.head), headSha] });
    }
  });
  return escalations;
}
