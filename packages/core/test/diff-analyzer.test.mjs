import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeT0,
  classifyFile,
  analyzeT1,
  analyzeDiff,
  diffHasSecuritySeam,
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

test("classifyFile: code/config/test extension under docs/ wins over docs prefix", () => {
  assert.equal(classifyFile("docs/example.mjs"), "code");
  assert.equal(classifyFile("docs/fixture.json"), "config");
  assert.equal(classifyFile("docs/x.test.mjs"), "test");
});

test("classifyFile: prose extensions under docs/ stay docs", () => {
  assert.equal(classifyFile("docs/foo.md"), "docs");
  assert.equal(classifyFile("docs/foo.html"), "docs");
  assert.equal(classifyFile("docs/foo.css"), "docs");
});

test("classifyFile: unknown for unrecognized", () => {
  assert.equal(classifyFile("assets/logo.png"), "unknown");
});

test("classifyFile: docs for .markdown files", () => {
  assert.equal(classifyFile("docs/guide.markdown"), "docs");
  assert.equal(classifyFile("CHANGELOG.markdown"), "docs");
});

test("classifyFile: config for allowlisted extensionless dotfiles", () => {
  assert.equal(classifyFile(".devloops"), "config");
  // Runtime-version dotfiles stay unknown (fail-closed): a .nvmrc bump must
  // re-run ci-guard/determinism, not carry their stale clean verdicts.
  assert.equal(classifyFile(".nvmrc"), "unknown");
  assert.equal(classifyFile(".ruby-version"), "unknown");
  assert.equal(classifyFile("packages/core/.nvmrc"), "unknown");
});

