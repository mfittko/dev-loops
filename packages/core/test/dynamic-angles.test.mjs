import assert from "node:assert/strict";
import test from "node:test";

import { ChangeCategory, resolveDynamicAngles } from "../src/analysis/change-classifier.mjs";

const DRAFT_ANGLES = [
  "scope", "coverage", "correctness", "ci-guard", "contract-surface",
  "input-validation", "determinism", "no-op", "link-check",
  "packaging-runtime", "state-concurrency", "config-drift", "gate-evidence",
];

const PREAPPROVAL_ANGLES = [
  "dry", "kiss", "yagni", "srp", "soc", "deep",
  "docs", "ocp", "lsp", "isp", "dip", "renderer-security",
];

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

test("resolveDynamicAngles: fallbackToAll when ambiguous", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: ["LOGIC_CHANGE"],
    ambiguous: true,
  });
  assert.equal(result.fallbackToAll, true);
  assert.equal(result.recommendedAngles.length, DRAFT_ANGLES.length);
  assert.equal(result.skippedAngles.length, 0);
});

test("resolveDynamicAngles: fallbackToAll when no categories", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [],
  });
  assert.equal(result.fallbackToAll, true);
  assert.equal(result.recommendedAngles.length, DRAFT_ANGLES.length);
});

// ---------------------------------------------------------------------------
// Category-specific
// ---------------------------------------------------------------------------

test("resolveDynamicAngles: rename-only skips structural angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.RENAME_ONLY],
  });
  assert.ok(result.recommendedAngles.includes("scope"));
  assert.ok(result.recommendedAngles.includes("contract-surface"));
  assert.ok(result.skippedAngles.includes("config-drift"));
  assert.ok(result.skippedAngles.includes("packaging-runtime"));
  assert.equal(result.fallbackToAll, false);
});

test("resolveDynamicAngles: docs-only skips most angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.DOCS_ONLY],
  });
  assert.ok(result.recommendedAngles.includes("docs") || result.recommendedAngles.includes("link-check"));
  assert.ok(result.skippedAngles.includes("coverage"));
  assert.ok(result.skippedAngles.includes("correctness"));
});

test("resolveDynamicAngles: config-only includes config-drift", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.CONFIG_ONLY],
  });
  assert.ok(result.recommendedAngles.includes("config-drift"));
  assert.ok(result.recommendedAngles.includes("scope"));
});

test("resolveDynamicAngles: test-only includes coverage + determinism", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.TEST_ONLY],
  });
  assert.ok(result.recommendedAngles.includes("coverage"));
  assert.ok(result.recommendedAngles.includes("determinism"));
});

test("resolveDynamicAngles: LOGIC_CHANGE resolves to core subset, not all angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.LOGIC_CHANGE],
  });
  assert.equal(result.fallbackToAll, false);
  // Core review subset (∩ DRAFT_ANGLES) + always-include gate-evidence.
  for (const a of ["scope", "correctness", "coverage", "determinism", "contract-surface", "gate-evidence"]) {
    assert.ok(result.recommendedAngles.includes(a), `expected ${a} in core subset`);
  }
  // Peripheral lenses are dropped, not run for logic alone.
  for (const a of ["link-check", "packaging-runtime", "config-drift", "ci-guard", "input-validation", "state-concurrency", "no-op"]) {
    assert.ok(result.skippedAngles.includes(a), `expected ${a} skipped`);
    assert.ok(typeof result.reasons[a] === "string");
  }
  // Meaningfully narrower than the full configured pool (not a fallback-to-all).
  assert.ok(result.recommendedAngles.length < DRAFT_ANGLES.length);
});

test("resolveDynamicAngles: mixed logic + CI unions ci-guard into the core subset", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.LOGIC_CHANGE, ChangeCategory.CI_ONLY],
  });
  assert.equal(result.fallbackToAll, false);
  assert.ok(result.recommendedAngles.includes("ci-guard"));   // from CI_ONLY
  assert.ok(result.recommendedAngles.includes("correctness")); // from LOGIC_CHANGE core
  assert.ok(result.recommendedAngles.includes("config-drift")); // CI_ONLY unions this in
});

// ---------------------------------------------------------------------------
// Always-include
// ---------------------------------------------------------------------------

test("resolveDynamicAngles: gate-evidence always included", () => {
  for (const cat of Object.values(ChangeCategory)) {
    const result = resolveDynamicAngles({
      configuredAngles: DRAFT_ANGLES,
      changeCategories: [cat],
    });
    assert.ok(
      result.recommendedAngles.includes("gate-evidence"),
      `gate-evidence should be included for category ${cat}`,
    );
  }
});

