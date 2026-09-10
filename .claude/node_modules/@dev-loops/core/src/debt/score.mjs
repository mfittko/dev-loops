// ============================================================================
// Debt signal cluster scoring model
//
// Transforms a cluster of debt_signal objects into a numeric 0-100 score.
//
// Three dimensions:
//   - Frequency: how many signals in the cluster, capped and normalized
//   - Severity: average severity hint value from signal source metadata
//   - Impact: blast-radius / churn-risk heuristic based on signal properties
//
// Guarantees:
//   - Deterministic: same inputs → same score
//   - Monotonicity: higher frequency/severity/impact → higher or equal score
//   - Boundary handling: zero inputs, single-signal clusters, max clusters
//
// Severity mapping (canonical):
//   info=1, low=2, medium=3, high=4, critical=5
//
// Weights are hardcoded constants in this slice; not configurable.
// The formula is: score = frequencyScore * 0.35 + severityScore * 0.40 + impactScore * 0.25
// clamped to 0-100.
// ============================================================================

/**
 * Map a DebtSignalSeverity string to a numeric weight 1-5.
 * Returns 1 for unrecognized values (defensive).
 *
 * @param {string} severityHint
 * @returns {number}
 */
function severityWeight(severityHint) {
  const map = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
  return map[severityHint] ?? 1;
}

/**
 * Compute the frequency score component (0-100).
 * Uses a logarithmic cap so the first few signals matter most.
 * 1 signal → 20, 3 signals → 58, 5 signals → 76, 10 signals → 100.
 *
 * @param {number} signalCount
 * @returns {number}
 */
function frequencyScore(signalCount) {
  if (signalCount <= 0) return 0;
  if (signalCount === 1) return 20;
  // Logarithmic scaling: 20 + 80 * log2(count) / log2(10), capped at 100
  const raw = 20 + 80 * (Math.log2(signalCount) / Math.log2(10));
  return Math.min(100, Math.round(raw));
}

/**
 * Compute the severity score component (0-100).
 * Average severity weight mapped: 1→20, 3→60, 5→100.
 *
 * @param {Array<{ severityHint: string }>} signals
 * @returns {number}
 */
function severityScore(signals) {
  if (signals.length === 0) return 0;
  const total = signals.reduce((sum, s) => sum + severityWeight(s.severityHint), 0);
  const avg = total / signals.length;
  return Math.round(avg * 20); // 1..5 → 20..100
}

/**
 * Compute the impact score component (0-100).
 * Heuristic based on:
 *   - file presence: signals with known file paths are more actionable (+30 base if any)
 *   - confidence: average signal confidence boosts impact
 *   - signalKind diversity: more unique categories = broader blast radius
 * Returns 0 for empty clusters.
 *
 * @param {Array<{ location?: { filePath?: string }, confidence?: number, signalKind?: string }>} signals
 * @returns {number}
 */
function impactScore(signals) {
  if (signals.length === 0) return 0;

  let score = 0;

  // File presence: +30 if any signal has a file path
  const hasFilePath = signals.some(s => s.location?.filePath);
  if (hasFilePath) score += 30;

  // Confidence boost: average confidence * 40
  const confidences = signals.map(s => s.confidence ?? 1);
  const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  score += Math.round(avgConfidence * 40);

  // Category diversity: unique signalKinds * 5, capped at 30
  const uniqueKinds = new Set(signals.map(s => s.signalKind).filter(Boolean));
  const diversityBonus = Math.min(30, uniqueKinds.size * 5);
  score += diversityBonus;

  return Math.min(100, score);
}

/**
 * Weight constant — keeps module self-documenting and testable.
 * @type {{ frequency: number, severity: number, impact: number }}
 */
export const SCORE_WEIGHTS = Object.freeze({
  frequency: 0.35,
  severity: 0.40,
  impact: 0.25,
});

/**
 * Score a cluster of debt_signal objects.
 *
 * @param {Array<{ severityHint: string, location?: { filePath?: string }, confidence?: number, signalKind?: string }>} signals — array of debt_signal-compatible objects
 * @returns {number} integer score 0-100
 */
export function scoreCluster(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return 0;

  const freq = frequencyScore(signals.length);
  const sev = severityScore(signals);
  const imp = impactScore(signals);

  const raw = freq * SCORE_WEIGHTS.frequency +
              sev * SCORE_WEIGHTS.severity +
              imp * SCORE_WEIGHTS.impact;

  return Math.min(100, Math.max(0, Math.round(raw)));
}
