import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { readClosedPriorRoundLogs, readGateContext } from "./write-gate-context.mjs";

export const ROUND_CAUSES = Object.freeze(["first", "developer_findings", "system_rerun", "base_refresh", "body_only"]);

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** Pure cause rules, first match wins. `baseOnly` is read only for a head move. */
export function deriveRoundCause({ prior, headSha, prBodySha256, baseOnly }) {
  if (!prior) return "first";
  if (String(prior.headSha).toLowerCase() === String(headSha).toLowerCase()) {
    const a = prior.prBodySha256;
    return DIGEST_RE.test(a ?? "") && DIGEST_RE.test(prBodySha256 ?? "") && a !== prBodySha256 ? "body_only" : "system_rerun";
  }
  return baseOnly ? "base_refresh" : "developer_findings";
}

/**
 * Reads the prior round the same way the round count does, probes git only for a head move, then derives the cause.
 * Fail-safe: any read or git error means no base-only merge; the cause never refuses a write.
 */
export async function resolveRoundCause(options, { repoRoot, baseOnlyMerge = isBaseOnlyMergeSince }) {
  const { repo, pr, gate, headSha, tmpRoot, roundIdentity, prBodySha256 } = options;
  const priors = await readClosedPriorRoundLogs({ repo, pr, gate, headSha, tmpRoot, roundIdentity }, { repoRoot, includeRetainedCurrentHead: true, includeLiveCurrentHead: true });
  const prior = priors.at(-1);
  let baseOnly = false;
  if (prior && String(prior.headSha).toLowerCase() !== String(headSha).toLowerCase()) {
    try {
      const context = await readGateContext({ repo, pr, gate, headSha, tmpRoot: options.contextTmpRoot }, { repoRoot });
      const base = context?.baseFreshness?.base;
      if (typeof base === "string" && base) baseOnly = (await baseOnlyMerge({ fromHead: prior.headSha, head: headSha, mainRef: `origin/${base}`, repoRoot })) === true;
    } catch {
      baseOnly = false;
    }
  }
  return deriveRoundCause({ prior, headSha, prBodySha256, baseOnly });
}
