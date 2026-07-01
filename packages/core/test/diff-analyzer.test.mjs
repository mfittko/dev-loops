import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeT0,
  classifyFile,
  analyzeT1,
  analyzeDiff,
} from "../src/analysis/diff-analyzer.mjs";
import { resolveDynamicAngles } from "../src/analysis/change-classifier.mjs";

const DRAFT_ANGLES = [
  "scope", "coverage", "correctness", "ci-guard", "contract-surface",
  "input-validation", "determinism", "no-op", "link-check", "packaging-runtime",
  "state-concurrency", "config-drift", "gate-evidence", "pr-description", "pr-comments",
];

// ---------------------------------------------------------------------------
// classifyFile
// ---------------------------------------------------------------------------

test("classifyFile: docs for .md files", () => {
  assert.equal(classifyFile("docs/foo.md"), "docs");
  assert.equal(classifyFile("README.md"), "docs");
});

test("classifyFile: config for .yml/.yaml/.json", () => {
  assert.equal(classifyFile("package.json"), "config");
  assert.equal(classifyFile(".pi/dev-loop/settings.yaml"), "config");
});

test("classifyFile: test for .test.mjs and test/ paths", () => {
  assert.equal(classifyFile("packages/core/test/foo.test.mjs"), "test");
  assert.equal(classifyFile("test/loop/test.mjs"), "test");
});

test("classifyFile: code for .mjs/.js/.ts", () => {
  assert.equal(classifyFile("src/foo.mjs"), "code");
  assert.equal(classifyFile("scripts/bar.mjs"), "code");
});

test("classifyFile: ci for .github/ paths", () => {
  assert.equal(classifyFile(".github/workflows/verify.yml"), "ci");
});

test("classifyFile: unknown for unrecognized", () => {
  assert.equal(classifyFile("assets/logo.png"), "unknown");
});

// ---------------------------------------------------------------------------
// analyzeT0
// ---------------------------------------------------------------------------

test("analyzeT0: empty input", () => {
  const result = analyzeT0("");
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.extensions, []);
  assert.equal(result.renameOnly, false);
  assert.equal(result.allDocs, false);
});

test("analyzeT0: single modified file", () => {
  const result = analyzeT0("M\tsrc/foo.mjs");
  assert.deepEqual(result.files, ["src/foo.mjs"]);
  assert.deepEqual(result.extensions, [".mjs"]);
  assert.deepEqual(result.directories, ["src"]);
  assert.equal(result.renameOnly, false);
});

test("analyzeT0: rename-only diff", () => {
  const result = analyzeT0("R100\told.mjs\tnew.mjs\nR100\tsrc/a.ts\tsrc/b.ts");
  assert.equal(result.renameOnly, true);
  assert.equal(result.files.length, 2);
});

test("analyzeT0: all-docs diff", () => {
  const result = analyzeT0("M\tdocs/guide.md\nM\tREADME.md\nA\tdocs/api.md");
  assert.equal(result.allDocs, true);
});

test("analyzeT0: mixed extensions", () => {
  const result = analyzeT0("M\tsrc/foo.mjs\nM\tdocs/bar.md\nM\tpackage.json");
  assert.deepEqual(result.extensions, [".json", ".md", ".mjs"]);
  assert.deepEqual(result.directories, ["docs", "package.json", "src"]);
});

test("analyzeT0: handles Windows paths", () => {
  const result = analyzeT0("M\tsrc\\foo.mjs");
  assert.deepEqual(result.files, ["src/foo.mjs"]);
  assert.deepEqual(result.extensions, [".mjs"]);
});

// ---------------------------------------------------------------------------
// analyzeT1
// ---------------------------------------------------------------------------

test("analyzeT1: detects logic change from code additions", () => {
  const t0 = { files: ["src/foo.mjs"], extensions: [".mjs"], directories: ["src"], renameOnly: false, allDocs: false };
  const diff = "@@ -1,3 +1,5 @@\n import x from 'y';\n+const foo = 42;\n+export { foo };\n";
  const result = analyzeT1(diff, t0);
  assert.ok(result.changeCategories.includes("LOGIC_CHANGE"));
  assert.equal(result.hunkCount, 1);
});

test("analyzeT1: logic change from import-only diff (imports ARE logic)", () => {
  const t0 = { files: ["src/foo.mjs"], extensions: [".mjs"], directories: ["src"], renameOnly: false, allDocs: false };
  const diff = "@@ -1,1 +1,1 @@\n-import x from 'y';\n+import z from 'y';\n";
  const result = analyzeT1(diff, t0);
  assert.ok(result.changeCategories.includes("LOGIC_CHANGE"));
});

test("analyzeT1: renames with no content change", () => {
  const t0 = { files: ["src/bar.mjs"], extensions: [".mjs"], directories: ["src"], renameOnly: true, allDocs: false };
  const result = analyzeT1("", t0);
  assert.ok(result.changeCategories.includes("RENAME_ONLY"));
});

test("analyzeT1: docs-only from T0", () => {
  const t0 = { files: ["docs/x.md"], extensions: [".md"], directories: ["docs"], renameOnly: false, allDocs: true };
  const result = analyzeT1("", t0);
  assert.ok(result.changeCategories.includes("DOCS_ONLY"));
});

test("analyzeT1: config-only from T0", () => {
  const t0 = { files: ["package.json", ".pi/dev-loop/settings.yaml"], extensions: [".json", ".yaml"], directories: [".pi"], renameOnly: false, allDocs: false };
  const result = analyzeT1("", t0);
  assert.ok(result.changeCategories.includes("CONFIG_ONLY"));
});

