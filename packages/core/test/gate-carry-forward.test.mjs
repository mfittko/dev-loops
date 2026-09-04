import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CATEGORY_ANGLE_MAP } from "../src/analysis/change-classifier.mjs";
import {
  RENAME_ONLY_ANGLES,
  angleReviewSurface,
  isDevLoopConfigSourcePath,
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

  test("alwaysRerun matches case-insensitively — a case-drifted configured mandatory angle is still always", () => {
    assert.equal(angleReviewSurface("correctness", { alwaysRerun: ["Correctness"] }).kind, "always");
    assert.equal(angleReviewSurface("Correctness".toLowerCase(), { alwaysRerun: [" CORRECTNESS "] }).kind, "always");
  });

  test("unmapped / empty angle -> unknown (fail-closed)", () => {
    assert.equal(angleReviewSurface("no-such-angle").kind, "unknown");
    assert.equal(angleReviewSurface("").kind, "unknown");
    assert.equal(angleReviewSurface(null).kind, "unknown");
  });

  // The trim+lowercase normalization applies to the `kinds` map lookup too,
  // not just the alwaysRerun/ALWAYS_INCLUDE checks above: a case-drifted
  // MAPPED angle name resolves the same `kinds` surface as its canonical
  // form, rather than falling through to `unknown`. Pinned deliberately —
  // dropping the normalization on this lookup would silently flip these
  // back to fail-closed `unknown` with no other test noticing (the existing
  // case-drift tests above pre-lowercase their own lookup argument).
  test("case/whitespace-drifted MAPPED angle names resolve the same kinds surface, not unknown", () => {
    assert.equal(angleReviewSurface("Correctness").kind, "kinds");
    assert.deepEqual([...angleReviewSurface("Correctness").kinds].sort(), [...angleReviewSurface("correctness").kinds].sort());
    assert.equal(angleReviewSurface(" DOCS ").kind, "kinds");
  });

  test("case-drifted hardcoded ALWAYS_INCLUDE angle name resolves always, not unknown", () => {
    assert.equal(angleReviewSurface("Pr-Description").kind, "always");
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

  // #1442: deslop's review surface is the `docs` kind — a clean deslop verdict
  // carries forward across a delta with no docs file, and re-runs on any doc
  // change (prose or not; non-prose docs never vote clean on deslop in the
  // first place because PROSE_PRESENT is not armed).
  test("deslop angle surface is docs (fail-closed carry-forward)", () => {
    const surface = angleReviewSurface("deslop");
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

  test(".markdown-only delta carries a clean code angle like .md", () => {
    const decision = resolveAngleCarryForward({
      angle: "correctness",
      changedFiles: ["changes.markdown"],
      prevVerdict: "clean",
    });
    assert.equal(decision.carryForward, true);
  });

  test(".devloops-only delta re-runs EVERY angle — it rewrites the reviewer pool/prompts (config-source override)", () => {
    // classifyFile now calls .devloops "config", but a dev-loop config-source
    // delta invalidates every prior verdict's provenance (the angle pool,
    // mandatory floor, and reviewer prompts live there), so no angle may
    // carry a clean verdict across it — not even one whose declared surface
    // excludes config.
    for (const angle of ["coverage", "link-check", "config-drift"]) {
      const decision = resolveAngleCarryForward({
        angle,
        changedFiles: [".devloops"],
        prevVerdict: "clean",
      });
      assert.equal(decision.carryForward, false, angle);
      assert.match(decision.reason, /dev-loop config source/);
    }
    // Ordinary config (not a dev-loop config source) keeps surface semantics:
    const ordinary = resolveAngleCarryForward({
      angle: "coverage",
      changedFiles: ["package.json"],
      prevVerdict: "clean",
    });
    assert.equal(ordinary.carryForward, true);
  });

  test(".markdown-only post-convergence delta suppresses a fresh Copilot round like .md (resolveConvergenceCarryForward)", () => {
    const md = resolveConvergenceCarryForward({ changedFiles: ["notes.md"] });
    const markdown = resolveConvergenceCarryForward({ changedFiles: ["changes.markdown"] });
    assert.equal(md.carryForward, true);
    assert.equal(markdown.carryForward, true);
    // .devloops stays a fresh-round trigger (config is in Copilot's surface):
    assert.equal(resolveConvergenceCarryForward({ changedFiles: [".devloops"] }).carryForward, false);
  });

  test("isDevLoopConfigSourcePath matches the config-source family and nothing else", () => {
    for (const p of [".devloops", ".devloops.yaml", ".devloops.yml", ".devloops.json", "sub/.devloops", ".pi/dev-loop/settings.yaml", ".pi/dev-loop/defaults.json", ".pi\\dev-loop\\settings.yaml", "packages/core/src/config/extension-defaults.yaml"]) {
      assert.equal(isDevLoopConfigSourcePath(p), true, p);
    }
    for (const p of ["package.json", "my.devloops", "docs/devloops.md", ".devloopsx", "packages/core/src/config/config.mjs", null]) {
      assert.equal(isDevLoopConfigSourcePath(p), false, String(p));
    }
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

  // Pin the case-drift lookup widening end to end at the decision seam this
  // function drives: a case-drifted MAPPED angle name (as might appear in a
  // prior findings-log entry) still carries forward on a delta provably
  // outside its surface — it must not fail closed to must-re-run just
  // because the recorded name's case drifted from the canonical one.
  test("a case-drifted mapped angle name carries forward on a non-implicating delta", () => {
    const { carried, mustRerun } = resolveCarryForwardAngles({
      prevAngles: ["Correctness"],
      changedFiles: ["docs/guide.md"],
    });
    assert.deepEqual(carried.map((c) => c.angle), ["Correctness"]);
    assert.deepEqual(mustRerun, []);
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
