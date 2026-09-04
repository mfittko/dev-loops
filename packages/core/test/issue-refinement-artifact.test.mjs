import assert from "node:assert/strict";
import test from "node:test";

import {
  MALFORMED_AC_DOD_MATRIX_FINDING,
  MISSING_AC_DOD_MATRIX_FINDING,
  MISSING_EXPLICIT_NON_GOALS_FINDING,
  REFINEMENT_SOURCE,
  decideEnqueueRefinementGate,
  detectAcDodMatrix,
  detectIssueRefinementArtifact,
  detectLinkedRefinementDoc,
  detectGrillMarker,
  detectGrillEmbedHeading,
  derivePrChecklistsFromIssueMatrix,
  extractChecklistItems,
  extractPrBodyUncheckedChecklistItems,
  extractUncheckedChecklistItems,
  parseMarkdownSections,
  summarizeRefinementGateCheck,
} from "../src/loop/issue-refinement-artifact.mjs";

// #1866: a refined tracker-backed issue body carries an explicit Non-goals
// section (loop-grill / artifact-authority contract). Fixture suffix shared by
// every "artifact present" fixture below.
const NGOALS = "\n\n## Non-goals\n\n- None beyond the stated scope.\n";
// #1951: the refinement floor is the authoritative AC→DoD mapping MATRIX (a
// two-column semantic table), not duplicate issue-side checklists. Every
// "matrix present" fixture pairs the matrix with Non-goals.
const MATRIX = [
  "",
  "## AC / DoD matrix",
  "",
  "| Criterion outcome | Required completion evidence |",
  "|---|---|",
  "| AC1 — the feature works end to end | D1 — a focused test proves the feature works |",
  "| AC2 — the edge case is handled | D2 — a regression test pins the edge case |",
  "",
].join("\n");

test("parseMarkdownSections returns heading boundaries", () => {
  const sections = parseMarkdownSections("## Problem\n\nText.\n\n## Acceptance criteria\n\n- [ ] AC1\n");
  assert.deepEqual(
    sections.map((s) => ({ name: s.name, level: s.level, itemCount: extractChecklistItems(s.bodyLines.join("\n")).length })),
    [
      { name: "Problem", level: 2, itemCount: 0 },
      { name: "Acceptance criteria", level: 2, itemCount: 1 },
    ],
  );
});

// ---------------------------------------------------------------------------
// #1951: AC→DoD mapping-matrix detection (detectAcDodMatrix)
// ---------------------------------------------------------------------------

test("detectAcDodMatrix finds a valid semantic mapping table under a matrix heading", () => {
  const m = detectAcDodMatrix("## Problem\n\nX\n" + MATRIX);
  assert.equal(m.found, true);
  assert.equal(m.valid, true);
  assert.equal(m.rowCount, 2);
  assert.deepEqual(m.rows.map((r) => r.criterion), [
    "AC1 — the feature works end to end",
    "AC2 — the edge case is handled",
  ]);
});

test("detectAcDodMatrix recognizes a criterion/evidence table with no matrix heading", () => {
  const body = [
    "## Details", "",
    "| Acceptance criterion | Completion evidence |",
    "|---|---|",
    "| the parser rejects bad input | a negative test covers the bad input |",
    "",
  ].join("\n");
  const m = detectAcDodMatrix(body);
  assert.equal(m.found, true);
  assert.equal(m.valid, true);
});

test("detectAcDodMatrix reports found+invalid for an identifier-only/tautological table", () => {
  const body = [
    "## AC / DoD matrix", "",
    "| AC | DoD |",
    "|---|---|",
    "| AC1 | D1 |",
    "| AC2 | D2 |",
    "",
  ].join("\n");
  const m = detectAcDodMatrix(body);
  assert.equal(m.found, true);
  assert.equal(m.valid, false);
  assert.match(m.reason, /identifier-only|tautological/);
});

