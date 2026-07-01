import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveLinkedIssuesFromPr,
  resolveLinkedIssueFromPr,
  loadRefinementArtifact,
} from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";

// AC/DoD body that detectIssueRefinementArtifact recognises as refined.
const REFINED_BODY = [
  "## Acceptance criteria",
  "- [ ] first",
  "- [ ] second",
  "- [ ] third",
].join("\n");

// Umbrella-style body: numbered "Required work" list, no ACs/DoD heading → not refined.
const UNREFINED_BODY = [
  "## Required work",
  "1. do #1019",
  "2. do #1050",
].join("\n");

// Write a fake `gh` on PATH that answers `gh issue view <n> --json body` from a
// number→body map. Missing entries exit non-zero (simulates a fetch failure).
async function writeIssueBodyGhStub(tempDir, bodiesByIssue) {
  const mapPath = path.join(tempDir, "issue-bodies.json");
  await writeFile(mapPath, JSON.stringify(bodiesByIssue), "utf8");
  const ghPath = path.join(tempDir, "gh");
  const script = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const map = JSON.parse(readFileSync(process.env.GH_BODIES_PATH, "utf8"));
const args = process.argv.slice(2);
const issue = args[args.indexOf("view") + 1];
if (!(issue in map)) { process.exit(1); }
process.stdout.write(JSON.stringify({ body: map[issue] }) + "\\n");
`;
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  return { ghCommand: ghPath, env: { ...process.env, GH_BODIES_PATH: mapPath } };
}

test("resolveLinkedIssuesFromPr: closingIssuesReferences with 3 entries returns all in order", () => {
  const prData = { closingIssuesReferences: [{ number: 1052 }, { number: 1019 }, { number: 1050 }] };
  assert.deepEqual(resolveLinkedIssuesFromPr(prData), [1052, 1019, 1050]);
});

test("resolveLinkedIssuesFromPr: body-only with 3 Closes lines returns 3 numbers in order", () => {
  const prData = { body: "Closes #1052\nFixes #1019\nResolves #1050" };
  assert.deepEqual(resolveLinkedIssuesFromPr(prData), [1052, 1019, 1050]);
});

test("resolveLinkedIssuesFromPr: single ref returns single-element array", () => {
  assert.deepEqual(resolveLinkedIssuesFromPr({ closingIssuesReferences: [{ number: 42 }] }), [42]);
  assert.deepEqual(resolveLinkedIssuesFromPr({ body: "Closes #42" }), [42]);
});

test("resolveLinkedIssuesFromPr: no refs returns empty array", () => {
  assert.deepEqual(resolveLinkedIssuesFromPr({ body: "no refs here" }), []);
  assert.deepEqual(resolveLinkedIssuesFromPr({}), []);
  assert.deepEqual(resolveLinkedIssuesFromPr(null), []);
});

test("resolveLinkedIssuesFromPr: duplicates collapsed, first-appearance order preserved", () => {
  assert.deepEqual(
    resolveLinkedIssuesFromPr({ closingIssuesReferences: [{ number: 5 }, { number: 5 }, { number: 7 }] }),
    [5, 7],
  );
  assert.deepEqual(
    resolveLinkedIssuesFromPr({ body: "Closes #5\nFixes #5\nResolves #7" }),
    [5, 7],
  );
});

test("resolveLinkedIssueFromPr: preserves exactly-one contract", () => {
  assert.equal(resolveLinkedIssueFromPr({ closingIssuesReferences: [{ number: 42 }] }), 42);
  assert.equal(resolveLinkedIssueFromPr({ closingIssuesReferences: [{ number: 1 }, { number: 2 }] }), null);
  assert.equal(resolveLinkedIssueFromPr({ body: "no refs" }), null);
});

test("loadRefinementArtifact: umbrella draft PR where 2 of 3 issues have ACs → present", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "umbrella-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const { ghCommand, env } = await writeIssueBodyGhStub(tempDir, {
    1052: UNREFINED_BODY,
    1019: REFINED_BODY,
    1050: REFINED_BODY,
  });
  const prData = { closingIssuesReferences: [{ number: 1052 }, { number: 1019 }, { number: 1050 }] };
  const result = await loadRefinementArtifact(
    { repo: "owner/repo", prData, prDraft: true, prClosed: false, prMerged: false },
    { env, ghCommand },
  );
  assert.equal(result.status, "present");
  assert.equal(result.finding, null);
  assert.deepEqual(result.linkedIssues, [1052, 1019, 1050]);
  assert.deepEqual(result.refinedIssues, [1019, 1050]);
  assert.equal(result.linkedIssue, 1019);
  assert.match(result.reason, /umbrella PR closes #1052, #1019, #1050/);
  assert.equal(result._onlyEnforcedWhenDraft, true);
});

test("loadRefinementArtifact: umbrella draft PR where NONE have ACs → missing", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "umbrella-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const { ghCommand, env } = await writeIssueBodyGhStub(tempDir, {
    1052: UNREFINED_BODY,
    1019: UNREFINED_BODY,
    1050: UNREFINED_BODY,
  });
  const prData = { closingIssuesReferences: [{ number: 1052 }, { number: 1019 }, { number: 1050 }] };
  const result = await loadRefinementArtifact(
    { repo: "owner/repo", prData, prDraft: true, prClosed: false, prMerged: false },
    { env, ghCommand },
  );
  assert.equal(result.status, "missing");
  assert.equal(result.finding, "missing_refinement_artifact");
  assert.deepEqual(result.refinedIssues, []);
  assert.equal(result._onlyEnforcedWhenDraft, true);
});

test("loadRefinementArtifact: umbrella draft PR where some fetches fail and no fetched issue is refined → missing", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "umbrella-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  // 1052 omitted → fetch fails (body null); 1019/1050 fetch but are unrefined.
  // allFailed is false (not every fetch failed), so this exercises the mixed
  // partial-failure branch, not the allFailed branch.
  const { ghCommand, env } = await writeIssueBodyGhStub(tempDir, {
    1019: UNREFINED_BODY,
    1050: UNREFINED_BODY,
  });
  const prData = { closingIssuesReferences: [{ number: 1052 }, { number: 1019 }, { number: 1050 }] };
  const result = await loadRefinementArtifact(
    { repo: "owner/repo", prData, prDraft: true, prClosed: false, prMerged: false },
    { env, ghCommand },
  );
  assert.equal(result.status, "missing");
  assert.equal(result.finding, "missing_refinement_artifact");
  assert.deepEqual(result.refinedIssues, []);
  assert.match(result.reason, /No linked issue \(#1052, #1019, #1050\) carries a refinement artifact/);
  assert.equal(result._onlyEnforcedWhenDraft, true);
});

test("loadRefinementArtifact: single-issue draft PR unchanged — present when refined", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "single-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const { ghCommand, env } = await writeIssueBodyGhStub(tempDir, { 42: REFINED_BODY });
  const prData = { closingIssuesReferences: [{ number: 42 }] };
  const result = await loadRefinementArtifact(
    { repo: "owner/repo", prData, prDraft: true, prClosed: false, prMerged: false },
    { env, ghCommand },
  );
  assert.equal(result.status, "present");
  assert.equal(result.linkedIssue, 42);
  assert.deepEqual(result.linkedIssues, [42]);
  // Single-issue reason is the raw artifact reason (no umbrella framing).
  assert.match(result.reason, /Acceptance criteria checklist item/);
});

test("loadRefinementArtifact: single-issue draft PR unchanged — missing when unrefined", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "single-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const { ghCommand, env } = await writeIssueBodyGhStub(tempDir, { 42: UNREFINED_BODY });
  const prData = { closingIssuesReferences: [{ number: 42 }] };
  const result = await loadRefinementArtifact(
    { repo: "owner/repo", prData, prDraft: true, prClosed: false, prMerged: false },
    { env, ghCommand },
  );
  assert.equal(result.status, "missing");
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("loadRefinementArtifact: no linked issue on draft PR → missing (unchanged)", async () => {
  const result = await loadRefinementArtifact(
    { repo: "owner/repo", prData: { body: "no refs" }, prDraft: true, prClosed: false, prMerged: false },
    { env: process.env, ghCommand: "gh" },
  );
  assert.equal(result.status, "missing");
  assert.equal(result.finding, "missing_refinement_artifact");
  assert.equal(result.linkedIssue, null);
});

test("loadRefinementArtifact: non-draft open PR is informational only (does not fetch)", async () => {
  const result = await loadRefinementArtifact(
    {
      repo: "owner/repo",
      prData: { closingIssuesReferences: [{ number: 1052 }, { number: 1019 }, { number: 1050 }] },
      prDraft: false,
      prClosed: false,
      prMerged: false,
    },
    // ghCommand deliberately invalid: informational branch must not shell out.
    { env: process.env, ghCommand: "/nonexistent/gh" },
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.linkedIssue, null);
  assert.deepEqual(result.linkedIssues, [1052, 1019, 1050]);
});
