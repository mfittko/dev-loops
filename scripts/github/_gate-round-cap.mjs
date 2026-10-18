// Judge-keyed round cap for draft_gate (gates.draft.maxReviewRounds). One
// completed round is one durable draft_gate ledger of this PR; the round being
// posted counts. The cap composes through composeCheckpointVerdict in
// upsert-checkpoint-verdict.mjs. See skills/docs/gate-review-sub-loop-contract.md.
import { resolveGateConfig } from "@dev-loops/core/config";
import { hasLocatableShape, isOpenActItem, normalizeSeverity, VALID_SEVERITIES } from "@dev-loops/core/loop/gate-fanin";
import { fingerprintFinding } from "./_gate-finding-surface.mjs";
import { readClosedPriorRoundLogs } from "./write-gate-context.mjs";

const isHighOrMedium = (f) => ["high", "medium"].includes(normalizeSeverity(f.severity));
const itemText = (f) => `[${normalizeSeverity(f.severity)}] ${typeof f.summary === "string" ? f.summary.trim() : "(no summary)"}`;

function actFingerprint(finding) {
  try {
    return fingerprintFinding(finding);
  } catch {
    return null;
  }
}

/** The act fingerprints of closed prior rounds (null slots are unreadable ledgers). */
export function priorActFingerprints(priorLogs) {
  return new Set(
    priorLogs.flatMap((log) => (Array.isArray(log?.findings) ? log.findings : []).filter(isOpenActItem).map(actFingerprint)).filter(Boolean),
  );
}

/**
 * The cap, the round being posted and the act fingerprints of closed prior
 * rounds. Only draft_gate is capped; cap 0 disables it.
 * @returns {Promise<{ cap: number, round: number, pastCap: boolean, priorActFingerprints: Set<string> }>}
 */
export async function readRoundCapState({ repo, pr, gate, headSha, tmpRoot }, config, repoRoot) {
  const priorLogs = await readClosedPriorRoundLogs({ repo, pr, gate, headSha, tmpRoot }, { repoRoot, keepUnreadable: true });
  const cap = gate === "draft_gate" ? resolveGateConfig(config, "draft").maxReviewRounds : 0;
  const round = priorLogs.length + 1;
  return { cap, round, pastCap: cap > 0 && round >= cap, priorActFingerprints: priorActFingerprints(priorLogs) };
}

/** Keep `resurfaces` only on an act item whose fingerprint is a closed prior round's act fingerprint. Mutates. */
export function keepKnownResurfaces(findings, priorActFingerprints) {
  for (const f of findings) {
    if (f.resurfaces !== undefined && !(f.judgeDisposition === "act" && priorActFingerprints.has(f.resurfaces))) delete f.resurfaces;
  }
  return findings;
}

/** Stamp `capClosed` on a past-cap judge defer or reject. A locatable question stays open. Mutates. */
export function stampCapClosed(findings, { cap, round, pastCap }) {
  if (!pastCap) return findings;
  for (const f of findings) {
    const judgeDisposition = f.judgeDisposition;
    if (judgeDisposition !== "defer" && judgeDisposition !== "reject") continue;
    if (normalizeSeverity(f.severity) === "question" && hasLocatableShape(f)) continue;
    f.capClosed = { judgeDisposition, severity: normalizeSeverity(f.severity), round, cap };
  }
  return findings;
}

/**
 * Round-cap decision over one round's findings. `runNextRound` is the
 * convergence rule: a round with a new act item, or below the cap with an open
 * re-surfaced high or medium act, runs another automatic round. Otherwise every
 * open act item blocks. Past the cap, a reviewer high or medium that the judge
 * defers or rejects, a missing disposition and an unknown severity also block.
 * @returns {{ runNextRound: boolean, blockers: Array<{ kind: string, item: string }> }}
 */
export function evaluateRoundCap(findings, { cap, pastCap }) {
  const open = findings.filter(isOpenActItem);
  if (cap === 0) return { runNextRound: open.length > 0, blockers: [] };
  const runNextRound = !pastCap && open.some((f) => !f.resurfaces || isHighOrMedium(f));
  const blockers = runNextRound ? [] : open.map((f) => ({ kind: "round_cap_reached", item: itemText(f) }));
  if (pastCap) {
    for (const f of findings) {
      const closed = f.judgeDisposition === "defer" || f.judgeDisposition === "reject";
      const disagrees = !f.judgeDisposition || !VALID_SEVERITIES.has(normalizeSeverity(f.severity)) || (closed && isHighOrMedium(f));
      if (disagrees && !isOpenActItem(f)) blockers.push({ kind: "severity_disagreement", item: itemText(f) });
    }
  }
  return { runNextRound, blockers };
}
