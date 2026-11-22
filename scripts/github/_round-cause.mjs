import { readdir } from "node:fs/promises";
import path from "node:path";
import { ANY_SCOPE, findRetirementAfter } from "@dev-loops/core/loop/gate-round-retirement";
import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { buildLogPath } from "./_gate-artifact-paths.mjs";
import { OUT_OF_BAND_WRITE, readSealed } from "./_gate-artifact-seal.mjs";
import { isInRoundRewrite, readClosedPriorRoundLogs, readGateContext } from "./write-gate-context.mjs";

export const ROUND_CAUSES = Object.freeze(["first", "developer_findings", "system_rerun", "base_refresh", "body_only", "other_head_move"]);

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Pure cause rules, first match wins. `baseOnly` is read only for a head move.
 * `sameHeadRerun` ("system_rerun" or "body_only") is a retirement or blocked-ledger record at this head; it applies before the no-prior and head-move rules only, so a prior round at the same head keeps the digest rule.
 */
export function deriveRoundCause({ prior, headSha, prBodySha256, baseOnly, sameHeadRerun }) {
  if (prior && String(prior.headSha).toLowerCase() === String(headSha).toLowerCase()) {
    const a = prior.prBodySha256;
    return DIGEST_RE.test(a ?? "") && DIGEST_RE.test(prBodySha256 ?? "") && a !== prBodySha256 ? "body_only" : "system_rerun";
  }
  if (sameHeadRerun) return sameHeadRerun;
  if (!prior) return "first";
  if (baseOnly) return "base_refresh";
  return Array.isArray(prior.findings) && prior.findings.some((f) => f?.judgeDisposition === "act") ? "developer_findings" : "other_head_move";
}

/**
 * Reads the prior round the same way the round count does, probes git only for a head move, then derives the cause. Returns `{ roundCause, warnings }`.
 * Telemetry only, so it never refuses a write: a git or gate-context read error means no base-only merge, and a prior ledger with a sealed-ledger mismatch is excluded
 * (never trusted) and named in `warnings`. The cap, retention and carry-forward readers stay fail-closed.
 * A completed live ledger of the same round keeps its stamped cause, because a later head's ledger must not re-derive it on a repeated write.
 */
export async function resolveRoundCause(options, { repoRoot, baseOnlyMerge = isBaseOnlyMergeSince }) {
  const { repo, pr, gate, headSha, tmpRoot, roundIdentity, prBodySha256 } = options;
  const warnings = [];
  const skipped = (name) => warnings.push(`roundCause telemetry skipped ${name}: ${OUT_OF_BAND_WRITE}`);
  const head = String(headSha).toLowerCase();
  const root = tmpRoot || resolveGateArtifactTmpRoot(repoRoot);
  const liveFile = path.resolve(repoRoot, buildLogPath({ repo, pr, gate, headSha, tmpRoot: root }));
  const readLedger = async (file) => {
    try {
      const log = JSON.parse(await readSealed(file));
      return log && typeof log === "object" ? log : null;
    } catch (err) {
      if (err?.code === OUT_OF_BAND_WRITE) skipped(path.basename(file));
      return null;
    }
  };
  const live = await readLedger(liveFile);
  const isOwn = (log) => log && String(log.repo).toLowerCase() === String(repo).toLowerCase() && String(log.gate) === gate && Number(log.pr) === Number(pr) && String(log.headSha).toLowerCase() === head;
  const ownLive = isOwn(live);
  if (ownLive && live.roundIdentity?.completed === true && isInRoundRewrite(live, roundIdentity) && ROUND_CAUSES.includes(live.roundCause)) return { roundCause: live.roundCause, warnings };

  const priors = await readClosedPriorRoundLogs({ repo, pr, gate, headSha, tmpRoot, roundIdentity }, { repoRoot, includeRetainedCurrentHead: true, includeLiveCurrentHead: true, onOutOfBand: skipped });
  const prior = priors.at(-1);

  // A same-head record only matters before the no-prior and head-move rules; a prior round at this head keeps the digest rule.
  let sameHeadRerun;
  if (!prior || String(prior.headSha).toLowerCase() !== head) {
    // A finished blocked round at this head, live or retained by a later write. An unfinished blocked write is an in-round rewrite, never an earlier round.
    const stem = path.basename(liveFile, ".json");
    let retained = [];
    try { retained = (await readdir(path.dirname(liveFile))).filter((n) => n.startsWith(`${stem}.round-`) && n.endsWith(".json")); } catch { /* no ledger directory */ }
    const sameHead = [live, ...(await Promise.all(retained.map((n) => readLedger(path.join(path.dirname(liveFile), n)))))];
    if (sameHead.some((log) => isOwn(log) && log.verdict === "blocked" && !isInRoundRewrite(log, roundIdentity))) sameHeadRerun = "system_rerun";
    // The builder, the emitter and retire-gate-round write retirements under the checkout they ran in, so scan the ledger root, this checkout's tmp and the context root.
    const since = Date.parse(prior?.loggedAt) || 0;
    const retirementRoots = new Set([path.resolve(repoRoot, root), path.resolve(repoRoot, "tmp"), ...(options.contextTmpRoot ? [path.resolve(repoRoot, options.contextTmpRoot)] : [])]);
    const retired = (scope) => [...retirementRoots].some((r) => {
      try { return findRetirementAfter(r, gate, head, since, scope) !== null; } catch { return false; /* an unreadable retirement record is no evidence */ }
    });
    if (!sameHeadRerun && retired(null)) sameHeadRerun = "system_rerun";
    if (!sameHeadRerun && retired(ANY_SCOPE)) sameHeadRerun = "body_only";
  }
  let baseOnly = false;
  if (!sameHeadRerun && prior && String(prior.headSha).toLowerCase() !== head) {
    try {
      const context = await readGateContext({ repo, pr, gate, headSha, tmpRoot: options.contextTmpRoot }, { repoRoot });
      const base = context?.baseFreshness?.base;
      if (typeof base === "string" && base) baseOnly = (await baseOnlyMerge({ fromHead: prior.headSha, head: headSha, mainRef: `origin/${base}`, repoRoot })) === true;
    } catch {
      baseOnly = false;
    }
  }
  return { roundCause: deriveRoundCause({ prior, headSha, prBodySha256, baseOnly, sameHeadRerun }), warnings };
}
