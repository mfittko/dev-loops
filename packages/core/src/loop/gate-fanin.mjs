/**
 * gate-fanin.mjs — pure fan-in consolidation + cap/batch planning for the
 * gate-review fork sub-loop (epic #867, Phase 3 / #878).
 *
 * IMPORTANT: this module is PURE. It performs no I/O and never spawns agents.
 * Spawning the per-angle scoped `review` subagents is an agent-orchestrated
 * skill procedure (a node script cannot spawn Claude subagents). This module
 * only consolidates the structured per-angle findings artifacts the fan-out
 * produced, decides the gate verdict, plans the parallel/sequential batching of
 * the fan-out, and maps consolidated findings into the `--findings` JSON shape
 * understood by scripts/github/write-gate-findings-log.mjs.
 *
 * Per-angle review artifact shape (produced by the scoped `review` agent):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present",
 *     findings: [{ severity, file?, line?, summary, recommendation? }]
 *   }
 *
 * Severity vocabulary (mirrors write-gate-findings-log.mjs):
 *   "must-fix" | "worth-fixing-now" | "defer"
 */

const VALID_SEVERITIES = new Set(["must-fix", "worth-fixing-now", "defer"]);
const VALID_VERDICTS = new Set(["clean", "findings_present"]);

/**
 * Canonical fail-closed signal for when a child/agent cannot perform real
 * parallel fan-out (e.g. the harness does not honor the subagent tool at child
 * depth). The flow MUST fail closed with this message and route the gate review
 * to the conductor rather than silently degrading to a single-agent inline
 * review (which requireFanoutProvenance is designed to reject). Documented as a
 * contract in skills/docs/gate-review-sub-loop-contract.md.
 */
export const FANOUT_UNAVAILABLE_MESSAGE = "fan-out unavailable — route to conductor";

/**
 * Build a fail-closed Error carrying the route-to-conductor contract signal.
 * Callers throw this (or check `.routeToConductor === true`) when real fan-out
 * cannot be performed. `detail` is appended for diagnostics but the stable,
 * matchable prefix is always {@link FANOUT_UNAVAILABLE_MESSAGE}.
 *
 * @param {string} [detail] — optional diagnostic suffix (e.g. why fan-out failed)
 * @returns {Error & { routeToConductor: true, code: "FANOUT_UNAVAILABLE" }}
 */
export function fanoutUnavailableError(detail) {
  const suffix = typeof detail === "string" && detail.trim().length > 0 ? ` (${detail.trim()})` : "";
  const error = new Error(`${FANOUT_UNAVAILABLE_MESSAGE}${suffix}`);
  return Object.assign(error, { routeToConductor: /** @type {const} */ (true), code: /** @type {const} */ ("FANOUT_UNAVAILABLE") });
}

/**
 * Count DISTINCT reviewer identities actually recorded in a `perAngle` array.
 * An entry contributes an identity via `reviewer` (preferred) or `dispatchId`;
 * entries carrying neither are not countable reviewers (a bare `{angle}` proves
 * nothing about who reviewed it). Pure.
 *
 * @param {unknown} perAngle
 * @returns {number}
 */
export function countDistinctReviewers(perAngle) {
  if (!Array.isArray(perAngle)) return 0;
  const ids = new Set();
  for (const e of perAngle) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const identity = reviewerIdentity(e);
    if (identity) ids.add(identity.id);
  }
  return ids.size;
}

/**
 * The single identity-selection rule for a perAngle entry: a non-empty
 * `reviewer` wins, else a non-empty `dispatchId`, else no identity. Returns
 * `{ id, label }` (label = which field carried the identity, for error
 * messages) or null. Shared by countDistinctReviewers and
 * fanoutReviewerPairingError so the two can never diverge.
 *
 * @param {object} entry — a perAngle entry
 * @returns {{ id: string, label: "reviewer"|"dispatchId" }|null}
 */
