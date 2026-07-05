import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGhStub } from "../_helpers.mjs";
import {
  detectPostConvergenceSignificantChange,
  getLatestSubmittedCopilotReviewHeadSha,
  isCommentOnlyFileChange,
  isTrivialDocumentationOnlyPath,
} from "../../scripts/loop/_post-convergence-change.mjs";

// Minimal unified-diff patch builder: each line carries its diff marker —
// `+` (added), `-` (removed), or a leading space (context line).
function patchOf(...lines) {
  return ["@@ -1,3 +1,3 @@", ...lines].join("\n");
}

const COPILOT = "copilot-pull-request-reviewer[bot]";

// One submitted Copilot review on "oldsha"; current head "newsha" → the detector
// reaches the compare call unless an earlier fail-closed guard trips.
function baseInput(overrides = {}) {
  return {
    repo: "owner/repo",
    pr: 17,
    currentHeadSha: "newsha",
    reviews: [{ author: { login: COPILOT }, state: "COMMENTED", submittedAt: "2026-06-02T10:00:00Z", commit: { oid: "oldsha" } }],
    changedFiles: [{ path: "packages/core/src/loop/x.mjs" }],
    roundCapReached: true,
    regularCopilotRounds: true,
    ...overrides,
  };
}

// Runs the detector with a single mocked `gh` compare response.
async function runWithCompare(compareEntry, overrides = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pcc-"));
  try {
    const { env } = await writeGhStub(tempDir, [compareEntry]);
    return await detectPostConvergenceSignificantChange(baseInput(overrides), { env, ghCommand: "gh" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// --- fail-closed guards that short-circuit BEFORE any gh call (no stub) ---

test("returns false when roundCapReached is false", async () => {
  assert.equal(await detectPostConvergenceSignificantChange(baseInput({ roundCapReached: false })), false);
});

test("returns false when regularCopilotRounds is false", async () => {
  assert.equal(await detectPostConvergenceSignificantChange(baseInput({ regularCopilotRounds: false })), false);
});

test("returns false when changedFiles is empty", async () => {
  assert.equal(await detectPostConvergenceSignificantChange(baseInput({ changedFiles: [] })), false);
});

test("returns false (fail closed, no gh call) when currentHeadSha is missing", async () => {
  // No gh stub on PATH: if this reached the compare call it would throw ENOENT,
  // so a clean `false` proves the guard short-circuits before spawning gh.
  assert.equal(await detectPostConvergenceSignificantChange(baseInput({ currentHeadSha: null })), false);
});

test("returns false when the last reviewed head equals the current head (same-head guard, no gh call)", async () => {
  assert.equal(await detectPostConvergenceSignificantChange(baseInput({
    reviews: [{ author: { login: COPILOT }, state: "COMMENTED", submittedAt: "2026-06-02T10:00:00Z", commit: { oid: "newsha" } }],
  })), false);
});

test("returns false when there is no submitted Copilot review to compare against (no gh call)", async () => {
  assert.equal(await detectPostConvergenceSignificantChange(baseInput({ reviews: [] })), false);
});

// --- fail-closed guards around the gh compare call ---

test("returns false when the gh compare command exits non-zero (fail closed)", async () => {
  // Payload WOULD be significant if parsed — only the exit-code guard keeps it false.
  assert.equal(await runWithCompare({ exitCode: 1, stdout: JSON.stringify({ files: [{ filename: "a.mjs", changes: 670 }] }) }), false);
});

test("returns false when the gh compare stdout is unparseable", async () => {
  assert.equal(await runWithCompare({ stdout: "not json{" }), false);
});

test("returns false when the compare returns an empty files list", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [] }) }), false);
});

// --- significance criteria ---

test("returns false for doc-only changes", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "docs/guide.md", changes: 500 },
    { filename: "README.md", changes: 40 },
  ] }) }), false);
});

test("threshold: 19 changed lines in a single non-doc file → false", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [{ filename: "a.mjs", changes: 19 }] }) }), false);
});

test("threshold: 20 changed lines in a single non-doc file → true", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [{ filename: "a.mjs", changes: 20 }] }) }), true);
});

test("threshold: 2 non-doc files each below 20 lines → true (files>=2 arm)", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "a.mjs", changes: 3 },
    { filename: "b.mjs", changes: 5 },
  ] }) }), true);
});

test("threshold: 1 non-doc file below 20 lines → false", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [{ filename: "a.mjs", changes: 5 }] }) }), false);
});

test("additions/deletions fallback aggregates when file.changes is non-finite", async () => {
  // changes absent → sum additions+deletions = 25 ≥ 20 → true
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [{ filename: "a.mjs", additions: 15, deletions: 10 }] }) }), true);
  // changes present but small; single file, no files>=2 → false
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [{ filename: "a.mjs", additions: 3, deletions: 1 }] }) }), false);
});

// --- content-aware significance filter (#1137) ---

test("comment-only .mjs change (every changed line blank/comment) → NOT significant", async () => {
  // 40 changed lines, but all are JSDoc/inline comments → filtered out before thresholds.
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/loop/foo.mjs", changes: 40, patch: patchOf(
      "+// tweak the wording",
      "-// old wording",
      "+/*",
      "+ * jsdoc continuation",
      "+ */",
      "+",
    ) },
  ] }) }), false);
});

test("mixed change (one real code line among comments) → significant", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/loop/foo.mjs", changes: 20, patch: patchOf(
      "+// a comment",
      "+const x = compute(); // note",
    ) },
  ] }) }), true);
});

test("patch field MISSING on a non-doc code file → significant (fail toward review)", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/loop/foo.mjs", changes: 40 },
  ] }) }), true);
});

