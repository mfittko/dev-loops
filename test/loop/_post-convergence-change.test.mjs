import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGhStub } from "../_helpers.mjs";
import {
  detectPostConvergenceSignificantChange,
  getLatestSubmittedCopilotReviewHeadSha,
  isTrivialDocumentationOnlyPath,
} from "../../scripts/loop/_post-convergence-change.mjs";

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