function reviewerIdentity(entry) {
  if (typeof entry.reviewer === "string" && entry.reviewer.trim().length > 0) {
    return { id: entry.reviewer.trim(), label: "reviewer" };
  }
  if (typeof entry.dispatchId === "string" && entry.dispatchId.trim().length > 0) {
    return { id: entry.dispatchId.trim(), label: "dispatchId" };
  }
  return null;
}

/**
 * Validate INTERNAL CONSISTENCY of a fan-out provenance object. Returns an error
 * string when the provenance is malformed or self-inconsistent, or null when it
 * is well-formed and consistent. Shared by the write path (write-gate-findings-log)
 * and the enforcement read path (buildPreMergeGateCheck) so both agree.
 *
 * Consistency rule (documented in skills/docs/gate-review-sub-loop-contract.md):
 *   - `distinctReviewers` must be a non-negative integer.
 *   - `perAngle` must be an array, and non-empty when `distinctReviewers > 0`.
 *   - `distinctReviewers` must be <= the count of DISTINCT reviewer identities
 *     actually recorded in `perAngle` — you cannot claim more reviewers than you
 *     recorded dispatch entries for.
 *
 * HONEST CAVEAT: this makes recorded provenance internally consistent and raises
 * the bar, but the provenance is self-reported (written by the same agent whose
 * independence it claims), so it remains forgeable by a determined single agent.
 * Un-forgeable recording is the Pi-harness bridge (subagent tool at child depth).
 *
 * @param {unknown} prov
 * @returns {string|null}
 */
export function provenanceConsistencyError(prov) {
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) {
    return "provenance must be an object";
  }
  const p = /** @type {Record<string, unknown>} */ (prov);
  if (!Number.isInteger(p.distinctReviewers) || /** @type {number} */ (p.distinctReviewers) < 0) {
    return "provenance.distinctReviewers must be a non-negative integer";
  }
  if (!Array.isArray(p.perAngle)) {
    return "provenance.perAngle must be an array";
  }
  const claimed = /** @type {number} */ (p.distinctReviewers);
  if (claimed > 0 && p.perAngle.length === 0) {
    return "provenance.perAngle must be non-empty when distinctReviewers > 0";
  }
  const recorded = countDistinctReviewers(p.perAngle);
  if (claimed > recorded) {
    return `provenance.distinctReviewers (${claimed}) exceeds distinct recorded reviewer identities (${recorded})`;
  }
  return null;
}

/**
 * Count DISTINCT "fresh" angles in a `perAngle` array — angles reviewed AT
 * THIS head, i.e. entries WITHOUT `carriedFromHead`. A carried angle's clean
 * verdict was reused from a prior head's review (see
 * @dev-loops/core/loop/gate-carry-forward), not freshly reviewed here, so it
 * is exempt from the one-reviewer-per-fresh-angle pairing contract below. Pure.
 *
 * @param {unknown} perAngle
 * @returns {number}
 */
export function countFreshAngles(perAngle) {
  if (!Array.isArray(perAngle)) return 0;
  const angles = new Set();
  for (const e of perAngle) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (typeof e.carriedFromHead === "string" && e.carriedFromHead.trim().length > 0) continue;
    if (typeof e.angle === "string" && e.angle.trim().length > 0) angles.add(e.angle.trim());
  }
  return angles.size;
}

/**
 * Validate the one-scoped-reviewer-per-fresh-angle contract (fanout_fanin
 * execution mandates one independent reviewer per resolved angle; #1431): no
 * two FRESH angles (angles without `carriedFromHead` — see
 * {@link countFreshAngles}) may share one reviewer identity (`reviewer`,
 * else `dispatchId` — matching {@link countDistinctReviewers}'s identity
 * rule). Carried angles keep their prior reviewer and are exempt. Pure;
 * shared by the write path (write-gate-findings-log.mjs, always-on) and the
 * merge-evidence read path (detect-checkpoint-evidence.mjs, scaling the
 * `requireFanoutProvenance` floor) so both agree.
 *
 * Returns an actionable error string naming the offending angle(s) when the
 * contract is violated (a reviewer covering >1 fresh angle, or a fresh angle
 * recording no reviewer identity at all — which also silently lowers the
 * distinct-reviewer count below the fresh-angle count), or `null` when it
 * holds (including when `perAngle` has no fresh angles).
 *
 * @param {unknown} perAngle
 * @returns {string|null}
 */
