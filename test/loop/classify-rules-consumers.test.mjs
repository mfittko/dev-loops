import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { classifyFile, compileClassifyRules } from "@dev-loops/core/analysis/diff-analyzer";
import {
  loadDevLoopConfig,
  resolveClassifyRules,
  resolveGateAnglesDynamic,
  resolveGateTier,
} from "@dev-loops/core/config";
import { resolveAngleCarryForward, resolveCarryForwardAngles, resolveConvergenceCarryForward } from "@dev-loops/core/loop/gate-carry-forward";

import { computeSizeBudget } from "../../scripts/loop/check-size-budget.mjs";
import { isNotableChange } from "../../scripts/docs/validate-changelog-completeness.mjs";
import { isTrivialDocumentationOnlyPath } from "../../scripts/loop/_post-convergence-change.mjs";
import { unitBudgetBasis } from "../../scripts/github/emit-fanout-dispatch.mjs";

// One `classify` fixture in a temporary directory drives every consumer entry
// point, so a consumer that forgets to pass the rules disagrees here.
const DEVLOOPS = `version: 1
classify:
  extensions:
    code: [".vue"]
    asset: [".avif"]
  paths:
    - pattern: "site/assets/**"
      kind: asset
    - pattern: "docs/app/**"
      kind: code
gates:
  draft:
    angles:
      - { name: scope, mandatory: true }
      - { name: asset-check, kinds: [asset] }
    tiers:
      - { name: assets, match: { kinds: [asset] }, angles: [asset-check] }
`;

async function withConfig(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "classify-rules-"));
  try {
    await writeFile(path.join(dir, ".devloops"), DEVLOOPS, "utf8");
    const { config, errors } = await loadDevLoopConfig({ repoRoot: dir });
    assert.deepEqual(errors, []);
    return await fn(config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const numstat = (entries) => entries.map(([a, d, p]) => `${a}\t${d}\t${p}`).join("\0") + "\0";

test("every classifyFile consumer agrees on a kind under the same classify rules", async () => {
  await withConfig(async (config) => {
    const rules = resolveClassifyRules(config);
    assert.equal(classifyFile("src/App.vue", rules), "code");
    assert.equal(classifyFile("site/assets/hero.jpg", rules), "asset");
    assert.equal(classifyFile("pics/a.avif", rules), "asset");

    // Size budget: a .vue file is source-like code, so its lines are measured
    // instead of reading as 100% unclassified.
    const vueDiff = "diff --git a/src/App.vue b/src/App.vue\n--- a/src/App.vue\n+++ b/src/App.vue\n@@ -1,1 +1,3 @@\n a\n+b();\n+c();\n";
    const withoutRules = computeSizeBudget({
      nameStatusOutput: "M\tsrc/App.vue\n", diffOutput: vueDiff, numstatOutput: numstat([[2, 0, "src/App.vue"]]),
    });
    assert.equal(withoutRules.outcome, "block");
    const withRules = computeSizeBudget({
      nameStatusOutput: "M\tsrc/App.vue\n", diffOutput: vueDiff, numstatOutput: numstat([[2, 0, "src/App.vue"]]), rules,
    });
    assert.equal(withRules.outcome, "pass");
    assert.equal(withRules.wholeLogicLoc, 2);

    // resolveGateTier and resolveGateAnglesDynamic read the rules from config.
    const facts = { changedFiles: ["site/assets/hero.jpg"], filesChanged: 1, linesChanged: 0 };
    const tier = resolveGateTier(config, "draft", facts);
    assert.equal(tier.tier, "assets");
    const dynamic = await resolveGateAnglesDynamic(config, "draft", {
      diff: { nameStatusOutput: "M\tsite/assets/hero.jpg\n", diffOutput: "diff --git a/site/assets/hero.jpg b/site/assets/hero.jpg\n--- a/site/assets/hero.jpg\n+++ b/site/assets/hero.jpg\n@@ -1 +1 @@\n-a\n+b\n" },
    });
    assert.ok(dynamic.recommendedAngles.includes("asset-check"));
    assert.ok(!dynamic.recommendedAngles.includes("correctness"));

    // Carry-forward: an asset file never carries, a docs-only delta still does.
    const surface = { kind: "kinds", kinds: new Set(["code"]) };
    const assetCarry = resolveAngleCarryForward({
      angle: "correctness", angleSurface: surface, changedFiles: ["site/assets/hero.jpg"], prevVerdict: "clean", rules,
    });
    assert.equal(assetCarry.carryForward, false);
    assert.match(assetCarry.reason, /asset file/);
    const vueCarry = resolveAngleCarryForward({
      angle: "correctness", angleSurface: { kind: "kinds", kinds: new Set(["docs"]) }, changedFiles: ["src/App.vue"], prevVerdict: "clean", rules,
    });
    assert.equal(vueCarry.carryForward, true);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["site/assets/hero.jpg"], rules }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["src/App.vue"], rules }).carryForward, false);
    assert.equal(resolveConvergenceCarryForward({ changedFiles: ["README.md"], rules }).carryForward, true);

    // Changelog notability, post-convergence docs check, fan-out unit budget.
    assert.equal(isNotableChange({ commitSubjects: [], files: ["src/App.vue"], rules }), true);
    assert.equal(isNotableChange({ commitSubjects: [], files: ["src/App.vue"] }), false);
    assert.equal(isTrivialDocumentationOnlyPath("docs/app/main.md", rules), false);
    assert.equal(isTrivialDocumentationOnlyPath("docs/app/main.md"), true);
    const blocks = [{ path: "docs/app/main.md", hunks: ["@@\n+x"] }, { path: "docs/other.md", hunks: ["@@\n+y"] }];
    const artifact = { angleScopes: { a: "docs-only" } };
    assert.equal(unitBudgetBasis(artifact, ["a"], blocks, rules).files, 1);
    assert.equal(unitBudgetBasis(artifact, ["a"], blocks).files, 2);
  });
});

