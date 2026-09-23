/**
 * finding-cluster.mjs — deterministic fan-in finding clustering for the
 * gate-review sub-loop. Collapses duplicate findings (the SAME root cause
 * reported by more than one reviewer/angle) into one cluster so the judge's
 * relevance disposition and the fixer's act list both reason about root
 * causes, not raw finding count.
 *
 * Pure and offline: no file reads, no network, no state held across calls.
 * Every function deep-clones before enriching and never mutates a caller's
 * array/objects.
 */

import { normalizeSeverity, resolveFindingFile } from "./gate-fanin.mjs";

// NUL separates the three key components so a value inside one component
// (e.g. a recommendation that happens to contain a colon or digits matching
// another component) can never be misread as spanning a boundary.
const ROOT_CAUSE_KEY_SEPARATOR = "\u0000";

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The canonical root-cause key for a finding: `(reviewed head, primary
 * location "file:line", normalized remediation target)`. A finding missing
 * ANY of the three components is UNKEYABLE and returns null — it is never
 * grouped with another finding, keyable or not.
 *
 * @param {{file?: unknown, files?: unknown, line?: unknown, recommendation?: unknown}} finding
 * @param {{headSha?: unknown}} [options] — the round's reviewed head; a
 *   finding never carries its own head, so this is always caller-supplied.
 * @returns {string|null}
 */
export function computeRootCauseKey(finding, { headSha } = {}) {
  if (!finding || typeof finding !== "object") return null;
  if (!isNonEmptyString(headSha)) return null;
  const file = resolveFindingFile(finding);
  if (!isNonEmptyString(file)) return null;
  const line = finding.line;
  if (!Number.isInteger(line) || line < 1) return null;
  const recommendation = finding.recommendation;
  if (!isNonEmptyString(recommendation)) return null;

  const normalizedRecommendation = recommendation.trim().toLowerCase().replace(/\s+/g, " ");
  return [headSha.trim(), `${file}:${line}`, normalizedRecommendation].join(ROOT_CAUSE_KEY_SEPARATOR);
}

/**
 * Group findings by EXACT root-cause key match. Every UNKEYABLE finding
 * (see {@link computeRootCauseKey}) is its own singleton cluster, never
 * grouped with another unkeyable finding. Deterministic: clusters are
 * ordered by `representativeIndex` ascending (first appearance), and a
 * cluster's `memberIndices` are ascending.
 *
 * FAIL-OPEN: a non-array `findings`, a missing/empty/non-string `headSha`,
 * or any internal error returns `{ ok: false, reason, clusters }` where
 * `clusters` is one singleton (`keyable: false`) per ORIGINAL finding in
 * input order — so a caller passes every original finding through to the
 * judge unchanged. Never throws.
 *
 * @param {unknown} findings
 * @param {{headSha?: unknown}} [options]
 * @returns {{ ok: true, clusters: Array<{key: string|null, keyable: boolean, memberIndices: number[], representativeIndex: number}> }
 *   | { ok: false, reason: string, clusters: Array<{key: null, keyable: false, memberIndices: number[], representativeIndex: number}> }}
 */
export function clusterFindings(findings, options = {}) {
  try {
    if (!Array.isArray(findings)) {
      throw new Error("clusterFindings requires findings to be an array");
    }
    if (!isNonEmptyString(options?.headSha)) {
      throw new Error("clusterFindings requires a non-empty options.headSha");
    }
    const headSha = options.headSha;
    // A Map preserves insertion order, and every finding is visited index
    // ascending below, so the FIRST index to create a cluster entry is
    // always that cluster's smallest (representative) member — clusters is
    // therefore already representativeIndex-ascending with no extra sort.
    const byKey = new Map();
    const clusters = [];
    findings.forEach((finding, index) => {
      const key = computeRootCauseKey(finding, { headSha });
      if (key === null) {
        clusters.push({ key: null, keyable: false, memberIndices: [index], representativeIndex: index });
        return;
      }
      let cluster = byKey.get(key);
      if (!cluster) {
        cluster = { key, keyable: true, memberIndices: [], representativeIndex: index };
        byKey.set(key, cluster);
        clusters.push(cluster);
      }
      cluster.memberIndices.push(index);
    });
    return { ok: true, clusters };
  } catch (err) {
    const list = Array.isArray(findings) ? findings : [];
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      clusters: list.map((_finding, index) => ({ key: null, keyable: false, memberIndices: [index], representativeIndex: index })),
    };
  }
}