test("detectAcDodMatrix reports found+invalid for a header/separator-only (empty) table", () => {
  const body = "## AC → DoD mapping\n\n| Criterion | Evidence |\n|---|---|\n";
  const m = detectAcDodMatrix(body);
  assert.equal(m.found, true);
  assert.equal(m.valid, false);
  assert.match(m.reason, /empty/);
});

test("detectAcDodMatrix reports not-found when no qualifying table exists", () => {
  const m = detectAcDodMatrix("## Problem\n\nprose only, no table\n");
  assert.equal(m.found, false);
  assert.equal(m.valid, false);
});

test("detectAcDodMatrix ignores an unrelated (non-criterion/evidence) table", () => {
  const body = [
    "## Config", "",
    "| Old key | New key |",
    "|---|---|",
    "| queue.board | tracker.board |",
    "",
  ].join("\n");
  const m = detectAcDodMatrix(body);
  assert.equal(m.found, false);
});

test("detectAcDodMatrix skips a fenced table (anti-spoof)", () => {
  const body = [
    "## AC / DoD matrix", "",
    "```",
    "| Criterion outcome | Required completion evidence |",
    "|---|---|",
    "| AC1 — real work | D1 — a test |",
    "```",
    "",
  ].join("\n");
  const m = detectAcDodMatrix(body);
  assert.equal(m.found, false);
});

// ---------------------------------------------------------------------------
// #1951: derivePrChecklistsFromIssueMatrix (PR projection)
// ---------------------------------------------------------------------------

test("derivePrChecklistsFromIssueMatrix projects list-form AC/DoD checklists from the matrix (no table, no cell checkboxes)", () => {
  const { acChecklist, dodChecklist, markdown } = derivePrChecklistsFromIssueMatrix({
    body: "## Problem\n\nX\n" + MATRIX,
  });
  assert.deepEqual(acChecklist, [
    "AC1 — the feature works end to end",
    "AC2 — the edge case is handled",
  ]);
  assert.deepEqual(dodChecklist, [
    "D1 — a focused test proves the feature works",
    "D2 — a regression test pins the edge case",
  ]);
  // List-form checkboxes, never a table, never a checkbox inside a table cell.
  assert.match(markdown, /## Acceptance criteria\n\n- \[ \] AC1 —/);
  assert.match(markdown, /## Definition of done\n\n- \[ \] D1 —/);
  assert.doesNotMatch(markdown, /\|/);
});

test("derivePrChecklistsFromIssueMatrix accepts a pre-parsed matrix", () => {
  const matrix = detectAcDodMatrix("## Problem\n\nX\n" + MATRIX);
  const { acChecklist } = derivePrChecklistsFromIssueMatrix({ matrix });
  assert.equal(acChecklist.length, 2);
});

test("derivePrChecklistsFromIssueMatrix fails closed on a missing/malformed matrix", () => {
  assert.throws(
    () => derivePrChecklistsFromIssueMatrix({ body: "## Problem\n\nno table\n" }),
    (err) => err.code === "MALFORMED_MATRIX_SOURCE",
  );
  assert.throws(
    () => derivePrChecklistsFromIssueMatrix({ body: "## AC / DoD matrix\n\n| AC | DoD |\n|---|---|\n| AC1 | D1 |\n" }),
    (err) => err.code === "MALFORMED_MATRIX_SOURCE",
  );
});

// ---------------------------------------------------------------------------
// #1951: detectIssueRefinementArtifact matrix floor
// ---------------------------------------------------------------------------

test("detectIssueRefinementArtifact returns missing for prose-only bodies", () => {
  const result = detectIssueRefinementArtifact({ body: "## Problem\n\nNo ACs.\n\n## Root Cause\n\nBug.\n\n## Fix\n\nCode." });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.finding, "missing_refinement_artifact");
  assert.deepEqual(result.acItems, []);
  assert.deepEqual(result.dodItems, []);
});

test("detectIssueRefinementArtifact passes a valid matrix + Non-goals (no issue-side checklists required)", () => {
  const result = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX + NGOALS });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_MATRIX);
  assert.equal(result.finding, null);
  // acItems/dodItems are projected from the matrix rows for downstream consumers.
  assert.deepEqual(result.acItems, [
    "AC1 — the feature works end to end",
    "AC2 — the edge case is handled",
  ]);
  assert.deepEqual(result.dodItems, [
    "D1 — a focused test proves the feature works",
    "D2 — a regression test pins the edge case",
  ]);
});