test("resolveDynamicAngles: renderer-security always included", () => {
  const result = resolveDynamicAngles({
    configuredAngles: PREAPPROVAL_ANGLES,
    changeCategories: [ChangeCategory.RENAME_ONLY],
  });
  assert.ok(result.recommendedAngles.includes("renderer-security"));
});

// ---------------------------------------------------------------------------
// Respects configured angles
// ---------------------------------------------------------------------------

test("resolveDynamicAngles: only recommends configured angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: ["scope", "docs"],
    changeCategories: [ChangeCategory.LOGIC_CHANGE],
  });
  // LOGIC_CHANGE maps to many angles, but only "scope" is configured
  assert.ok(result.recommendedAngles.includes("scope"));
  assert.ok(!result.recommendedAngles.includes("correctness")); // not configured
  assert.ok(!result.skippedAngles.includes("scope"));
});

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

test("resolveDynamicAngles: provides reasons for skipped angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.DOCS_ONLY],
  });
  assert.ok(Object.keys(result.reasons).length > 0);
  assert.equal(typeof result.reasons[result.skippedAngles[0]], "string");
});

// ---------------------------------------------------------------------------
// Additive angle selection (#1048) — off by default, on when anglePool passed
// ---------------------------------------------------------------------------

const NARROW_ANGLES = DRAFT_ANGLES.filter((a) => a !== "ci-guard");

test("resolveDynamicAngles: default (no anglePool) never adds angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: NARROW_ANGLES,
    changeCategories: [ChangeCategory.CI_ONLY],
  });
  assert.deepEqual(result.addedAngles, []);
  assert.deepEqual(result.addedReasons, {});
  assert.ok(!result.recommendedAngles.includes("ci-guard"));
});

test("resolveDynamicAngles: additive mode adds a catalog angle triggered by change category", () => {
  const result = resolveDynamicAngles({
    configuredAngles: NARROW_ANGLES,
    changeCategories: [ChangeCategory.CI_ONLY],
    anglePool: [...NARROW_ANGLES, "ci-guard"],
  });
  // addedAngles reports the catalog addition; recommendedAngles itself is
  // still scoped to configuredAngles — merging addedAngles in is the
  // caller's (resolveGateAnglesDynamic) responsibility, not this function's.
  assert.ok(result.addedAngles.includes("ci-guard"));
  assert.ok(!result.recommendedAngles.includes("ci-guard"));
  assert.equal(result.addedReasons["ci-guard"], "Added: triggered by change category CI_ONLY");
});

test("resolveDynamicAngles: additive mode does not re-add already-configured angles", () => {
  const result = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: [ChangeCategory.CI_ONLY],
    anglePool: DRAFT_ANGLES,
  });
  assert.deepEqual(result.addedAngles, []);
});

test("resolveDynamicAngles: additive mode does not add angles outside anglePool", () => {
  const result = resolveDynamicAngles({
    configuredAngles: NARROW_ANGLES,
    changeCategories: [ChangeCategory.CI_ONLY],
    anglePool: NARROW_ANGLES, // ci-guard not in the catalog
  });
  assert.deepEqual(result.addedAngles, []);
});

test("resolveDynamicAngles: additive mode reports always-include trigger reason", () => {
  const narrowPreapproval = PREAPPROVAL_ANGLES.filter((a) => a !== "renderer-security");
  const result = resolveDynamicAngles({
    configuredAngles: narrowPreapproval,
    changeCategories: [ChangeCategory.RENAME_ONLY],
    anglePool: PREAPPROVAL_ANGLES,
  });
  assert.ok(result.addedAngles.includes("renderer-security"));
  assert.equal(result.addedReasons["renderer-security"], "Added: always-include lens not in the configured pool");
});

test("resolveDynamicAngles: additive is a no-op in ambiguous/no-category fallback branches", () => {
  const ambiguousResult = resolveDynamicAngles({
    configuredAngles: NARROW_ANGLES,
    changeCategories: [ChangeCategory.CI_ONLY],
    ambiguous: true,
    anglePool: [...NARROW_ANGLES, "ci-guard"],
  });
  assert.deepEqual(ambiguousResult.addedAngles, []);
  assert.deepEqual(ambiguousResult.addedReasons, {});

  const noCategoriesResult = resolveDynamicAngles({
    configuredAngles: NARROW_ANGLES,
    changeCategories: [],
    anglePool: [...NARROW_ANGLES, "ci-guard"],
  });
  assert.deepEqual(noCategoriesResult.addedAngles, []);
  assert.deepEqual(noCategoriesResult.addedReasons, {});
});