test("multi-file: 2 files both comment-only → NOT significant", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "a.mjs", changes: 30, patch: patchOf("+// a", "-// b") },
    { filename: "b.ts", changes: 30, patch: patchOf("+// c", "-// d") },
  ] }) }), false);
});

test("multi-file: one comment-only + one small code file → NOT significant (only 1 code file <20 remains)", async () => {
  // The comment-only file is filtered out; the surviving code file has <20 lines
  // and is the only remaining file, so neither the size nor files>=2 gate trips.
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "comments.mjs", changes: 30, patch: patchOf("+// a", "-// b") },
    { filename: "code.mjs", changes: 5, patch: patchOf("+const x = 1;") },
  ] }) }), false);
});

test("multi-file: one comment-only + one large code file (>=20) → significant", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "comments.mjs", changes: 30, patch: patchOf("+// a", "-// b") },
    { filename: "code.mjs", changes: 25, patch: patchOf("+const x = doWork();") },
  ] }) }), true);
});

// --- block-comment state machine (draft-gate must-fix) ---

test("generator method rename (`*items()` → `*entries()`) → significant (bare * outside a block is CODE)", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/store.mjs", changes: 25, patch: patchOf(
      " class Store {",
      "-  *items() {",
      "+  *entries() {",
      "     yield 1;",
      " }",
    ) },
  ] }) }), true); // significant: reopen expected
});

test("genuine block-comment body change with opener visible in patch → NOT significant", async () => {
  // Context lines carry the `/**` opener and `*/` closer; the changed `*` lines
  // are inside the observed open block → comment-only.
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/store.mjs", changes: 40, patch: patchOf(
      " /**",
      "- * old wording",
      "+ * new wording",
      "  */",
    ) },
  ] }) }), false);
});

test("`*`-leading changed line with NO opener in the patch → significant (conservative)", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/math.mjs", changes: 25, patch: patchOf("+  * b") },
  ] }) }), true);
});

test("`+++counter;` content line (added `++counter;`) → significant (no header-skip on compare patches)", async () => {
  assert.equal(await runWithCompare({ stdout: JSON.stringify({ files: [
    { filename: "packages/core/src/count.mjs", changes: 25, patch: patchOf("+++counter;") },
  ] }) }), true);
});

// --- isCommentOnlyFileChange unit edges ---

test("isCommentOnlyFileChange: conservative edges", () => {
  // all comments/blank (block opener observed → `*` continuation is comment) → true
  assert.equal(isCommentOnlyFileChange({ filename: "x.ts", patch: patchOf("+// hi", "-/* bye", "+ * cont", "+ */", "+") }), true);
  // mixed code+comment on one line → false
  assert.equal(isCommentOnlyFileChange({ filename: "x.ts", patch: patchOf("+foo(); // note") }), false);
  // missing patch → false (treated as code)
  assert.equal(isCommentOnlyFileChange({ filename: "x.ts" }), false);
  // un-classifiable extension → false
  assert.equal(isCommentOnlyFileChange({ filename: "x.py", patch: patchOf("+# comment") }), false);
  // Documented string-literal ceiling: a changed line INSIDE a multi-line
  // template literal that literally starts with `//` is mis-read as a comment,
  // so the change classifies comment-only even though it edits real string
  // content. Accepted, documented trade-off (the classifier only sees line
  // prefixes; context lines — here the template-literal delimiters — are never
  // classified). This assertion locks the ceiling's actual semantics.
  assert.equal(isCommentOnlyFileChange({ filename: "x.mjs", patch: patchOf(
    " const banner = `",
    "-// generated by v1 — do not edit",
    "+// generated by v2 — do not edit",
    " `;",
  ) }), true);
  // no parseable changed lines (context only) → false (ambiguous → code)
  assert.equal(isCommentOnlyFileChange({ filename: "x.mjs", patch: "@@ -1,1 +1,1 @@\n unchanged context" }), false);
});

// --- helper units ---

test("getLatestSubmittedCopilotReviewHeadSha picks the latest submitted head by timestamp", () => {
  const sha = getLatestSubmittedCopilotReviewHeadSha([
    { author: { login: COPILOT }, state: "COMMENTED", submittedAt: "2026-06-02T08:00:00Z", commit: { oid: "early" } },
    { author: { login: COPILOT }, state: "COMMENTED", submittedAt: "2026-06-02T12:00:00Z", commit: { oid: "late" } },
  ]);
  assert.equal(sha, "late");
});

test("getLatestSubmittedCopilotReviewHeadSha tie-break: a valid timestamp beats a missing one; PENDING/non-Copilot ignored", () => {
  const sha = getLatestSubmittedCopilotReviewHeadSha([
    { author: { login: COPILOT }, state: "COMMENTED", commit: { oid: "no-timestamp" } },
    { author: { login: COPILOT }, state: "COMMENTED", submittedAt: "2026-06-02T09:00:00Z", commit: { oid: "dated" } },
    { author: { login: COPILOT }, state: "PENDING", submittedAt: "2026-06-02T23:00:00Z", commit: { oid: "pending" } },
    { author: { login: "someone-else" }, state: "COMMENTED", submittedAt: "2026-06-02T23:00:00Z", commit: { oid: "human" } },
  ]);
  assert.equal(sha, "dated");
});

test("isTrivialDocumentationOnlyPath classifies docs and text extensions as trivial", () => {
  for (const p of ["docs/x.mjs", "README.md", "a.mdx", "notes.txt", "x.rst", "y.adoc", "", null, undefined]) {
    assert.equal(isTrivialDocumentationOnlyPath(p), true, `${p} should be trivial`);
  }
  for (const p of ["packages/core/src/a.mjs", "scripts/loop/x.mjs", "test/a.test.mjs"]) {
    assert.equal(isTrivialDocumentationOnlyPath(p), false, `${p} should be non-trivial`);
  }
});