test("#1951 AC2: AC content + DoD content + Non-goals but NO matrix fails closed with missing_ac_dod_matrix", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Definition of done\n\n- [ ] DoD1\n" + NGOALS,
  });
  assert.equal(result.hasACs, false);
  assert.equal(result.finding, MISSING_AC_DOD_MATRIX_FINDING);
  assert.match(result.reason, /mapping matrix/);
  // The parser still extracts the checklist content (migration: readable).
  assert.deepEqual(result.acItems, ["AC1"]);
  assert.deepEqual(result.dodItems, ["DoD1"]);
});

test("#1951 AC2: a malformed/identifier-only matrix fails closed with malformed_ac_dod_matrix", () => {
  const body = [
    "## AC / DoD matrix", "",
    "| AC | DoD |",
    "|---|---|",
    "| AC1 → D1 | |",
    "",
  ].join("\n") + NGOALS;
  const result = detectIssueRefinementArtifact({ body });
  assert.equal(result.hasACs, false);
  assert.equal(result.finding, MALFORMED_AC_DOD_MATRIX_FINDING);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_MATRIX);
});

test("#1951: a valid matrix without an explicit Non-goals section fails closed with missing_explicit_non_goals", () => {
  const result = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_MATRIX);
  assert.equal(result.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
});

test("#1951: interactive issue-side checklists alongside the matrix do not change the pass, and take precedence for acItems", () => {
  const body = [
    "## Acceptance criteria", "", "- [ ] AC1 checklist item", "",
    "## Definition of done", "", "- [ ] DoD1 checklist item", "",
  ].join("\n") + MATRIX + NGOALS;
  const result = detectIssueRefinementArtifact({ body });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_MATRIX);
  assert.equal(result.finding, null);
  // Present checklists take precedence over matrix projection for acItems/dodItems.
  assert.deepEqual(result.acItems, ["AC1 checklist item"]);
  assert.deepEqual(result.dodItems, ["DoD1 checklist item"]);
});

test("detectIssueRefinementArtifact detects a linked refinement doc path (a complete artifact on its own)", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\nSee `tmp/refinement/532-plan.md` for the matrix.\n" + NGOALS,
    issueNumber: 532,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.LINKED_DOC);
  assert.equal(result.linkedDoc.found, true);
  assert.equal(result.linkedDoc.path, "tmp/refinement/532-plan.md");
});