/**
 * Reconstruct the clusters array from findings a producer already stamped
 * with `clusterId` — the LOSSLESS identity consolidate-fanin.mjs computes
 * (via {@link clusterFindings}) on pre-truncation finding text and stamps
 * onto each ledger finding as `finding.clusterId = cluster.representativeIndex`.
 * A consumer reading the ledger back (e.g. judge-pass.mjs) must group by this
 * stamp rather than re-running {@link clusterFindings} on the ledger's own
 * `recommendation`/`file` text, which the ledger pipeline TRUNCATES after
 * clustering — re-deriving from truncated text can merge findings that only
 * share a long truncated prefix, silently discarding the lossless grouping.
 *
 * Every finding must carry an integer `clusterId` (fails closed otherwise —
 * a caller unsure every finding is stamped should fall back to
 * {@link clusterFindings} instead of calling this). Deterministic: clusters
 * are ordered by `representativeIndex` ascending, and each cluster's
 * `memberIndices` are ascending (findings are visited index-ascending).
 *
 * @param {Array<{clusterId?: unknown}>} findings
 * @returns {Array<{key: null, keyable: true, memberIndices: number[], representativeIndex: number}>}
 */
export function clustersFromStampedIds(findings) {
  if (!Array.isArray(findings)) {
    throw new TypeError("clustersFromStampedIds requires findings to be an array");
  }
  const byClusterId = new Map();
  findings.forEach((finding, index) => {
    const clusterId = finding?.clusterId;
    if (!Number.isInteger(clusterId)) {
      throw new TypeError(`clustersFromStampedIds requires every finding to carry an integer clusterId (index ${index} does not)`);
    }
    let cluster = byClusterId.get(clusterId);
    if (!cluster) {
      cluster = { key: null, keyable: true, memberIndices: [], representativeIndex: clusterId };
      byClusterId.set(clusterId, cluster);
    }
    cluster.memberIndices.push(index);
  });
  return [...byClusterId.values()].sort((a, b) => a.representativeIndex - b.representativeIndex);
}

/**
 * Project every multi-member cluster's REPRESENTATIVE judge disposition
 * (`judgeDisposition`/`judgeRationale`/`judgeCriterion`/`followUpDraft`) onto
 * every member of that cluster — one judge decision per root cause, applied
 * to every finding reporting it. Singleton clusters are unchanged. Pure:
 * deep-clones before enriching, never mutates `enrichedFindings`.
 *
 * Fails closed (throws) when a cluster is malformed or its
 * `memberIndices`/`representativeIndex` reference an out-of-range position.
 *
 * @param {Array<object>} enrichedFindings
 * @param {Array<{memberIndices: number[], representativeIndex: number}>} clusters
 * @returns {Array<object>} a new, deep-cloned array.
 */
export function projectClusterDisposition(enrichedFindings, clusters) {
  if (!Array.isArray(enrichedFindings)) {
    throw new TypeError("projectClusterDisposition requires enrichedFindings to be an array");
  }
  if (!Array.isArray(clusters)) {
    throw new TypeError("projectClusterDisposition requires clusters to be an array");
  }
  const result = enrichedFindings.map((finding) => structuredClone(finding));
  for (const cluster of clusters) {
    if (!cluster || !Array.isArray(cluster.memberIndices) || !Number.isInteger(cluster.representativeIndex)) {
      throw new TypeError("projectClusterDisposition requires every cluster to carry memberIndices[] and a representativeIndex");
    }
    if (cluster.representativeIndex < 0 || cluster.representativeIndex >= result.length) {
      throw new RangeError(`projectClusterDisposition: cluster representativeIndex ${cluster.representativeIndex} is out of range (${result.length} findings)`);
    }
    for (const memberIndex of cluster.memberIndices) {
      if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= result.length) {
        throw new RangeError(`projectClusterDisposition: cluster memberIndices references out-of-range index ${memberIndex} (${result.length} findings)`);
      }
    }
    if (cluster.memberIndices.length === 0) {
      throw new RangeError("projectClusterDisposition: a cluster must have at least one member (memberIndices is empty)");
    }
    if (!cluster.memberIndices.includes(cluster.representativeIndex)) {
      throw new RangeError(
        `projectClusterDisposition: cluster representativeIndex ${cluster.representativeIndex} is not one of its own memberIndices [${cluster.memberIndices.join(", ")}]`
      );
    }
    if (cluster.memberIndices.length <= 1) continue; // singleton: shape validated above, nothing to project.
    const representative = result[cluster.representativeIndex];
    for (const memberIndex of cluster.memberIndices) {
      const target = result[memberIndex];
      target.judgeDisposition = representative.judgeDisposition;
      target.judgeRationale = representative.judgeRationale;
      if (representative.judgeCriterion !== undefined) target.judgeCriterion = representative.judgeCriterion;
      else delete target.judgeCriterion;
      if (representative.followUpDraft !== undefined) target.followUpDraft = representative.followUpDraft;
      else delete target.followUpDraft;
    }
  }
  return result;
}

