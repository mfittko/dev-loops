// ============================================================================
// Debt signal clustering logic
//
// Groups debt_signal objects into debt_finding clusters.
//
// Clustering rules:
//   - file: signals share the same location.filePath
//   - module: signals share the same parent directory of filePath
//   - theme: signals share the same signalKind category
//   - Precedence: file > module > theme
//   - A signal belongs to exactly one cluster.
//   - Signals with no file, module, or theme form singleton clusters.
//
// Finding ID determinism:
//   Finding IDs are derived from sorted signalIds + clusterReason using a
//   stable hash, so re-running clustering on the same input produces the
//   same debt_finding artifacts.
//
// Output: array of debt_finding objects with embedded signal references,
// signalIds, and aggregated score.
// ============================================================================

import { createHash } from "node:crypto";
import { scoreCluster } from "./score.mjs";

/**
 * Derive a deterministic finding ID from sorted signal IDs and the cluster reason.
 * Uses SHA-256 truncated to a UUID-v4-format string for stable cross-run identity.
 *
 * @param {Array<string>} signalIds — sorted array of signal UUIDs
 * @param {string} clusterReason — "file", "module", "theme", or "singleton"
 * @returns {string} UUID-v4-format deterministic ID
 */
function deriveFindingId(signalIds, clusterReason) {
  const sorted = [...signalIds].sort();
  const input = sorted.join(":") + "|" + clusterReason;
  const hash = createHash("sha256").update(input).digest("hex");
  // Format as UUID v4: 8-4-4-4-12 using first 32 hex chars
  const variantNibble = (parseInt(hash[16], 16) & 0x3 | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variantNibble}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Derive deterministic timestamps from signal timestamps.
 * Uses the earliest signal timestamp for createdAt and the latest for updatedAt.
 *
 * @param {Array<object>} signals
 * @returns {{ createdAt: string, updatedAt: string }}
 */
function deriveTimestamps(signals) {
  const timestamps = signals.map(s => s.timestamp).filter(Boolean).sort();
  if (timestamps.length === 0) {
    const epoch = "1970-01-01T00:00:00.000Z";
    return { createdAt: epoch, updatedAt: epoch };
  }
  return { createdAt: timestamps[0], updatedAt: timestamps[timestamps.length - 1] };
}

/**
 * Extract the file key from a signal: location.filePath, or undefined.
 * @param {object} signal
 * @returns {string|undefined}
 */
function fileKey(signal) {
  return signal.location?.filePath || undefined;
}

/**
 * Extract the module key from a signal:
 * parent directory of filePath (dirname).
 * Returns undefined when no filePath exists — module clustering is
 * strictly directory-based and does not fall back to signalKind.
 * Theme clustering handles signalKind grouping separately.
 *
 * @param {object} signal
 * @returns {string|undefined}
 */
function moduleKey(signal) {
  const fp = signal.location?.filePath;
  if (!fp) return undefined;
  const lastSlash = fp.lastIndexOf("/");
  if (lastSlash >= 0) return fp.slice(0, lastSlash);
  return fp; // no directory separator — treat as its own module
}

/**
 * Extract the theme key from a signal: signalKind category.
 * @param {object} signal
 * @returns {string|undefined}
 */
function themeKey(signal) {
  return signal.signalKind || undefined;
}

/**
 * Group signals by a key extraction function.
 * Returns Map<key, signal[]> where key may be undefined for signals lacking that dimension.
 *
 * @param {Array<object>} signals
 * @param {(signal: object) => string|undefined} keyFn
 * @returns {Map<string|undefined, Array<object>>}
 */
function groupByKey(signals, keyFn) {
  const map = new Map();
  for (const signal of signals) {
    const key = keyFn(signal);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(signal);
  }
  return map;
}

/**
 * Create a debt_finding from a cluster of signals.
 *
 * @param {Array<object>} signals — debt_signal-compatible objects
 * @param {string} clusterReason — "file", "module", "theme", or "singleton"
 * @returns {object} enriched debt_finding shape with internal fields
 */
function buildFinding(signals, clusterReason) {
  const score = scoreCluster(signals);

  // Build title from cluster reason + primary category
  const categories = [...new Set(signals.map(s => s.signalKind).filter(Boolean))].sort();
  const primaryCategory = categories[0] || "unknown";

  // Build location summary
  const filePaths = [...new Set(
    signals.map(s => s.location?.filePath).filter(Boolean)
  )].sort();

  const title = filePaths.length === 1
    ? `${clusterReason}: ${primaryCategory} in ${filePaths[0]}`
    : `${clusterReason}: ${primaryCategory} (${signals.length} signals)`;

  const description = `Clustered by ${clusterReason}. ` +
    `Categories: ${categories.join(", ")}. ` +
    `Files: ${filePaths.length > 0 ? filePaths.join(", ") : "none"}.`;

  const sortedSignalIds = signals.map(s => s.id).sort();
  const id = deriveFindingId(sortedSignalIds, clusterReason);
  const { createdAt, updatedAt } = deriveTimestamps(signals);

  return {
    id,
    signalIds: sortedSignalIds,
    validationStatus: "pending",
    score,
    remediationShape: "watch_only", // placeholder; shaped later
    title: title.slice(0, 200),
    description: description.slice(0, 500),
    locationSummary: filePaths.length > 0
      ? { filePaths, primaryFilePath: filePaths[0] }
      : undefined,
    createdAt,
    updatedAt,
    // Internal fields for shaping (not in the DebtFindingSchema output)
    _clusterReason: clusterReason,
    _signalCount: signals.length,
    _categories: categories,
  };
}

/**
 * Cluster debt_signal objects into debt_finding arrays.
 *
 * Multi-pass algorithm:
 *   1. Group by file (location.filePath exact match)
 *   2. From remaining, group by module (directory of filePath)
 *   3. From remaining, group by theme (signalKind)
 *   4. Remaining → singleton clusters
 *
 * Each signal appears in exactly one cluster.
 * Clusters with only one signal when grouped by a dimension
 * are deferred to the next pass.
 *
 * @param {Array<object>} signals — array of debt_signal-compatible objects
 * @returns {Array<object>} array of clean debt_finding shapes (no internal fields)
 */
export function clusterSignals(signals) {
  const enriched = clusterSignalsEnriched(signals);
  return enriched.map(({ _clusterReason, _signalCount, _categories, ...clean }) => clean);
}

/**
 * Cluster signals and return findings enriched with internal metadata
 * for shaping (_clusterReason, _signalCount, _categories).
 *
 * @param {Array<object>} signals — array of debt_signal-compatible objects
 * @returns {Array<object>} array of enriched debt_finding shapes
 */
export function clusterSignalsEnriched(signals) {
  if (!Array.isArray(signals)) return [];
  if (signals.length === 0) return [];

  const findings = [];
  let remaining = [...signals];

  // Pass 1: file
  const fileGroups = groupByKey(remaining, fileKey);
  remaining = [];
  for (const [key, group] of fileGroups) {
    if (key === undefined || group.length <= 1) {
      remaining.push(...group);
    } else {
      findings.push(buildFinding(group, "file"));
    }
  }

  // Pass 2: module (directory-based only; no signalKind fallback)
  const moduleGroups = groupByKey(remaining, moduleKey);
  remaining = [];
  for (const [key, group] of moduleGroups) {
    if (key === undefined || group.length <= 1) {
      remaining.push(...group);
    } else {
      findings.push(buildFinding(group, "module"));
    }
  }

  // Pass 3: theme
  const themeGroups = groupByKey(remaining, themeKey);
  remaining = [];
  for (const [key, group] of themeGroups) {
    if (key === undefined || group.length <= 1) {
      remaining.push(...group);
    } else {
      findings.push(buildFinding(group, "theme"));
    }
  }

  // Pass 4: singletons for any remaining
  for (const signal of remaining) {
    findings.push(buildFinding([signal], "singleton"));
  }

  // Stable output order: sort findings by id
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return findings;
}