export function fanoutReviewerPairingError(perAngle) {
  if (!Array.isArray(perAngle)) return null;
  const freshAngles = new Set();
  const anglesByIdentity = new Map();
  const anonymousAngles = [];
  for (const e of perAngle) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (typeof e.carriedFromHead === "string" && e.carriedFromHead.trim().length > 0) continue;
    const angle = typeof e.angle === "string" ? e.angle.trim() : "";
    if (!angle) continue;
    freshAngles.add(angle);
    const identity = reviewerIdentity(e);
    if (identity) {
      if (!anglesByIdentity.has(identity.id)) anglesByIdentity.set(identity.id, { angles: new Set(), label: identity.label });
      anglesByIdentity.get(identity.id).angles.add(angle);
    } else {
      anonymousAngles.push(angle);
    }
  }
  const freshAngleCount = freshAngles.size;
  const distinctFreshReviewers = anglesByIdentity.size;
  // Enforce the relation itself, not its cardinality shadow: a padded ledger
  // (duplicate-angle entries) can satisfy distinctReviewers >= freshAngleCount
  // while one identity still covers two fresh angles.
  const details = [];
  for (const [id, { angles, label }] of anglesByIdentity) {
    if (angles.size > 1) details.push(`${label} "${id}" is recorded for fresh angles: ${[...angles].join(", ")}`);
  }
  if (anonymousAngles.length > 0) {
    details.push(`fresh angle(s) with no recorded reviewer identity: ${anonymousAngles.join(", ")}`);
  }
  if (details.length === 0) return null;
  return `fan-out provenance violates the one-scoped-reviewer-per-angle contract (${distinctFreshReviewers} distinct reviewer(s) for ${freshAngleCount} fresh angle(s)): ${details.join("; ")} — use executionMode inline_single_agent + --inline-reason for a sanctioned single-reviewer run`;
}

/**
 * Base angle name for a delta-suffixed re-review entry (`<angle>-delta-at-...`,
 * e.g. `pr-checklist-matrix-delta-at-current-head`): a re-review scoped to only
 * the current head's delta still counts toward its base angle for both
 * mandatory-angle coverage and pool-membership checks.
 *
 * @param {string} angle
 * @returns {string}
 */
function baseAngleName(angle) {
  return angle.replace(/-delta-at-.+$/, "");
}

/**
 * Validate a recorded fan-out angle list against a gate's configured angle
 * contract: every mandatory angle must be represented, and — when a pool is
 * supplied — every recorded angle must be a member of it (delta-suffixed
 * angles count toward their {@link baseAngleName}). Pure; shared by the write
 * path (write-gate-findings-log's `provenance.perAngle`, upsert-checkpoint-verdict's
 * `--findings-json` per-angle results) and the merge-evidence read path
 * (detect-checkpoint-evidence re-validating the ledger's `provenance.perAngle`)
 * so all three enforce identically.
 *
 * @param {unknown} recordedAngles — array of `{ angle: string, ... }` entries (provenance.perAngle or normalized per-angle findings)
 * @param {object} [gateAngleContract]
 * @param {string[]} [gateAngleContract.mandatoryAngles] — angles that must always be represented
 * @param {string[]|null} [gateAngleContract.pool] — configured angle pool; null/omitted skips the foreign-angle check
 * @returns {{ missingMandatory: string[], foreignAngles: string[] }}
 */