test("detectIssueRefinementArtifact rejects a Refinement section without explicit path", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Refinement\n\nA plan lives here.\n",
    issueNumber: 527,
  });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.linkedDoc.found, false);
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("detectIssueRefinementArtifact returns finding for empty body", () => {
  const result = detectIssueRefinementArtifact({ body: "" });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("detectLinkedRefinementDoc finds explicit tmp/refinement path", () => {
  const linked = detectLinkedRefinementDoc("See `tmp/refinement/532-plan.md` for ACs.");
  assert.equal(linked.found, true);
  assert.equal(linked.path, "tmp/refinement/532-plan.md");
});

// ---------------------------------------------------------------------------
// summarizeRefinementGateCheck (draft-gate wrapper)
// ---------------------------------------------------------------------------

test("summarizeRefinementGateCheck maps to clean verdict when the matrix + Non-goals are present", () => {
  const summary = summarizeRefinementGateCheck({ body: "## Problem\n\nX\n" + MATRIX + NGOALS });
  assert.equal(summary.verdict, "clean");
  assert.equal(summary.finding, null);
  assert.equal(summary.blocking, false);
});

test("summarizeRefinementGateCheck blocks when the mapping matrix is missing", () => {
  const summary = summarizeRefinementGateCheck({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Definition of done\n\n- [ ] done\n" + NGOALS,
  });
  assert.equal(summary.verdict, "blocked");
  assert.equal(summary.finding, MISSING_AC_DOD_MATRIX_FINDING);
  assert.equal(summary.blocking, true);
});

test("summarizeRefinementGateCheck maps to blocked verdict when artifact missing", () => {
  const summary = summarizeRefinementGateCheck({ body: "## Problem\n\nX\n" });
  assert.equal(summary.verdict, "blocked");
  assert.equal(summary.finding, "missing_refinement_artifact");
  assert.equal(summary.blocking, true);
});

// ---------------------------------------------------------------------------
// decideEnqueueRefinementGate
// ---------------------------------------------------------------------------

test("decideEnqueueRefinementGate enqueues a matrix-refined issue into the pickup column", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX + NGOALS });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
});

test("decideEnqueueRefinementGate enqueues a linked-doc-only refined issue into the pickup column", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Plan\n\nSee tmp/refinement/10-plan.md for details.\n" + NGOALS,
  });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
});

test("#1951 enqueue gate: a checklist-only issue (no matrix) blocks naming the missing mapping matrix", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Definition of done\n\n- [ ] DoD1\n" + NGOALS,
  });
  assert.equal(artifact.finding, MISSING_AC_DOD_MATRIX_FINDING);
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /mapping matrix/);
  assert.doesNotMatch(decision.reason, /no refinement artifact/);
  assert.deepEqual(decision.missing, ["AC→DoD mapping matrix"]);

  const diverted = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: true });
  assert.equal(diverted.action, "divert");
  assert.deepEqual(diverted.missing, ["AC→DoD mapping matrix"]);
});

test("#1951 enqueue gate: a malformed matrix blocks naming the valid mapping matrix", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## AC / DoD matrix\n\n| AC | DoD |\n|---|---|\n| AC1 | D1 |\n" + NGOALS,
  });
  assert.equal(artifact.finding, MALFORMED_AC_DOD_MATRIX_FINDING);
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /malformed|identifier-only|tautological/);
  assert.deepEqual(decision.missing, ["valid AC→DoD mapping matrix"]);
});

test("decideEnqueueRefinementGate blocks an un-refined issue targeting pickup interactively", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /loop-grill/);
  assert.deepEqual(decision.missing, [
    "AC→DoD mapping matrix (a two-column table)",
    "explicit Non-goals section",
    "linked refinement doc",
  ]);
});

test("decideEnqueueRefinementGate diverts an un-refined issue targeting pickup headlessly", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: true });
  assert.equal(decision.action, "divert");
  assert.match(decision.reason, /loop-grill/);
  assert.ok(decision.missing.length > 0);
});

test("decideEnqueueRefinementGate enqueues an un-refined issue when the target isn't the pickup column", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: false, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
});

test("#1951 the generic no-artifact reason states the matrix floor (doc-alone alternative kept)", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /AC→DoD mapping matrix/);
  assert.match(decision.reason, /complete artifact on its own/);
});

// ---------------------------------------------------------------------------
// #1866: Non-goals required (matrix present but Non-goals absent)
// ---------------------------------------------------------------------------

test("#1866 fails closed when a matrix-bearing issue lacks an explicit Non-goals section", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX });
  assert.equal(artifact.hasACs, false);
  assert.equal(artifact.hasNonGoals, false);
  assert.equal(artifact.source, REFINEMENT_SOURCE.ISSUE_BODY_MATRIX);
  assert.equal(artifact.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
  assert.match(artifact.reason, /Non-goals/);
});