test("classifyFile: unrecognized extensionless dotfile stays unknown (no content sniffing)", () => {
  assert.equal(classifyFile(".env"), "unknown");
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

// #1336: security-sensitive seam detection.
const codeT0 = { files: ["scripts/loop/x.mjs"], extensions: [".mjs"], directories: ["scripts/loop"], renameOnly: false, allDocs: false };

test("analyzeT1: browser-automation seam yields SECURITY_SENSITIVE_SEAM", () => {
  const diff = "@@ -1,2 +1,3 @@\n const y = 1;\n+  await page.goto(appUrl);\n";
  const result = analyzeT1(diff, codeT0);
  assert.ok(result.changeCategories.includes("SECURITY_SENSITIVE_SEAM"));
});

test("analyzeT1: child_process/exec seam yields SECURITY_SENSITIVE_SEAM", () => {
  const diff = "@@ -1,2 +1,3 @@\n const y = 1;\n+  const out = execSync(`git log ${ref}`);\n";
  const result = analyzeT1(diff, codeT0);
  assert.ok(result.changeCategories.includes("SECURITY_SENSITIVE_SEAM"));
});

test("analyzeT1: untrusted fetch + destructive rm seams yield SECURITY_SENSITIVE_SEAM", () => {
  for (const line of ["+  const r = await fetch(url);", "+  await rm(dir, { recursive: true });", "+  await page.setInputFiles(sel, localPath);"]) {
    const diff = `@@ -1,2 +1,3 @@\n const y = 1;\n${line}\n`;
    assert.ok(analyzeT1(diff, codeT0).changeCategories.includes("SECURITY_SENSITIVE_SEAM"), `expected seam for: ${line}`);
  }
});

test("analyzeT1: ordinary logic change (no dangerous primitive) is NOT a seam", () => {
  const diff = "@@ -1,3 +1,5 @@\n import x from 'y';\n+const total = a + b;\n+export { total };\n";
  const result = analyzeT1(diff, codeT0);
  assert.ok(result.changeCategories.includes("LOGIC_CHANGE"));
  assert.ok(!result.changeCategories.includes("SECURITY_SENSITIVE_SEAM"));
});

test("seam: a comment/doc line that merely names a primitive is NOT a seam (gated on !isNonLogicLine)", () => {
  // #1336 fix: no over-triggering on prose/comment mentions of a primitive.
  assert.ok(!analyzeT1("@@ -1,1 +1,2 @@\n const y = 1;\n+// spawn( a child_process here\n", codeT0).changeCategories.includes("SECURITY_SENSITIVE_SEAM"));
  assert.ok(!analyzeT1("@@ -1,1 +1,2 @@\n const y = 1;\n+ * documents fetch( behavior\n", codeT0).changeCategories.includes("SECURITY_SENSITIVE_SEAM"));
});

test("analyzeDiff: PURE-CODE seam diff (no test/doc/config file) still triggers SECURITY_SENSITIVE_SEAM", () => {
  // #1336 fix: the most concentrated case (editing a browser/exec driver with no
  // mixed surface) previously skipped analyzeT1 entirely and missed the seam.
  const result = analyzeDiff({
    nameStatusOutput: "M\tscripts/loop/driver.mjs",
    diffOutput: "@@ -1,2 +1,3 @@\n const y = 1;\n+  await page.goto(appUrl);\n",
  });
  assert.equal(result.t0.files.length, 1);
  assert.ok(result.t1.changeCategories.includes("SECURITY_SENSITIVE_SEAM"), "pure-code seam must be detected");
});

test("analyzeDiff: pure-code NON-seam diff does not get SECURITY_SENSITIVE_SEAM", () => {
  const result = analyzeDiff({
    nameStatusOutput: "M\tscripts/loop/driver.mjs",
    diffOutput: "@@ -1,2 +1,3 @@\n const y = 1;\n+  const total = a + b;\n",
  });
  assert.ok(!result.t1.changeCategories.includes("SECURITY_SENSITIVE_SEAM"));
});

test("seam: a config/docs FILE hunk naming a primitive is NOT a seam; a code file IS (file-gated via diff headers)", () => {
  // #1336: a real git diff carries `+++ b/<path>` headers; only code files can
  // carry an executable seam. A yaml persona line with `shell: true` must not flag.
  const yamlSeamMention =
    "diff --git a/packages/core/src/config/extension-defaults.yaml b/packages/core/src/config/extension-defaults.yaml\n" +
    "--- a/packages/core/src/config/extension-defaults.yaml\n" +
    "+++ b/packages/core/src/config/extension-defaults.yaml\n" +
    "@@ -1,1 +1,2 @@\n prompt: review\n+      prompt: no shell: true and no child_process here\n";
  assert.equal(diffHasSecuritySeam(yamlSeamMention), false, "config/docs mention must not flag a seam");

  const codeSeam =
    "diff --git a/scripts/loop/driver.mjs b/scripts/loop/driver.mjs\n" +
    "--- a/scripts/loop/driver.mjs\n" +
    "+++ b/scripts/loop/driver.mjs\n" +
    "@@ -1,1 +1,2 @@\n const y = 1;\n+  await page.goto(appUrl);\n";
  assert.equal(diffHasSecuritySeam(codeSeam), true, "code-file seam must flag");
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

test("analyzeDiff: a docs/-hosted code file in a mixed diff is NOT docs-only", () => {
  // allDocs must track classifyFile: a code file under docs/ keeps the code
  // review surface even alongside a real prose doc — not suppressed as DOCS_ONLY.
  const result = analyzeDiff({
    nameStatusOutput: "M\tdocs/example.mjs\nM\tdocs/guide.md",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = 1;\n",
  });
  assert.equal(result.t0.allDocs, false);
  assert.ok(!(result.t1.changeCategories.length === 1 && result.t1.changeCategories[0] === "DOCS_ONLY"));
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

// ---------------------------------------------------------------------------
// Mixed-diff category unions (AC line 30: mixed logic+CI → core ∪ ci-guard)
// ---------------------------------------------------------------------------

test("analyzeDiff: mixed code+workflow diff unions CI_ONLY (presence, not exclusivity)", () => {
  // The exclusive _ONLY checks never fire on a mixed diff (some files are code),
  // so a code+workflow diff must still union the CI surface by presence.
  const result = analyzeDiff({
    nameStatusOutput: "M\tpackages/core/src/foo.mjs\nM\t.github/workflows/verify.yml",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = doThing();\n",
  });
  assert.ok(result.t1.changeCategories.includes("LOGIC_CHANGE"));
  assert.ok(result.t1.changeCategories.includes("CI_ONLY"));
  assert.equal(result.ambiguous, false);
});

test("analyzeDiff → resolveDynamicAngles: mixed logic+CI resolves to core ∪ ci-guard (AC line 30)", () => {
  const result = analyzeDiff({
    nameStatusOutput: "M\tpackages/core/src/foo.mjs\nM\t.github/workflows/verify.yml",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = doThing();\n",
  });
  const dyn = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: result.t1.changeCategories,
    ambiguous: result.ambiguous,
  });
  assert.equal(dyn.fallbackToAll, false);
  // core subset present …
  for (const a of ["scope", "correctness", "coverage", "determinism", "contract-surface"]) {
    assert.ok(dyn.recommendedAngles.includes(a), `expected ${a} in core subset`);
  }
  // … unioned with the CI-specific lens.
  assert.ok(dyn.recommendedAngles.includes("ci-guard"), "workflow file must pull ci-guard");
  // still narrower than the full pool (peripheral non-CI lenses stay dropped).
  assert.ok(dyn.recommendedAngles.includes("link-check") === false, "no docs → no link-check");
  assert.ok(dyn.recommendedAngles.length < DRAFT_ANGLES.length);
});

test("analyzeDiff → resolveDynamicAngles: mixed code+docs unions link-check, not ci-guard", () => {
  const result = analyzeDiff({
    nameStatusOutput: "M\tpackages/core/src/foo.mjs\nM\tdocs/guide.md",
    diffOutput: "@@ -1,1 +1,1 @@\n+const x = doThing();\n",
  });
  assert.ok(result.t1.changeCategories.includes("DOCS_ONLY"));
  const dyn = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: result.t1.changeCategories,
    ambiguous: result.ambiguous,
  });
  assert.ok(dyn.recommendedAngles.includes("link-check"), "docs file must pull link-check");
  assert.ok(dyn.recommendedAngles.includes("ci-guard") === false, "no workflow → no ci-guard");
});

test("analyzeDiff: pure single-surface diffs keep exclusive semantics (no over-union)", () => {
  // Presence-unioning must only apply to mixed (hunk-level) diffs; a pure CI or
  // pure docs diff still resolves to just its exclusive category.
  assert.deepEqual(
    analyzeDiff({ nameStatusOutput: "M\t.github/workflows/verify.yml" }).t1.changeCategories,
    ["CI_ONLY"],
  );
  assert.deepEqual(
    analyzeDiff({ nameStatusOutput: "M\tdocs/guide.md" }).t1.changeCategories,
    ["DOCS_ONLY"],
  );
});

test("analyzeDiff: .markdown-only diff → DOCS_ONLY", () => {
  // Root-level, NOT under docs/ — the extension rule alone must classify it
  // (the reported consumer shape is a root-level <branch>.markdown changelog).
  const result = analyzeDiff({ nameStatusOutput: "M\tCHANGELOG.markdown" });
  assert.equal(result.t0.allDocs, true);
  assert.deepEqual(result.t1.changeCategories, ["DOCS_ONLY"]);
});

test("analyzeDiff: .devloops-only diff → CONFIG_ONLY", () => {
  const result = analyzeDiff({ nameStatusOutput: "M\t.devloops" });
  assert.deepEqual(result.t1.changeCategories, ["CONFIG_ONLY"]);
});

test("analyzeDiff → resolveDynamicAngles: .devloops + .markdown repro classifies docs+config, no fallback (#1450)", () => {
  const result = analyzeDiff({
    nameStatusOutput: "M\t.devloops\nA\tfoo.markdown",
    diffOutput:
      "--- a/.devloops\n+++ b/.devloops\n@@ -1,1 +1,1 @@\n-old\n+new\n" +
      "--- /dev/null\n+++ b/foo.markdown\n@@ -0,0 +1,1 @@\n+# hi\n",
  });
  assert.equal(result.ambiguous, false);
  assert.ok(result.t1.changeCategories.includes("DOCS_ONLY"));
  assert.ok(result.t1.changeCategories.includes("CONFIG_ONLY"));

  const dyn = resolveDynamicAngles({
    configuredAngles: DRAFT_ANGLES,
    changeCategories: result.t1.changeCategories,
    ambiguous: result.ambiguous,
  });
  assert.equal(dyn.fallbackToAll, false);
  assert.ok(dyn.recommendedAngles.includes("link-check"), "docs file must pull link-check");
  assert.ok(dyn.recommendedAngles.includes("config-drift"), "config file must pull config-drift");
  // Pin the exact pruned set: a loose length check hid that the .devloops
  // hunk's -old/+new lines also emit LOGIC_CHANGE (analyzeT1's hasLogicChange
  // is not file-kind-gated), which pulls the code-review core alongside the
  // docs/config lenses. Any change to that behavior must surface here.
  assert.deepEqual(
    [...dyn.recommendedAngles].sort(),
    [
      "config-drift",
      "contract-surface",
      "correctness",
      "coverage",
      "determinism",
      "gate-evidence",
      "input-validation",
      "link-check",
      "pr-description",
      "scope",
    ],
  );
});
