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
  // #1336: the diff touches a security-sensitive seam (browser automation,
  // child_process/shell exec, untrusted network fetch, destructive filesystem
  // ops / local-file upload). Triggers an up-front adversarial threat-model angle.
  SECURITY_SENSITIVE_SEAM: "SECURITY_SENSITIVE_SEAM",
  // #1442: a changed file is on the prose surface (docs/articles/**,
  // docs/presentations/**, README*, narrative docs/*.md) — ADR 0041 prose half.
  // Triggers the required fail-closed `deslop` gate angle.
  PROSE_PRESENT: "PROSE_PRESENT",
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
export const CATEGORY_ANGLE_MAP = {
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
  // input-validation is included (#1336): it was pool-only and never auto-
  // recommended, so entrypoint/input drift went unreviewed unless hand-picked.
  [ChangeCategory.LOGIC_CHANGE]: [
    "scope", "correctness", "coverage", "determinism", "contract-surface", "input-validation",
  ],
  // #1336: security-sensitive seam → up-front adversarial threat-model, plus
  // input-validation and the core correctness/scope lenses. threat-model is
  // never dropped for such a diff (a seam is dangerous regardless of size).
  [ChangeCategory.SECURITY_SENSITIVE_SEAM]: [
    "threat-model", "input-validation", "scope", "correctness",
  ],
  // #1442 (ADR 0041 prose half): a prose-surface path is present → run the
  // required `deslop` gate angle. skills/docs/** is deliberately NOT prose, so
  // a normative-contract-only docs diff never triggers deslop.
  [ChangeCategory.PROSE_PRESENT]: [
    "deslop",
  ],
};

/**
 * Angles that are never skipped, regardless of diff analysis.
 *
 * @type {Set<string>}
 */
export const ALWAYS_INCLUDE = new Set(["gate-evidence", "renderer-security", "pr-description"]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DynamicAngleResult
 * @property {string[]} recommendedAngles — angles to run, limited to the
 *   configured pool (subtractive result); in additive mode the caller
 *   merges addedAngles on top to form the full effective run set
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
