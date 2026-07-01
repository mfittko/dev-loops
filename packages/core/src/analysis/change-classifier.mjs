/**
 * Change category classification and angle relevance index.
 *
 * Maps change categories detected by the diff analyzer to relevant gate review
 * angles.
 */

// ---------------------------------------------------------------------------
// Change categories
// ---------------------------------------------------------------------------

/** @enum {string} */
export const ChangeCategory = Object.freeze({
  RENAME_ONLY: "RENAME_ONLY",
  DOCS_ONLY: "DOCS_ONLY",
  CONFIG_ONLY: "CONFIG_ONLY",
  TEST_ONLY: "TEST_ONLY",
  CI_ONLY: "CI_ONLY",
  COMMENT_ONLY: "COMMENT_ONLY",
  LOGIC_CHANGE: "LOGIC_CHANGE",
});

// ---------------------------------------------------------------------------
// Angle relevance index
// ---------------------------------------------------------------------------

/**
 * Map of ChangeCategory → relevant gate angles.
 *
 * Categories not listed default to an empty array (no angles relevant).
 * When multiple categories match, the union of angles is taken.
 *
 * @type {Record<string, string[]>}
 */
const CATEGORY_ANGLE_MAP = {
  [ChangeCategory.RENAME_ONLY]: [
    "scope", "correctness", "contract-surface", "docs", "link-check",
  ],
  [ChangeCategory.DOCS_ONLY]: [
    "docs", "link-check", "contract-surface", "dry",
  ],
  [ChangeCategory.CONFIG_ONLY]: [
    "config-drift", "scope", "correctness", "contract-surface",
  ],
  [ChangeCategory.TEST_ONLY]: [
    "coverage", "correctness", "determinism",
  ],
  [ChangeCategory.CI_ONLY]: [
    "ci-guard", "scope", "config-drift",
  ],
  [ChangeCategory.COMMENT_ONLY]: [
    "dry",
  ],
  // Core review subset for any non-trivial code change. Peripheral lenses
  // (ci-guard, link-check, packaging-runtime, config-drift, etc.) are pulled in
  // only when the diff's other categories implicate them, not by logic alone.
  [ChangeCategory.LOGIC_CHANGE]: [
    "scope", "correctness", "coverage", "determinism", "contract-surface",
  ],
};

/**
 * Angles that are never skipped, regardless of diff analysis.
 *
 * @type {Set<string>}
 */
const ALWAYS_INCLUDE = new Set(["gate-evidence", "renderer-security", "pr-description"]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DynamicAngleResult
 * @property {string[]} recommendedAngles — angles to run
 * @property {string[]} skippedAngles — angles skipped with reasons
 * @property {Record<string, string>} reasons — why each angle was skipped
 * @property {boolean} fallbackToAll — true when ambiguous → all angles recommended
 */

/**
 * Resolve which gate angles to run based on detected change categories.
 *
 * When the diff is ambiguous (no detected categories / analysis failure),
 * all configured angles are recommended (fallback-to-all). A LOGIC_CHANGE
 * diff resolves to its core review subset, not fallback-to-all.
 *
 * @param {object} options
 * @param {string[]} options.configuredAngles — all angles configured for this gate
 * @param {string[]} options.changeCategories — from diff analysis
 * @param {boolean} [options.ambiguous] — from diff analysis
 * @returns {DynamicAngleResult}
 */
export function resolveDynamicAngles({
  configuredAngles,
  changeCategories,
  ambiguous = false,
}) {
  // Fallback: ambiguous diff → all angles
  if (ambiguous) {
    return {
      recommendedAngles: [...configuredAngles],
      skippedAngles: [],
      reasons: {},
      fallbackToAll: true,
    };
  }

  // No change categories → all angles (defensive)
  if (changeCategories.length === 0) {
    return {
      recommendedAngles: [...configuredAngles],
      skippedAngles: [],
      reasons: {},
      fallbackToAll: true,
    };
  }

  // Build recommended set from category union
  const recommended = new Set();
  for (const cat of changeCategories) {
    const angles = CATEGORY_ANGLE_MAP[cat] ?? [];
    for (const angle of angles) {
      recommended.add(angle);
    }
  }

  // Always-include angles
  for (const angle of ALWAYS_INCLUDE) {
    recommended.add(angle);
  }

  // Filter to only angles that are configured
  const recommendedAngles = configuredAngles.filter((a) => recommended.has(a));
  const skippedAngles = configuredAngles.filter((a) => !recommended.has(a));

  // Build reasons
  const reasons = {};
  for (const angle of skippedAngles) {
    reasons[angle] = `Skipped: detected categories (${changeCategories.join(", ") || "none"}) do not trigger this angle`;
  }

  return {
    recommendedAngles,
    skippedAngles,
    reasons,
    fallbackToAll: false,
  };
}