test("#1866 fail-closed propagates: decideEnqueueRefinementGate blocks a Non-goals miss", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /Non-goals/);
  assert.deepEqual(decision.missing, ["explicit Non-goals section"]);

  const diverted = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: true });
  assert.equal(diverted.action, "divert");
  assert.deepEqual(diverted.missing, ["explicit Non-goals section"]);
});

test("#1866 rejects an empty Non-goals section (heading only, or fenced-only body)", () => {
  const headingOnly = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX + "\n## Non-goals\n" });
  assert.equal(headingOnly.hasACs, false);
  assert.equal(headingOnly.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);

  const fencedOnly = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" + MATRIX + "\n## Non-goals\n\n```\n- [ ] spoof\n```\n" });
  assert.equal(fencedOnly.hasACs, false);
  assert.equal(fencedOnly.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
});

test("#1866 accepts 'out of scope' as an explicit non-goals heading (shared patterns)", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n" + MATRIX + "\n## Out of scope\n\n- everything else\n",
  });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.finding, null);
});

test("#1866 a linked refinement doc counts only when it resolves (resolveLinkedDoc)", () => {
  const body = "## Plan\n\nSee tmp/refinement/532-plan.md for details.\n" + NGOALS;
  const unresolved = detectIssueRefinementArtifact({
    body,
    issueNumber: 532,
    resolveLinkedDoc: () => false,
  });
  assert.equal(unresolved.hasACs, false);
  assert.equal(unresolved.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(unresolved.finding, "missing_refinement_artifact");
  assert.equal(unresolved.linkedDoc.resolves, false);

  const resolved = detectIssueRefinementArtifact({
    body,
    issueNumber: 532,
    resolveLinkedDoc: (p) => p === "tmp/refinement/532-plan.md",
  });
  assert.equal(resolved.hasACs, true);
  assert.equal(resolved.source, REFINEMENT_SOURCE.LINKED_DOC);
  assert.equal(resolved.linkedDoc.resolves, true);
  assert.equal(resolved.finding, null);
});

test("#1866 without resolveLinkedDoc the predicate stays pure and unchanged (no resolves field)", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Plan\n\nSee tmp/refinement/532-plan.md for details.\n" + NGOALS,
  });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.linkedDoc.found, true);
  assert.equal("resolves" in artifact.linkedDoc, false);
});

test("#1866 an unresolved linked doc falls back to the matrix artifact when present", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n" + MATRIX + "\n## Plan\n\nSee tmp/refinement/gone.md.\n" + NGOALS,
    resolveLinkedDoc: () => false,
  });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.source, REFINEMENT_SOURCE.ISSUE_BODY_MATRIX);
  assert.equal(artifact.finding, null);
});