test("analyzeT1: tracks line stats", () => {
  const t0 = { files: ["src/foo.mjs"], extensions: [".mjs"], directories: ["src"], renameOnly: false, allDocs: false };
  const diff = "@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n";
  const result = analyzeT1(diff, t0);
  assert.equal(result.lineStats.added, 2);
  assert.equal(result.lineStats.deleted, 1);
});
test("analyzeT1: detects COMMENT_ONLY from comment-only diff", () => {
  const t0 = { files: ["src/foo.mjs"], extensions: [".mjs"], directories: ["src"], renameOnly: false, allDocs: false };
  const diff = "@@ -1,3 +1,3 @@\n-// old comment\n+// new comment\n";
  const result = analyzeT1(diff, t0);
  assert.ok(result.changeCategories.includes("COMMENT_ONLY"));
  assert.ok(result.hunkCount > 0);
});


// ---------------------------------------------------------------------------
// analyzeDiff (combined)
// ---------------------------------------------------------------------------

test("analyzeDiff: T0 unambiguous → no T1, not ambiguous", () => {
  const result = analyzeDiff({ nameStatusOutput: "M\tdocs/guide.md\nM\tREADME.md" });
  assert.ok(result.t0.allDocs);
  assert.deepEqual(result.t1.changeCategories, ["DOCS_ONLY"]);
  assert.equal(result.ambiguous, false);
});

test("analyzeDiff: T0 ambiguous with diff + logic change → classified, not ambiguous", () => {
  const result = analyzeDiff({
    nameStatusOutput: "M\tsrc/foo.mjs\nM\tdocs/bar.md",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = 1;\n",
  });
  assert.ok(result.t1 !== null);
  assert.ok(result.t1.changeCategories.includes("LOGIC_CHANGE"));
  assert.equal(result.ambiguous, false); // LOGIC_CHANGE is now a classified category
});

test("analyzeDiff: T0 ambiguous with diff + no classifiable change → ambiguous", () => {
  // Mixed file categories (code + unknown asset) with a context-only hunk (no
  // added/deleted lines) yields no category → genuinely unclassifiable → fallback.
  const result = analyzeDiff({
    nameStatusOutput: "M\tsrc/foo.mjs\nM\tassets/logo.png",
    diffOutput: "@@ -1,1 +1,1 @@\n unchanged context line\n",
  });
  assert.deepEqual(result.t1.changeCategories, []);
  assert.equal(result.ambiguous, true);
});

test("analyzeDiff: T0 ambiguous without diff → no T1, ambiguous", () => {
  const result = analyzeDiff({ nameStatusOutput: "M\tsrc/foo.mjs\nM\tdocs/bar.md" });
  assert.deepEqual(result.t1.changeCategories, []);
  assert.equal(result.ambiguous, true);
});

test("analyzeDiff: rename-only → unambiguous", () => {
  const result = analyzeDiff({ nameStatusOutput: "R100\told.mjs\tnew.mjs" });
  assert.ok(result.t0.renameOnly);
  assert.equal(result.ambiguous, false);
});

test("analyzeDiff: pure code-only diff → LOGIC_CHANGE (not ambiguous, not fallback)", () => {
  // AC-1: a code-only change (touches no CI/packaging/docs/config surfaces) must
  // classify as LOGIC_CHANGE. An all-code diff has a single file category so
  // hunk-level T1 never runs — inferCategoriesFromT0 must still classify it.
  const result = analyzeDiff({
    nameStatusOutput: "M\tpackages/core/src/foo.mjs\nM\tpackages/core/src/bar.mjs",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = doThing();\n",
  });
  assert.deepEqual(result.t1.changeCategories, ["LOGIC_CHANGE"]);
  assert.equal(result.ambiguous, false);
});

test("analyzeDiff → resolveDynamicAngles: pure code-only resolves to core subset, not the full pool", () => {
  // End-to-end AC-1: the real analyzeDiff → resolveDynamicAngles path for a
  // pure-code diff must NOT fall back to all angles.
  const result = analyzeDiff({
    nameStatusOutput: "M\tpackages/core/src/foo.mjs",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = doThing();\n",
  });
  const dyn = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: result.t1.changeCategories,
    ambiguous: result.ambiguous,
  });
  assert.equal(dyn.fallbackToAll, false);
  for (const a of ["scope", "correctness", "coverage", "determinism", "contract-surface", "gate-evidence"]) {
    assert.ok(dyn.recommendedAngles.includes(a), `expected ${a} in core subset`);
  }
  assert.ok(dyn.recommendedAngles.length < DRAFT_ANGLES.length, `must be narrower than the full pool of ${DRAFT_ANGLES.length}`);
});

test("analyzeDiff: single code file with NO diffOutput still classifies LOGIC_CHANGE", () => {
  // The gate resolver may only have name-status. A code-only name-status must
  // still classify LOGIC_CHANGE rather than falling back to all angles.
  const result = analyzeDiff({ nameStatusOutput: "M\tpackages/core/src/foo.mjs" });
  assert.deepEqual(result.t1.changeCategories, ["LOGIC_CHANGE"]);
  assert.equal(result.ambiguous, false);
});

test("analyzeDiff: rename-only code file does NOT get LOGIC_CHANGE", () => {
  // Guard against over-classifying: a rename of a .mjs file is RENAME_ONLY, not
  // LOGIC_CHANGE, even though the file classifies as code.
  const result = analyzeDiff({ nameStatusOutput: "R100\tsrc/old.mjs\tsrc/new.mjs" });
  assert.deepEqual(result.t1.changeCategories, ["RENAME_ONLY"]);
});
