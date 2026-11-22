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
 * `sameHeadRerun` ("system_rerun" or "body_only") is a retirement or blocked-ledger record at this head that no closed prior ledger shows.
 */
export function deriveRoundCause({ prior, headSha, prBodySha256, baseOnly, sameHeadRerun }) {
  if (sameHeadRerun) return sameHeadRerun;
  if (!prior) return "first";
  if (String(prior.headSha).toLowerCase() === String(headSha).toLowerCase()) {
    const a = prior.prBodySha256;
    return DIGEST_RE.test(a ?? "") && DIGEST_RE.test(prBodySha256 ?? "") && a !== prBodySha256 ? "body_only" : "system_rerun";
  }
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
  let live = null;
  try {
    const liveFile = path.resolve(repoRoot, buildLogPath({ repo, pr, gate, headSha, tmpRoot: root }));
    live = JSON.parse(await readSealed(liveFile));
    if (!live || typeof live !== "object") live = null;
  } catch (err) {
    if (err?.code === OUT_OF_BAND_WRITE) skipped(path.basename(buildLogPath({ repo, pr, gate, headSha, tmpRoot: root })));
  }
  const ownLive = live && String(live.repo).toLowerCase() === String(repo).toLowerCase() && String(live.gate) === gate && Number(live.pr) === Number(pr) && String(live.headSha).toLowerCase() === head;
  if (ownLive && live.roundIdentity?.completed === true && isInRoundRewrite(live, roundIdentity) && ROUND_CAUSES.includes(live.roundCause)) return { roundCause: live.roundCause, warnings };

  let sameHeadRerun;
  if (ownLive && live.verdict === "blocked") sameHeadRerun = "system_rerun";
  try {
    const retiredRoot = path.resolve(repoRoot, root);
    if (!sameHeadRerun && findRetirementAfter(retiredRoot, gate, head, 0) !== null) sameHeadRerun = "system_rerun";
    if (!sameHeadRerun && findRetirementAfter(retiredRoot, gate, head, 0, ANY_SCOPE) !== null) sameHeadRerun = "body_only";
  } catch { /* an unreadable retirement record is no evidence */ }

  const priors = await readClosedPriorRoundLogs({ repo, pr, gate, headSha, tmpRoot, roundIdentity }, { repoRoot, includeRetainedCurrentHead: true, includeLiveCurrentHead: true, onOutOfBand: skipped });
  const prior = priors.at(-1);
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
