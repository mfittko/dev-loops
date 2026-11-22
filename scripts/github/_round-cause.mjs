import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
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

async function readLedger(file, warn) {
  try {
    const log = JSON.parse(await readSealed(file));
    return log && typeof log === "object" ? log : null;
  } catch (err) {
    if (err?.code === OUT_OF_BAND_WRITE) warn(`roundCause telemetry skipped ${path.basename(file)}: ${OUT_OF_BAND_WRITE}`);
    return null;
  }
}

const isOwnLedger = (log, { repo, gate, pr, head }) => Boolean(log) && String(log.repo).toLowerCase() === String(repo).toLowerCase() && String(log.gate) === gate && Number(log.pr) === Number(pr) && String(log.headSha).toLowerCase() === head;
// A record without a finite time counts only when no bound applies.
const inWindow = (ms, sinceMs, untilMs) => (Number.isFinite(ms) ? ms >= sinceMs && ms <= untilMs : sinceMs <= 0 && untilMs === Infinity);

/**
 * The same-head rerun evidence the writer and the round-causes report share: "system_rerun" for a finished blocked round or a whole-round retirement at this head,
 * "body_only" for a scoped retirement, else null. Records count only when their `loggedAt` or `retiredAt` lies in `[sinceMs, untilMs]` (a retirement always needs a finite `retiredAt`;
 * a blocked ledger needs a finite `loggedAt` when a bound applies). A blocked ledger is bounded by `blockedSinceMs`, which defaults to `sinceMs`.
 * Telemetry only: a sealed-ledger mismatch, an unreadable retirement record or an unreadable retirement directory is skipped and named through `warn`, and a valid sibling still counts. Gate readers keep `findRetirementAfter`, which fails closed.
 */
export async function findSameHeadRerun({ repoRoot, repo, pr, gate, headSha, tmpRoot, extraRoots = [], incoming, sinceMs = 0, blockedSinceMs = sinceMs, untilMs = Infinity, warn }) {
  const head = String(headSha).toLowerCase();
  const liveFile = path.resolve(repoRoot, buildLogPath({ repo, pr, gate, headSha, tmpRoot }));
  // A finished blocked round at this head, live or retained by a later write. An unfinished blocked write is an in-round rewrite, never an earlier round.
  const stem = path.basename(liveFile, ".json");
  const dir = path.dirname(liveFile);
  let retained = [];
  try { retained = (await readdir(dir)).filter((n) => n.startsWith(`${stem}.round-`) && n.endsWith(".json")).sort(); } catch { /* no ledger directory */ }
  const sameHead = [await readLedger(liveFile, warn), ...(await Promise.all(retained.map((n) => readLedger(path.join(dir, n), warn))))];
  if (sameHead.some((log) => isOwnLedger(log, { repo, gate, pr, head }) && log.verdict === "blocked" && !isInRoundRewrite(log, incoming) && inWindow(Date.parse(log.loggedAt), blockedSinceMs, untilMs))) return "system_rerun";
  // The builder, the emitter and retire-gate-round write retirements under the checkout they ran in, so scan the ledger root, this checkout's tmp and the extra roots.
  let kind = null;
  for (const root of [...new Set([path.resolve(repoRoot, tmpRoot), path.resolve(repoRoot, "tmp"), ...extraRoots.map((r) => path.resolve(repoRoot, r))])].sort()) {
    const retiredRoot = path.join(root, "retired-gate-rounds", head);
    let rounds = [];
    try {
      rounds = (await readdir(retiredRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (err) {
      if (err?.code !== "ENOENT") warn(`roundCause telemetry skipped retirement directory ${retiredRoot}: unreadable`);
      continue;
    }
    for (const round of rounds) {
      const file = path.join(retiredRoot, round, "retirement.json");
      let record;
      try {
        record = JSON.parse(await readFile(file, "utf8"));
      } catch (err) {
        if (err?.code !== "ENOENT") warn(`roundCause telemetry skipped retirement record ${file}: unreadable`);
        continue;
      }
      if (record?.gate !== gate || !inWindow(Date.parse(record.retiredAt), sinceMs, untilMs) || !Number.isFinite(Date.parse(record.retiredAt))) continue;
      kind = Array.isArray(record.scopes) ? (kind ?? "body_only") : "system_rerun";
    }
  }
  return kind;
}

/**
 * Reads the prior round the same way the round count does, probes git only for a head move, then derives the cause. Returns `{ roundCause, warnings }`.
 * Telemetry only, so it never refuses a write: a git or gate-context read error means no base-only merge, and a prior ledger with a sealed-ledger mismatch is excluded
 * (never trusted) and named in `warnings`, as is an unreadable retirement record or directory. The cap, retention and carry-forward readers stay fail-closed.
 * A completed live ledger of the same round keeps its stamped cause, because a later head's ledger must not re-derive it on a repeated write.
 */
export async function resolveRoundCause(options, { repoRoot, baseOnlyMerge = isBaseOnlyMergeSince }) {
  const { repo, pr, gate, headSha, tmpRoot, roundIdentity, prBodySha256 } = options;
  const warnings = [];
  const skipped = (message) => { if (!warnings.includes(message)) warnings.push(message); };
  const head = String(headSha).toLowerCase();
  const root = tmpRoot || resolveGateArtifactTmpRoot(repoRoot);
  const liveFile = path.resolve(repoRoot, buildLogPath({ repo, pr, gate, headSha, tmpRoot: root }));
  const live = await readLedger(liveFile, skipped);
  const ownLive = isOwnLedger(live, { repo, gate, pr, head });
  if (ownLive && live.roundIdentity?.completed === true && isInRoundRewrite(live, roundIdentity) && ROUND_CAUSES.includes(live.roundCause)) return { roundCause: live.roundCause, warnings };

  const priors = await readClosedPriorRoundLogs({ repo, pr, gate, headSha, tmpRoot, roundIdentity }, { repoRoot, includeRetainedCurrentHead: true, includeLiveCurrentHead: true, onOutOfBand: (name) => skipped(`roundCause telemetry skipped ${name}: ${OUT_OF_BAND_WRITE}`) });
  const prior = priors.at(-1);

  // A same-head record only matters before the no-prior and head-move rules; a prior round at this head keeps the digest rule.
  const sameHeadRerun = !prior || String(prior.headSha).toLowerCase() !== head
    ? await findSameHeadRerun({ repoRoot, repo, pr, gate, headSha, tmpRoot: root, extraRoots: options.contextTmpRoot ? [options.contextTmpRoot] : [], incoming: roundIdentity, sinceMs: Date.parse(prior?.loggedAt) || 0, blockedSinceMs: 0, warn: skipped })
    : undefined;
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