export function checkFanoutAngleCoverage(recordedAngles, { mandatoryAngles = [], pool = null } = {}) {
  const recorded = Array.isArray(recordedAngles)
    ? recordedAngles
      .map((e) => (e && typeof e === "object" && typeof e.angle === "string" ? e.angle.trim() : ""))
      .filter((a) => a.length > 0)
    : [];
  const recordedBases = new Set(recorded.map(baseAngleName));
  const missingMandatory = mandatoryAngles.filter((a) => !recordedBases.has(a));
  let foreignAngles = [];
  if (Array.isArray(pool) && pool.length > 0) {
    const poolSet = new Set(pool);
    foreignAngles = [...new Set(recorded.filter((a) => !poolSet.has(baseAngleName(a))))];
  }
  return { missingMandatory, foreignAngles };
}

/**
 * Default cap on parallel fan-out reviewers when a caller does not supply one.
 * Mirrors the config default (gates.maxFanoutReviewers).
 */
export const DEFAULT_MAX_FANOUT_REVIEWERS = 8;

/**
 * Validate a single per-angle review result. Returns an error string when the
 * result is malformed, or null when it is well-formed.
 *
 * @param {unknown} result
 * @returns {string|null}
 */
function validateAngleResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "angle result must be an object";
  }
  const r = /** @type {Record<string, unknown>} */ (result);
  if (typeof r.angle !== "string" || r.angle.trim().length === 0) {
    return "angle result is missing a non-empty 'angle'";
  }
  if (typeof r.verdict !== "string" || !VALID_VERDICTS.has(r.verdict)) {
    return `angle '${r.angle}' has invalid verdict (expected clean|findings_present)`;
  }
  if (!Array.isArray(r.findings)) {
    return `angle '${r.angle}' is missing a 'findings' array`;
  }
  for (const f of r.findings) {
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      return `angle '${r.angle}' has a non-object finding`;
    }
    const finding = /** @type {Record<string, unknown>} */ (f);
    if (typeof finding.severity !== "string" || !VALID_SEVERITIES.has(finding.severity)) {
      return `angle '${r.angle}' has a finding with invalid severity (expected must-fix|worth-fixing-now|defer)`;
    }
    if (typeof finding.summary !== "string" || finding.summary.trim().length === 0) {
      return `angle '${r.angle}' has a finding without a summary`;
    }
  }
  // findings_present must carry at least one finding; clean must carry none.
  if (r.verdict === "findings_present" && r.findings.length === 0) {
    return `angle '${r.angle}' reported findings_present but has no findings`;
  }
  if (r.verdict === "clean" && r.findings.length > 0) {
    return `angle '${r.angle}' reported clean but carries findings`;
  }
  return null;
}

/**
 * Consolidate the parallel per-angle review results into one gate verdict +
 * a merged, flattened findings list. Pure.
 *
 * Verdict rules:
 *   - "blocked": any angle result is malformed/missing (the gate could not
 *     produce a trustworthy verdict).
 *   - "clean": all results valid AND no finding carries a severity present in
 *     `blockCleanOnFindingSeverities`.
 *   - "findings_present": all results valid AND at least one finding carries a
 *     blocking severity.
 *
 * @param {object} input
 * @param {Array<unknown>} input.angleResults — per-angle review artifacts
 * @param {string[]} [input.blockCleanOnFindingSeverities] — blocking severities (default ["must-fix"])
 * @returns {{
 *   verdict: "clean"|"findings_present"|"blocked",
 *   findings: Array<{severity: string, angle: string, summary: string, file?: string, line?: number, recommendation?: string, disposition: string}>,
 *   counts: { angles: number, findings: number, blocking: number, bySeverity: Record<string, number> },
 *   malformed: Array<{ index: number, reason: string }>
 * }}
 */
