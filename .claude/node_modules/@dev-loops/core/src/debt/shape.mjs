// ============================================================================
// Debt finding shaping rules
//
// Turns each scored debt_finding into exactly one outcome:
//   - remediation_item: bounded, PR-sized fix with clear acceptance criteria
//   - debt_epic: cross-cutting, needs decomposition before execution
//   - defer: acknowledged, scheduled for future review
//   - watch: low confidence, needs more signals before action
//   - dismiss: false positive or already fixed
//
// Thresholds are hardcoded constants in this slice; not configurable.
// Exported for contract tests that verify predicate boundaries.
//
// Actionable outcomes (remediation_item, debt_epic) are gated on having
// at least one filePath. Theme-only clusters without file paths are
// downgraded to watch regardless of score.
// ============================================================================

// ============================================================================
// Threshold constants
// ============================================================================

/** Score >= ITEM_THRESHOLD → eligible for remediation_item or debt_epic */
export const ITEM_THRESHOLD = 65;

/** Score >= DEFER_THRESHOLD → defer */
export const DEFER_THRESHOLD = 50;

/** Score >= WATCH_THRESHOLD → watch */
export const WATCH_THRESHOLD = 30;

/** Below WATCH_THRESHOLD → dismiss */

/** Signals above this count → debt_epic (even with score >= ITEM_THRESHOLD) */
export const EPIC_SIGNAL_COUNT_THRESHOLD = 3;

// ============================================================================
// Shape outcome
// ============================================================================

/** @typedef {"remediation_item"|"debt_epic"|"defer"|"watch"|"dismiss"} ShapeOutcome */

// ============================================================================
// Helpers
// ============================================================================

/**
 * Deterministic epoch constant for timestamp fallback.
 * "1970-01-01T00:00:00.000Z"
 */
const EPOCH_TS = "1970-01-01T00:00:00.000Z";

/**
 * Pass through finding timestamps. Falls back to epoch when finding
 * timestamps are missing — never uses wall-clock time.
 *
 * @param {object} finding — enriched debt_finding with createdAt/updatedAt
 * @returns {{ createdAt: string, updatedAt: string }}
 */
function deriveTimestamps(finding) {
  return {
    createdAt: finding.createdAt || EPOCH_TS,
    updatedAt: finding.updatedAt || finding.createdAt || EPOCH_TS,
  };
}

/**
 * Check whether a finding has actionable file paths.
 *
 * @param {object} finding — enriched debt_finding
 * @returns {boolean}
 */
function hasFilePaths(finding) {
  const paths = finding.locationSummary?.filePaths;
  return Array.isArray(paths) && paths.length > 0;
}

// ============================================================================
// Pure predicate: classify a finding into a shape outcome
// ============================================================================

/**
 * Determine the shape outcome for a debt_finding.
 * Actionable outcomes (remediation_item, debt_epic) require at least
 * one filePath; theme-only clusters without file paths are downgraded
 * to watch.
 *
 * @param {object} finding — debt_finding shape with at least { score, _signalCount, signalIds }
 * @returns {ShapeOutcome}
 */
function classifyShape(finding) {
  const score = finding.score ?? 0;
  const signalCount = finding._signalCount ?? (finding.signalIds?.length ?? 1);

  if (score >= ITEM_THRESHOLD && hasFilePaths(finding)) {
    return signalCount > EPIC_SIGNAL_COUNT_THRESHOLD ? "debt_epic" : "remediation_item";
  }
  if (score >= ITEM_THRESHOLD) {
    // High score but no file paths — downgrade to watch
    return "watch";
  }
  if (score >= DEFER_THRESHOLD) return "defer";
  if (score >= WATCH_THRESHOLD) return "watch";
  return "dismiss";
}

// ============================================================================
// Artifact builders
// ============================================================================

/**
 * Build a remediation_item artifact from a finding.
 * Uses structured _categories from the cluster.
 *
 * @param {object} finding — enriched debt_finding with _categories array
 * @returns {object} RemediationItemSchema-compatible shape
 */
function buildRemediationItem(finding) {
  const cats = (finding._categories && finding._categories.length > 0)
    ? finding._categories.join(", ")
    : "unknown";
  const { createdAt, updatedAt } = deriveTimestamps(finding);
  return {
    kind: "remediation_item",
    findingId: finding.id,
    title: finding.title,
    description: finding.description || `Remediation for finding ${finding.id}`,
    acceptanceCriteria: [
      `Address ${cats} issues in affected files`,
      `Verify no regression in existing test suite`,
      `Maintain >= 90% coverage`,
    ],
    score: finding.score ?? 0,
    primaryFilePath: finding.locationSummary?.primaryFilePath,
    filePaths: finding.locationSummary?.filePaths,
    signalIds: finding.signalIds,
    sourceType: "debt_pipeline",
    createdAt,
    updatedAt,
  };
}

/**
 * Build a debt_epic artifact from a finding.
 *
 * @param {object} finding — enriched debt_finding
 * @returns {object} DebtEpicSchema-compatible shape
 */
function buildDebtEpic(finding) {
  const { createdAt, updatedAt } = deriveTimestamps(finding);
  return {
    kind: "debt_epic",
    findingId: finding.id,
    title: finding.title,
    description: finding.description || `Epic for finding ${finding.id}`,
    score: finding.score ?? 0,
    filePaths: finding.locationSummary?.filePaths,
    signalIds: finding.signalIds,
    estimatedItems: Math.ceil((finding._signalCount ?? 1) / 2),
    createdAt,
    updatedAt,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Shape a single enriched finding into its outcome.
 *
 * Returns an object with { outcome, artifact } where artifact is defined
 * for remediation_item and debt_epic outcomes, and null for defer/watch/dismiss.
 *
 * @param {object} finding — enriched debt_finding (with _signalCount)
 * @returns {{ outcome: ShapeOutcome, artifact: object|null }}
 */
export function shapeFinding(finding) {
  const outcome = classifyShape(finding);

  let artifact = null;
  if (outcome === "remediation_item") {
    artifact = buildRemediationItem(finding);
  } else if (outcome === "debt_epic") {
    artifact = buildDebtEpic(finding);
  }

  return { outcome, artifact };
}

/**
 * Shape an array of enriched findings, returning the outcome + artifact for each.
 *
 * @param {Array<object>} findings — enriched debt_finding array
 * @returns {Array<{ outcome: ShapeOutcome, artifact: object|null, findingId: string }>}
 */
export function shapeFindings(findings) {
  return findings.map(f => {
    const { outcome, artifact } = shapeFinding(f);
    return { outcome, artifact, findingId: f.id };
  });
}
