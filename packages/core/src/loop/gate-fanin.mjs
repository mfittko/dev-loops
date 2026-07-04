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
 * contract in docs/gate-review-sub-loop-contract.md.
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