test("#1866 runPickupRefinementGate anchors linked-doc resolution to the repoRoot option, not ambient cwd", async () => {
  const { runPickupRefinementGate } = await import("../src/loop/issue-refinement-artifact.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");

  const repoRoot = mkdtempSync(pathMod.join(tmpdir(), "refine-anchor-"));
  const docDir = pathMod.join(repoRoot, "tmp", "refinement");
  mkdirSync(docDir, { recursive: true });
  writeFileSync(pathMod.join(docDir, "anchor-plan.md"), "# plan\n");
  const body =
    "## Plan\n\nSee tmp/refinement/anchor-plan.md for details.\n" + NGOALS;
  const runChild = async () => ({
    code: 0,
    stdout: JSON.stringify({ body }),
    stderr: "",
  });

  try {
    const decision = await runPickupRefinementGate({
      issueNumber: 532,
      repo: "o/r",
      env: {},
      runChild,
      repoRoot,
    });
    assert.equal(decision.action, "enqueue");

    await assert.rejects(
      () =>
        runPickupRefinementGate({
          issueNumber: 532,
          repo: "o/r",
          env: {},
          runChild,
          repoRoot: mkdtempSync(pathMod.join(tmpdir(), "refine-empty-")),
        }),
      (err) => err.code === "MISSING_REFINEMENT_ARTIFACT",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("#1866 containment: a linked-doc path with '..' segments is rejected, never fs-probed", () => {
  const body = "## Plan\n\nSee tmp/refinement/../../docs/some-existing.md for details.\n" + NGOALS;
  const artifact = detectIssueRefinementArtifact({
    body,
    issueNumber: 532,
    resolveLinkedDoc: (p) => existsProbe(p),
  });
  assert.equal(artifact.linkedDoc.found, false, "traversal-shaped path must not count as a linked doc");
  function existsProbe() {
    throw new Error("resolveLinkedDoc must not be called for a traversal-shaped path");
  }
});

// ---- #1621: checkbox tick-state parsing (unticked AC precondition) ----

test("#1621 extractUncheckedChecklistItems returns only unticked checkbox text", () => {
  const body = [
    "## Acceptance criteria",
    "- [ ] first unticked",
    "- [x] a ticked one",
    "- [X] another ticked (capital)",
    "- [ ] second unticked",
    "- plain bullet (no checkbox)",
    "",
    "```",
    "- [ ] fenced unticked must not count",
    "```",
  ].join("\n");
  assert.deepEqual(extractUncheckedChecklistItems(body), ["first unticked", "second unticked"]);
  assert.deepEqual(extractChecklistItems(body), [
    "first unticked", "a ticked one", "another ticked (capital)", "second unticked", "plain bullet (no checkbox)",
  ]);
});

test("#1621 detectIssueRefinementArtifact surfaces uncheckedAcItems alongside acItems", () => {
  const artifact = detectIssueRefinementArtifact({
    body: [
      "## Acceptance criteria", "",
      "- [x] done AC", "- [ ] open AC one", "- [ ] open AC two", "",
      "## Definition of done", "",
      "- [ ] tests pass", "",
    ].join("\n") + MATRIX + "\n## Non-goals\n\n- none\n",
  });
  assert.equal(artifact.hasACs, true);
  assert.deepEqual(artifact.acItems, ["done AC", "open AC one", "open AC two"]);
  // Only unticked AC checkboxes (NOT the DoD item, NOT the ticked AC).
  assert.deepEqual(artifact.uncheckedAcItems, ["open AC one", "open AC two"]);
});

test("GRILL-SUBLOOP (#1628): detectGrillMarker finds the sanctioned loop-grill marker", () => {
  assert.equal(detectGrillMarker("<!-- loop-grill: 2026-08-14T00:00:00Z mode:interactive -->\n\n## Acceptance criteria\n\n- [ ] ac"), true);
  assert.equal(detectGrillMarker("## Acceptance criteria\n\n- [ ] ac"), false);
  assert.equal(detectGrillMarker(""), false);
});

test("GRILL-SUBLOOP (#1628): detectGrillEmbedHeading finds grill transcript/synthesis/Q&A embed headings", () => {
  const body = [
    "## Acceptance criteria", "",
    "- [ ] ac", "",
    "## Grill findings", "",
    "- Q: what", "- A: ans",
  ].join("\n");
  assert.equal(detectGrillEmbedHeading(body), "Grill findings");
  assert.equal(
    detectGrillEmbedHeading(["## Grill transcript", "", "- q", "- a"].join("\n")),
    "Grill transcript",
  );
  assert.equal(
    detectGrillEmbedHeading(["# Overview", "", "## Grill synthesis", "", "x"].join("\n")),
    "Grill synthesis",
  );
  assert.equal(
    detectGrillEmbedHeading(["## Acceptance criteria", "", "- [ ] ac", "", "## Non-goals", "", "- none"].join("\n")),
    null,
  );
});

// ---------------------------------------------------------------------------
// PR-side deterministic block: extractPrBodyUncheckedChecklistItems (#1877).
// The PR carries list-form AC/DoD checklists (never a matrix); this read is
// unchanged by #1951.
// ---------------------------------------------------------------------------

test("extractPrBodyUncheckedChecklistItems returns unchecked AC and DoD boxes only", () => {
  const { uncheckedAcItems, uncheckedDodItems } = extractPrBodyUncheckedChecklistItems({
    body: [
      "## Summary", "", "text", "",
      "## Acceptance criteria", "", "- [ ] open AC", "- [x] done AC", "- plain bullet (not a box)", "",
      "## Definition of done", "", "- [ ] open DoD", "",
      "## Non-goals", "", "- none", "",
    ].join("\n"),
  });
  assert.deepEqual(uncheckedAcItems, ["open AC"]);
  assert.deepEqual(uncheckedDodItems, ["open DoD"]);
});

test("extractPrBodyUncheckedChecklistItems: empty body and absent sections contribute no items", () => {
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body: "" }), { uncheckedAcItems: [], uncheckedDodItems: [] });
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Summary\n\nno AC/DoD sections at all\n" }),
    { uncheckedAcItems: [], uncheckedDodItems: [] },
  );
});

