import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CATEGORY_ANGLE_MAP } from "../src/analysis/change-classifier.mjs";
import {
  RENAME_ONLY_ANGLES,
  angleReviewSurface,
  resolveAngleCarryForward,
  resolveCarryForwardAngles,
  resolveConvergenceCarryForward,
} from "../src/loop/gate-carry-forward.mjs";

describe("RENAME_ONLY_ANGLES — derived from the single source of truth", () => {
  test("matches CATEGORY_ANGLE_MAP[RENAME_ONLY] and is non-empty", () => {
    assert.deepEqual(RENAME_ONLY_ANGLES, CATEGORY_ANGLE_MAP.RENAME_ONLY);
    assert.ok(RENAME_ONLY_ANGLES.includes("link-check"), "a moved doc's broken link must be re-checkable");
    assert.ok(RENAME_ONLY_ANGLES.includes("scope"), "a moved file shifts scope");
  });
});

describe("angleReviewSurface — the pure angle -> surface mapping", () => {
  test("always-include angles never carry (kind: always)", () => {
    assert.equal(angleReviewSurface("gate-evidence").kind, "always");
    assert.equal(angleReviewSurface("pr-description").kind, "always");
    assert.equal(angleReviewSurface("renderer-security").kind, "always");
  });

  test("explicit alwaysRerun angle -> always", () => {
    assert.equal(angleReviewSurface("scope", { alwaysRerun: ["scope"] }).kind, "always");
  });

  test("unmapped / empty angle -> unknown (fail-closed)", () => {
    assert.equal(angleReviewSurface("no-such-angle").kind, "unknown");
    assert.equal(angleReviewSurface("").kind, "unknown");
    assert.equal(angleReviewSurface(null).kind, "unknown");
  });

  test("code-correctness angles' surface excludes docs", () => {
    const surface = angleReviewSurface("correctness");
    assert.equal(surface.kind, "kinds");
    assert.ok(surface.kinds.has("code"));
    assert.ok(surface.kinds.has("test"));
    assert.ok(!surface.kinds.has("docs"));
  });

  test("docs angle surface is docs only", () => {
    const surface = angleReviewSurface("docs");
    assert.equal(surface.kind, "kinds");
    assert.deepEqual([...surface.kinds], ["docs"]);
  });
});

describe("resolveAngleCarryForward — fail-closed decision", () => {
  test("doc-only delta + code angle -> carry forward true", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["docs/guide.md", "README.md"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, true);
  });

  test("code delta + code angle -> false", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["src/foo.mjs"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
    assert.match(decision.reason, /review surface \(code\)/);
  });

  test("doc-only delta + docs angle -> false (surface changed)", () => {
    const decision = resolveAngleCarryForward({
      angle: "docs",
      changedFiles: ["docs/guide.md"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
  });

  test("docs/-hosted .mjs delta + code angle -> false (code re-runs, not carried)", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["docs/example.mjs"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
    assert.match(decision.reason, /review surface \(code\)/);
  });

  test("mandatory / always-include angle -> always re-run (never carried)", () => {
    const decision = resolveAngleCarryForward({
      angle: "pr-description",
      changedFiles: ["docs/guide.md"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
    assert.match(decision.reason, /always re-runs/);
  });

  test("non-clean prior verdict -> false", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["docs/guide.md"],
      prevVerdict: "findings_present",
    });
    assert.equal(decision.carryForward, false);
    assert.match(decision.reason, /not "clean"/);
  });

  test("empty / unavailable delta -> false (fail-closed)", () => {
    assert.equal(resolveAngleCarryForward({ angle: "correctness", changedFiles: [], prevVerdict: "clean" }).carryForward, false);
    assert.equal(resolveAngleCarryForward({ angle: "correctness", changedFiles: undefined, prevVerdict: "clean" }).carryForward, false);
  });

  test("unclassifiable file in delta -> false (fail-closed)", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["assets/logo.png"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
    assert.match(decision.reason, /unclassifiable file/);
  });

  test("unmapped angle -> false (fail-closed) even on a doc-only delta", () => {
    const decision = resolveAngleCarryForward({
      angle: "totally-unknown-angle",
      changedFiles: ["docs/guide.md"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
    assert.match(decision.reason, /no declared review surface/);
  });

  test("mixed doc + code delta -> code angle re-runs", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["docs/guide.md", "src/foo.mjs"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, false);
  });
});

describe("resolveCarryForwardAngles — partition", () => {
  test("splits clean angles into carried vs must-re-run for a doc-only delta", () => {
    const { carried, mustRerun } = resolveCarryForwardAngles({
      prevAngles: ["correctness", "coverage", "docs", "pr-description"],
      changedFiles: ["docs/guide.md"],
    });
    const carriedAngles = carried.map((c) => c.angle).sort();
    const rerunAngles = mustRerun.map((c) => c.angle).sort();
    assert.deepEqual(carriedAngles, ["correctness", "coverage"]);
    // docs (surface touched) + pr-description (always) must re-run.
    assert.deepEqual(rerunAngles, ["docs", "pr-description"]);
  });

  test("all angles re-run when the delta touches code", () => {
    const { carried, mustRerun } = resolveCarryForwardAngles({
      prevAngles: ["correctness", "coverage"],
      changedFiles: ["src/foo.mjs"],
    });
    assert.equal(carried.length, 0);
    assert.equal(mustRerun.length, 2);
  });
});

describe("resolveConvergenceCarryForward — AC2 fail-closed Copilot convergence", () => {
  test("pure doc-only delta -> carry forward convergence", () => {
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["docs/guide.md", "README.md"] }).carryForward, true);
  });

  test("any code/test/config/ci file -> fresh blocking round required", () => {
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["src/foo.mjs"] }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["foo.test.mjs"] }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["config.json"] }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: [".github/workflows/ci.yml"] }).carryForward, false);
  });

  test("docs/-hosted code/config delta -> fresh blocking round (re-open, not carried)", () => {
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["docs/example.mjs"] }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["docs/fixture.json"] }).carryForward, false);
  });

  test("empty delta / unclassifiable file -> false (fail-closed)", () => {
    assert.equal(resolveConvergenceCarryForward({ changedFiles: [] }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["assets/logo.png"] }).carryForward, false);
  });

  test("non-array changedFiles -> false (fail-closed)", () => {
    assert.equal(resolveConvergenceCarryForward({ changedFiles: undefined }).carryForward, false);
  });
});