/**
 * Reduce an ACT list to at most one finding per acted cluster — the fixer's
 * one-remediation-per-root-cause input. `allFindings` is the SAME array
 * `clusters` was computed against; each act finding is matched back to its
 * original position in it by reference, then to that position's cluster.
 *
 * A cluster's `representativeIndex` is by construction its smallest member
 * index (see {@link clusterFindings}), so — given `actFindings` preserves
 * the round's original relative order, which every producer in this
 * pipeline does — the first member of a cluster encountered here is always
 * either the representative itself, or, when the representative was not
 * itself act-disposed, the earliest-index act member of that cluster: the
 * exact preference rule this function implements, with no extra bookkeeping.
 *
 * A finding whose cluster cannot be resolved (absent from `allFindings`, or
 * no cluster covers its position) passes through unchanged — fail-open,
 * never silently dropped.
 *
 * @param {Array<object>} actFindings
 * @param {Array<{memberIndices: number[], representativeIndex: number}>} clusters
 * @param {Array<object>} allFindings
 * @returns {Array<object>}
 */
export function dedupeActListByCluster(actFindings, clusters, allFindings) {
  if (!Array.isArray(actFindings)) {
    throw new TypeError("dedupeActListByCluster requires actFindings to be an array");
  }
  const clusterList = Array.isArray(clusters) ? clusters : [];
  const findingsList = Array.isArray(allFindings) ? allFindings : [];

  const representativeIndexByPosition = new Map();
  for (const cluster of clusterList) {
    if (!cluster || !Array.isArray(cluster.memberIndices) || !Number.isInteger(cluster.representativeIndex)) continue;
    for (const memberIndex of cluster.memberIndices) {
      representativeIndexByPosition.set(memberIndex, cluster.representativeIndex);
    }
  }

  const seenClusters = new Set();
  const kept = [];
  for (const finding of actFindings) {
    const position = findingsList.indexOf(finding);
    const representativeIndex = position === -1 ? undefined : representativeIndexByPosition.get(position);
    if (representativeIndex === undefined) {
      kept.push(finding); // Fail-open: unresolvable membership always passes through.
      continue;
    }
    if (seenClusters.has(representativeIndex)) continue;
    seenClusters.add(representativeIndex);
    kept.push(finding);
  }
  return kept;
}

/**
 * A "clean" ledger severity verdict means no finding at a BLOCKING severity
 * remains open. It is invalid only when a finding at a blocking severity was
 * acted on — that is unresolved blocking work, so the round cannot be clean.
 * The ledger's severity verdict may stay clean with NON-BLOCKING act findings
 * (a medium in the fix window, a low the fixer triages). The posted review
 * verdict is composed with the act list (ADR 0089), so such a round posts
 * findings_present until its act items are fixed.
 *
 * Throws a clear Error on `overallVerdict === "clean"` with any act finding at a
 * blocking severity; returns `overallVerdict` unchanged otherwise.
 *
 * @param {unknown} overallVerdict
 * @param {Array<{severity?: unknown}>} actFindings — the round's act-disposed findings.
 * @param {string[]} [blockingSeverities] — the gate's blocking severities (default ["high"]).
 * @returns {unknown} `overallVerdict`, unchanged.
 */
export function assertCleanImpliesNoBlockingAct(overallVerdict, actFindings, blockingSeverities) {
  if (!Array.isArray(actFindings)) {
    throw new TypeError("assertCleanImpliesNoBlockingAct requires actFindings to be an array");
  }
  if (overallVerdict !== "clean") return overallVerdict;
  const blocking = new Set(
    (Array.isArray(blockingSeverities) && blockingSeverities.length > 0 ? blockingSeverities : ["high"]).map((s) =>
      normalizeSeverity(s),
    ),
  );
  const offending = actFindings.filter((f) => blocking.has(normalizeSeverity(f?.severity)));
  if (offending.length > 0) {
    const severities = [...new Set(offending.map((f) => normalizeSeverity(f?.severity)))].join(", ");
    throw new Error(
      `clean verdict is invalid with ${offending.length} acted finding(s) at a blocking severity (${severities}): ` +
        `a blocking-severity finding acted on this round cannot be clean. The ledger's severity verdict may be clean with ` +
        `non-blocking act findings; the posted review verdict is composed with the act list (ADR 0089).`,
    );
  }
  return overallVerdict;
}