test("extractPrBodyUncheckedChecklistItems: a fenced checkbox cannot spoof the count", () => {
  const { uncheckedAcItems } = extractPrBodyUncheckedChecklistItems({
    body: "## Acceptance criteria\n\n```\n- [ ] spoofed\n```\n\n- [x] real\n",
  });
  assert.deepEqual(uncheckedAcItems, []);
});

test("PR-body extractor sees unchecked boxes under ### sub-headings and in duplicate AC sections", () => {
  const body = [
    "## Acceptance criteria", "",
    "- [x] AC1", "",
    "### edge cases", "",
    "- [ ] AC2 open", "",
    "## Definition of done", "",
    "- [x] tests pass",
  ].join("\n");
  const result = extractPrBodyUncheckedChecklistItems({ body });
  assert.deepEqual(result.uncheckedAcItems, ["AC2 open"]);
  assert.deepEqual(result.uncheckedDodItems, []);

  const dupBody = [
    "## Acceptance criteria", "", "- [ ] first", "",
    "## Interlude", "", "- [ ] not an AC", "",
    "## Acceptance criteria", "", "- [ ] second open",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: dupBody }).uncheckedAcItems,
    ["first", "second open"],
  );
});

test("#1877 round-6 grammar pin: star/plus/ordered/blockquote unchecked AC boxes ARE surfaced", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n* [ ] star unchecked\n" }),
    { uncheckedAcItems: ["star unchecked"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n+ [ ] plus unchecked\n" }),
    { uncheckedAcItems: ["plus unchecked"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n1. [ ] ordered unchecked\n" }),
    { uncheckedAcItems: ["ordered unchecked"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n> - [ ] blockquote unchecked\n" }),
    { uncheckedAcItems: ["blockquote unchecked"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 grammar pin: tick-verified-checkboxes parity for parseChecklistItems consumers", () => {
  assert.deepEqual(extractChecklistItems("* [x] star item"), ["star item"]);
  assert.deepEqual(extractChecklistItems("+ [x] plus item"), ["plus item"]);
  assert.deepEqual(extractChecklistItems("1. [x] ordered item"), ["ordered item"]);
  assert.deepEqual(extractUncheckedChecklistItems("* [x] star ticked\n* [ ] star unticked"), ["star unticked"]);
  assert.deepEqual(extractChecklistItems("* [ ]\n1. [x]\n- [ ] real"), ["real"]);
});

test("#1877 round-6 decorated-heading pin: bolded/colon/suffixed AC and DoD headings are recognized on the PR side", () => {
  const body = [
    "## **Acceptance criteria**", "", "- [ ] bolded ac unchecked", "",
    "## Acceptance criteria:", "", "- [ ] colon ac unchecked", "",
    "## Definition of done ##", "", "- [ ] suffixed dod unchecked",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body }),
    { uncheckedAcItems: ["bolded ac unchecked", "colon ac unchecked"], uncheckedDodItems: ["suffixed dod unchecked"] },
  );
});

test("#1877 round-6 decorated-heading pin: a decorated-variant canonical heading matches the exact anchor family", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria (v2)\n\n- [ ] under v2\n" }),
    { uncheckedAcItems: ["under v2"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Definition of done — core\n\n- [ ] dod item\n" }),
    { uncheckedAcItems: [], uncheckedDodItems: ["dod item"] },
  );
});

test("#1877 round-6 re-injection pin: a checkbox-shaped sub-heading name produces NO phantom item; real boxes stay visible", () => {
  const body = [
    "## Definition of done", "",
    "### - [ ] fake dod box as heading", "",
    "- [x] real one",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body }),
    { uncheckedAcItems: [], uncheckedDodItems: [] },
  );
  const bodyChecked = [
    "## Definition of done", "",
    "### - [x] fake checked heading", "",
    "- [ ] real unchecked",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: bodyChecked }),
    { uncheckedAcItems: [], uncheckedDodItems: ["real unchecked"] },
  );
});

test("#1877 round-6 re-injection pin: a fence-opening sub-heading name does NOT eat the boxes after it", () => {
  const body = [
    "## Acceptance criteria", "",
    "- [x] AC1", "",
    "### ```", "",
    "- [ ] AC2 after fence heading",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body }),
    { uncheckedAcItems: ["AC2 after fence heading"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 malformed-input pin: extractPrBodyUncheckedChecklistItems guards non-string bodies", () => {
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body: null }), { uncheckedAcItems: [], uncheckedDodItems: [] });
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body: 42 }), { uncheckedAcItems: [], uncheckedDodItems: [] });
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({}), { uncheckedAcItems: [], uncheckedDodItems: [] });
});