export function consolidateFanin({ angleResults, blockCleanOnFindingSeverities } = {}) {
  const results = Array.isArray(angleResults) ? angleResults : [];
  const blocking = new Set(
    Array.isArray(blockCleanOnFindingSeverities) && blockCleanOnFindingSeverities.length > 0
      ? blockCleanOnFindingSeverities
      : ["must-fix"],
  );

  const malformed = [];
  results.forEach((r, index) => {
    const err = validateAngleResult(r);
    if (err) malformed.push({ index, reason: err });
  });

  const bySeverity = { "must-fix": 0, "worth-fixing-now": 0, "defer": 0 };
  /** @type {Array<{severity: string, angle: string, summary: string, file?: string, line?: number, recommendation?: string, disposition: string}>} */
  const findings = [];
  let blockingCount = 0;

  if (malformed.length === 0) {
    for (const r of results) {
      const angle = r.angle.trim();
      for (const f of r.findings) {
        const isBlocking = blocking.has(f.severity);
        if (isBlocking) blockingCount += 1;
        bySeverity[f.severity] += 1;
        const entry = {
          severity: f.severity,
          angle,
          summary: String(f.summary).trim(),
          // Blocking findings default to accepted-for-fix; non-blocking default
          // to deferred. The fix cycle / operator can override the disposition.
          disposition: isBlocking ? "accepted-for-fix" : "deferred",
        };
        if (typeof f.file === "string" && f.file.trim().length > 0) entry.file = f.file.trim();
        if (typeof f.line === "number" && Number.isFinite(f.line)) entry.line = f.line;
        if (typeof f.recommendation === "string" && f.recommendation.trim().length > 0) {
          entry.recommendation = f.recommendation.trim();
        }
        findings.push(entry);
      }
    }
  }

  let verdict;
  if (malformed.length > 0) {
    verdict = "blocked";
  } else if (blockingCount > 0) {
    verdict = "findings_present";
  } else {
    verdict = "clean";
  }

  return {
    verdict,
    findings,
    counts: {
      angles: results.length,
      findings: findings.length,
      blocking: blockingCount,
      bySeverity,
    },
    malformed,
  };
}

/**
 * Map consolidated findings into the `--findings` JSON shape consumed by
 * scripts/github/write-gate-findings-log.mjs (severity, angle, summary,
 * disposition, optional files). Pure.
 *
 * @param {Array<{severity: string, angle: string, summary: string, file?: string, disposition?: string}>} findings
 * @returns {Array<{severity: string, angle: string, summary: string, disposition?: string, files?: string[]}>}
 */
export function toFindingsLogShape(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return list.map((f) => {
    const entry = {
      severity: f.severity,
      angle: f.angle,
      summary: f.summary,
    };
    if (typeof f.disposition === "string" && f.disposition.trim().length > 0) {
      entry.disposition = f.disposition.trim();
    }
    if (typeof f.file === "string" && f.file.trim().length > 0) {
      entry.files = [f.file.trim()];
    } else if (Array.isArray(f.files)) {
      const files = f.files.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
      if (files.length > 0) entry.files = files;
    }
    return entry;
  });
}

/**
 * Plan how a resolved angle set fans out across the reviewer cap. Pure.
 *
 * When `angles.length <= maxReviewers`, all reviewers run in a single parallel
 * batch (no degradation). When it exceeds the cap, the overflow is split into
 * sequential batches of at most `maxReviewers` each, and `degraded` is true so
 * the skill can record the sequential degradation in the gate evidence.
 *
 * @param {string[]} angles
 * @param {number} [maxReviewers] — default DEFAULT_MAX_FANOUT_REVIEWERS (8)
 * @returns {{ batches: string[][], degraded: boolean }}
 */
export function planFanoutBatches(angles, maxReviewers = DEFAULT_MAX_FANOUT_REVIEWERS) {
  const list = Array.isArray(angles)
    ? angles.filter((a) => typeof a === "string" && a.trim().length > 0).map((a) => a.trim())
    : [];
  const cap = Number.isInteger(maxReviewers) && maxReviewers > 0
    ? maxReviewers
    : DEFAULT_MAX_FANOUT_REVIEWERS;

  if (list.length === 0) {
    return { batches: [], degraded: false };
  }

  const batches = [];
  for (let i = 0; i < list.length; i += cap) {
    batches.push(list.slice(i, i + cap));
  }
  return { batches, degraded: batches.length > 1 };
}