test("asset handling in the size budget: zero logic LOC, tier pattern still blocks", () => {
  const nameStatusOutput = "M\tsite/app.js\nM\tsite/a.css\nM\tsite/i.html\nM\tsite/l.svg\n";
  const diffOutput = [
    "diff --git a/site/app.js b/site/app.js\n--- a/site/app.js\n+++ b/site/app.js\n@@ -1,1 +1,3 @@\n a\n+b();\n+c();\n",
    "diff --git a/site/a.css b/site/a.css\n--- a/site/a.css\n+++ b/site/a.css\n@@ -1,1 +1,2 @@\n a\n+b{}\n",
    "diff --git a/site/i.html b/site/i.html\n--- a/site/i.html\n+++ b/site/i.html\n@@ -1,1 +1,2 @@\n a\n+<p>\n",
    "diff --git a/site/l.svg b/site/l.svg\n--- a/site/l.svg\n+++ b/site/l.svg\n@@ -1,1 +1,2 @@\n a\n+<g/>\n",
  ].join("");
  const numstatOutput = numstat([[2, 0, "site/app.js"], [1, 0, "site/a.css"], [1, 0, "site/i.html"], [100, 0, "site/l.svg"]]);
  const mixed = computeSizeBudget({ nameStatusOutput, diffOutput, numstatOutput });
  assert.equal(mixed.outcome, "pass");
  assert.equal(mixed.wholeLogicLoc, 4);

  const svgOnly = computeSizeBudget({
    nameStatusOutput: "M\tsite/l.svg\n", diffOutput: "", numstatOutput: numstat([[100, 0, "site/l.svg"]]),
  });
  assert.equal(svgOnly.outcome, "pass");
  assert.equal(svgOnly.wholeLogicLoc, 0);

  const tiered = computeSizeBudget({
    nameStatusOutput: "M\tsite/l.svg\n", diffOutput: "", numstatOutput: numstat([[10, 0, "site/l.svg"]]),
    sizeConfig: { tiers: { t1: { patterns: ["site/*.svg"], sliceHardLoc: 100 } } },
  });
  assert.equal(tiered.outcome, "block");
  assert.ok(tiered.reasons.some((r) => /would silently drop to 0/.test(r)));
});

test("rules decide post-convergence triviality exactly as classifyFile does", () => {
  const rules = compileClassifyRules({ paths: [{ pattern: "notes/**", kind: "code" }, { pattern: "docs/App/**", kind: "code" }] });
  assert.equal(isTrivialDocumentationOnlyPath("notes/x.md", rules), false);
  assert.equal(isTrivialDocumentationOnlyPath("docs/App/x.md", rules), false);
  assert.equal(isTrivialDocumentationOnlyPath("docs/app/x.md", rules), true);
});

test("resolveCarryForwardAngles threads classify rules", () => {
  const rules = compileClassifyRules({ extensions: { docs: [".foo"] } });
  const run = (r) => resolveCarryForwardAngles({ prevAngles: ["correctness"], changedFiles: ["a.foo"], rules: r });
  assert.equal(run(rules).carried.length, 1);
  assert.equal(run(undefined).mustRerun.length, 1);
});

test("an asset-only diff with no tier selects the mandatory floor angles", async () => {
  const config = {
    version: 1,
    gates: { draft: { angles: [{ name: "scope", mandatory: true }, { name: "correctness", kinds: ["code"] }] } },
  };
  const rules = compileClassifyRules({ extensions: { asset: [".avif"] } });
  assert.ok(rules);
  const result = await resolveGateAnglesDynamic(
    { ...config, classify: { extensions: { asset: [".avif"] } } },
    "draft",
    { diff: { nameStatusOutput: "M\tpics/a.avif\n", diffOutput: "" } },
  );
  assert.ok(result.recommendedAngles.includes("scope"));
  assert.ok(!result.recommendedAngles.includes("correctness"));
});

test("a later config layer replaces classify extensions and paths as whole values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "classify-layers-"));
  try {
    await mkdir(path.join(dir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(path.join(dir, ".pi", "dev-loop", "defaults.yaml"), `version: 1
classify:
  extensions:
    code: [".vue"]
  paths:
    - { pattern: "a/**", kind: asset }
`, "utf8");
    await writeFile(path.join(dir, ".devloops"), `version: 1
classify:
  extensions:
    asset: [".avif"]
  paths:
    - { pattern: "b/**", kind: docs }
`, "utf8");
    const { config, errors } = await loadDevLoopConfig({ repoRoot: dir });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.classify.extensions, { asset: [".avif"] });
    assert.deepEqual(config.classify.paths, [{ pattern: "b/**", kind: "docs" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