test("#1877 round-7 marker-anchor pin: an UNCHECKED box whose label mentions a literal [x] is still unchecked", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n- [ ] verify [x] flags\n" }),
    { uncheckedAcItems: ["verify [x] flags"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Definition of done\n\n- [ ] confirm [X] marks\n" }),
    { uncheckedDodItems: ["confirm [X] marks"], uncheckedAcItems: [] },
  );
  assert.deepEqual(
    extractUncheckedChecklistItems("- [ ] label with [x] inside"),
    ["label with [x] inside"],
  );
  assert.deepEqual(
    extractUncheckedChecklistItems("- [x] label with [ ] inside"),
    [],
  );
});

test("#1877 round-7 grammar pins: `N)` paren-ordered and nested `> >` blockquote forms surface unchecked boxes", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n1) [ ] paren ordered unchecked\n" }),
    { uncheckedAcItems: ["paren ordered unchecked"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n> > - [ ] nested blockquote unchecked\n" }),
    { uncheckedAcItems: ["nested blockquote unchecked"], uncheckedDodItems: [] },
  );
});

test("#1877 round-7 decorated-heading pin: single-char italic AC and DoD headings are recognized (PR side)", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## *Acceptance criteria*\n\n- [ ] italic ac\n" }),
    { uncheckedAcItems: ["italic ac"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## _Definition of done_\n\n- [ ] italic dod\n" }),
    { uncheckedDodItems: ["italic dod"], uncheckedAcItems: [] },
  );
});

test("#1877 round-7 DoD-alias-symmetry pin: decorated-variant DoD alias headings are recognized (PR side)", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## DoD (v2)\n\n- [ ] unchecked under alias\n" }),
    { uncheckedDodItems: ["unchecked under alias"], uncheckedAcItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Done — core\n\n- [ ] unchecked under done alias\n" }),
    { uncheckedDodItems: ["unchecked under done alias"], uncheckedAcItems: [] },
  );
});
