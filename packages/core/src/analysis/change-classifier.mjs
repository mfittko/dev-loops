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
 * @property {string[]} addedAngles — catalog angles added (additive mode only, see #1048)
 * @property {Record<string, string>} addedReasons — why each added angle was added
 */

/**
 * Resolve which gate angles to run based on detected change categories.
 *
 * When the diff is ambiguous (no detected categories / analysis failure),
 * all configured angles are recommended (fallback-to-all). A LOGIC_CHANGE
 * diff resolves to its core review subset, not fallback-to-all.
 *
 * When `anglePool` is provided (additive mode, see #1048), catalog angles in
 * the pool that the change categories recommend but that are not already in
 * `configuredAngles` are additively selected and reported as `addedAngles`.
 * When `anglePool` is omitted, additive mode is off and `addedAngles` is
 * always empty.
 *
 * @param {object} options
 * @param {string[]} options.configuredAngles — all angles configured for this gate
 * @param {string[]} options.changeCategories — from diff analysis
 * @param {boolean} [options.ambiguous] — from diff analysis
 * @param {string[]} [options.anglePool] — catalog of angles eligible for additive
 *   selection (caller pre-filters this against excludeAngles); when undefined,
 *   additive selection is disabled
 * @returns {DynamicAngleResult}
 */
export function resolveDynamicAngles({
  configuredAngles,
  changeCategories,
  ambiguous = false,
  anglePool,
}) {
  // Fallback: ambiguous diff → all angles
  if (ambiguous) {
    return {
      recommendedAngles: [...configuredAngles],
      skippedAngles: [],
      reasons: {},
      fallbackToAll: true,
      addedAngles: [],
      addedReasons: {},
    };
  }

  // No change categories → all angles (defensive)
  if (changeCategories.length === 0) {
    return {
      recommendedAngles: [...configuredAngles],
      skippedAngles: [],
      reasons: {},
      fallbackToAll: true,
      addedAngles: [],
      addedReasons: {},
    };
  }

  // Build recommended set from category union, tracking the first trigger per angle
  const recommended = new Set();
  const triggers = new Map();
  for (const cat of changeCategories) {
    const angles = CATEGORY_ANGLE_MAP[cat] ?? [];
    for (const angle of angles) {
      recommended.add(angle);
      if (!triggers.has(angle)) {
        triggers.set(angle, cat);
      }
    }
  }

  // Always-include angles
  for (const angle of ALWAYS_INCLUDE) {
    recommended.add(angle);
    if (!triggers.has(angle)) {
      triggers.set(angle, "always-include");
    }
  }

  // Filter to only angles that are configured
  const recommendedAngles = configuredAngles.filter((a) => recommended.has(a));
  const skippedAngles = configuredAngles.filter((a) => !recommended.has(a));

  // Build reasons
  const reasons = {};
  for (const angle of skippedAngles) {
    reasons[angle] = `Skipped: detected categories (${changeCategories.join(", ") || "none"}) do not trigger this angle`;
  }

  // Additive: pull in recommended catalog angles not already configured (#1048)
  const configuredSet = new Set(configuredAngles);
  const anglePoolSet = Array.isArray(anglePool) ? new Set(anglePool) : null;
  const addedAngles = anglePoolSet
    ? [...recommended].filter((a) => anglePoolSet.has(a) && !configuredSet.has(a))
    : [];
  const addedReasons = {};
  for (const angle of addedAngles) {
    const trigger = triggers.get(angle);
    addedReasons[angle] = trigger === "always-include"
      ? "Added: always-include lens not in the configured pool"
      : `Added: triggered by change category ${trigger}`;
  }

  return {
    recommendedAngles,
    skippedAngles,
    reasons,
    fallbackToAll: false,
    addedAngles,
    addedReasons,
  };
}
