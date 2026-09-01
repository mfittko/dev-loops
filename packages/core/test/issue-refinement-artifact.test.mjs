import assert from "node:assert/strict";
import test from "node:test";

import {
  MISSING_AC_CHECKLIST_FINDING,
  MISSING_DOD_CHECKLIST_FINDING,
  MISSING_EXPLICIT_NON_GOALS_FINDING,
  REFINEMENT_SOURCE,
  decideEnqueueRefinementGate,
  detectIssueRefinementArtifact,
  detectLinkedRefinementDoc,
  detectGrillMarker,
  detectGrillEmbedHeading,
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
// #1877: the refinement floor is the full AC/DoD/Non-goals matrix — every
// "matrix present" fixture pairs the AC checklist with a DoD checklist.
const DOD = "\n\n## Definition of done\n\n- [x] All checks pass\n";

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

test("detectIssueRefinementArtifact returns missing for prose-only bodies", () => {
  const result = detectIssueRefinementArtifact({ body: "## Problem\n\nNo ACs.\n\n## Root Cause\n\nBug.\n\n## Fix\n\nCode." });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.finding, "missing_refinement_artifact");
  assert.deepEqual(result.acItems, []);
  assert.deepEqual(result.dodItems, []);
});

test("detectIssueRefinementArtifact detects Acceptance criteria with checkboxes", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Acceptance criteria\n\n- [ ] First AC\n- [x] Second AC\n" + DOD + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(result.finding, null);
  assert.deepEqual(result.acItems, ["First AC", "Second AC"]);
});

test("detectIssueRefinementArtifact detects Acceptance criteria with plain bullets", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Acceptance criteria\n\n- First AC\n- Second AC\n" + DOD + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(result.finding, null);
  assert.deepEqual(result.acItems, ["First AC", "Second AC"]);
});

test("detectIssueRefinementArtifact detects DoD section with plain bullets when AC is absent", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Definition of Done\n\n- Ship it\n- Docs updated\n" + NGOALS,
  });
  // #1877 matrix floor: DoD-only is an incomplete matrix (missing AC arm).
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_DOD);
  assert.equal(result.finding, MISSING_AC_CHECKLIST_FINDING);
  assert.deepEqual(result.dodItems, ["Ship it", "Docs updated"]);
});

test("detectIssueRefinementArtifact rejects an empty recognized AC section", () => {
  const result = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n" });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("detectIssueRefinementArtifact ignores plain bullets under an unrecognized heading", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\n- some bullet\n- another bullet\n",
  });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("detectIssueRefinementArtifact counts only top-level bullets, not indented sub-bullets", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- foo\n  - detail of foo\n- bar\n" + DOD + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.deepEqual(result.acItems, ["foo", "bar"]);
});

test("detectIssueRefinementArtifact detects DoD section when AC is absent", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Definition of Done\n\n- [ ] DoD1\n- [x] DoD2\n" + NGOALS,
  });
  // #1877 matrix floor: DoD-only is an incomplete matrix (missing AC arm).
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_DOD);
  assert.equal(result.finding, MISSING_AC_CHECKLIST_FINDING);
  assert.deepEqual(result.dodItems, ["DoD1", "DoD2"]);
});

test("detectIssueRefinementArtifact detects a linked refinement doc path", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\nSee `tmp/refinement/532-plan.md` for ACs.\n" + NGOALS,
    issueNumber: 532,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.LINKED_DOC);
  assert.equal(result.linkedDoc.found, true);
  assert.equal(result.linkedDoc.path, "tmp/refinement/532-plan.md");
});

test("detectIssueRefinementArtifact rejects a Refinement section without explicit path", () => {
  // Per #532 review feedback: a `## Refinement` heading alone is not a
  // verifiable artifact; the body must reference a real tmp/refinement/*.md
  // path. The old convention-path fallback was removed.
  const result = detectIssueRefinementArtifact({
    body: "## Refinement\n\nA plan lives here.\n",
    issueNumber: 527,
  });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.linkedDoc.found, false);
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("detectIssueRefinementArtifact rejects a prose-only AC section (no bullets or checkboxes)", () => {
  // Per #532 review feedback: prose-only AC/DoD sections must not satisfy
  // the refinement artifact; the section must contain at least one checklist
  // item OR a top-level plain `- ` bullet. Plain prose lines (no `- `) still
  // do not count.
  const result = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\nFirst AC without checkbox\nSecond AC also without checkbox\n",
  });
  assert.equal(result.hasACs, false);
  assert.equal(result.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(result.finding, "missing_refinement_artifact");
});

test("detectIssueRefinementArtifact rejects an AC section of only empty checkbox placeholders", () => {
  // The canonical not-yet-refined template: `- [ ]` placeholders with no
  // text must NOT satisfy the gate (#1075 regression guard).
  const unchecked = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n- [ ]\n- [ ]\n" });
  assert.equal(unchecked.hasACs, false);
  assert.equal(unchecked.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(unchecked.finding, "missing_refinement_artifact");

  const checked = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n- [x]\n- [x]\n" });
  assert.equal(checked.hasACs, false);
  assert.equal(checked.source, REFINEMENT_SOURCE.MISSING);
  assert.equal(checked.finding, "missing_refinement_artifact");
});

test("detectIssueRefinementArtifact drops empty checkbox placeholders but keeps filled ones", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] real ac\n- [ ]\n" + DOD + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.deepEqual(result.acItems, ["real ac"]);
});

test("detectIssueRefinementArtifact rejects an AC section of only a horizontal rule", () => {
  const result = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n---\n" });
  assert.equal(result.hasACs, false);
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

test("summarizeRefinementGateCheck maps to clean verdict when artifact present", () => {
  const summary = summarizeRefinementGateCheck({
    body: "## Acceptance criteria\n\n- [ ] AC1\n" + DOD + NGOALS,
  });
  assert.equal(summary.verdict, "clean");
  assert.equal(summary.finding, null);
  assert.equal(summary.blocking, false);
});

test("summarizeRefinementGateCheck maps to blocked verdict when artifact missing", () => {
  const summary = summarizeRefinementGateCheck({
    body: "## Problem\n\nX\n",
  });
  assert.equal(summary.verdict, "blocked");
  assert.equal(summary.finding, "missing_refinement_artifact");
  assert.equal(summary.blocking, true);
});

test("decideEnqueueRefinementGate enqueues a refined issue into the pickup column", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n- [ ] AC1\n" + DOD + NGOALS });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
});

test("decideEnqueueRefinementGate blocks a DoD-only issue (incomplete #1877 matrix)", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Definition of done\n\n- [ ] DoD1\n" + NGOALS });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.equal(artifact.finding, MISSING_AC_CHECKLIST_FINDING);
});

test("decideEnqueueRefinementGate enqueues a linked-doc-only refined issue into the pickup column", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Plan\n\nSee tmp/refinement/10-plan.md for details.\n" + NGOALS });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
});

test("decideEnqueueRefinementGate blocks an un-refined issue targeting pickup interactively", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /loop-grill/);
  assert.deepEqual(decision.missing, [
    "Acceptance criteria section",
    "Definition of done section",
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
  // extractChecklistItems stays text-only (all non-empty items, both tick states + bullets).
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
      "## Non-goals", "",
      "- none",
    ].join("\n"),
  });
  assert.equal(artifact.hasACs, true);
  assert.deepEqual(artifact.acItems, ["done AC", "open AC one", "open AC two"]);
  // Only unticked AC checkboxes (NOT the DoD item, NOT the ticked AC).
  assert.deepEqual(artifact.uncheckedAcItems, ["open AC one", "open AC two"]);
});

test("#1621 detectIssueRefinementArtifact carries uncheckedAcItems: [] when all ACs are ticked", () => {
  const artifact = detectIssueRefinementArtifact({
    body: ["## Acceptance criteria", "", "- [x] done one", "- [x] done two", "", "## Non-goals", "", "- none"].join("\n"),
  });
  assert.deepEqual(artifact.uncheckedAcItems, []);
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
  // A clean body with only canonical sections has no embed heading.
  assert.equal(
    detectGrillEmbedHeading(["## Acceptance criteria", "", "- [ ] ac", "", "## Non-goals", "", "- none"].join("\n")),
    null,
  );
});

// ---- #1866: Non-goals required on tracker-backed refined issues ----

test("#1866 fails closed when an AC-bearing issue lacks an explicit Non-goals section", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] First AC\n",
  });
  assert.equal(artifact.hasACs, false);
  assert.equal(artifact.hasNonGoals, false);
  // The artifact itself is still reported (source keeps the detected origin).
  assert.equal(artifact.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(artifact.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
  assert.match(artifact.reason, /Non-goals/);
});

test("#1866 fail-closed propagates: summarizeRefinementGateCheck blocks a Non-goals miss", () => {
  const summary = summarizeRefinementGateCheck({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Definition of done\n\n- [ ] done\n",
  });
  assert.equal(summary.verdict, "blocked");
  assert.equal(summary.blocking, true);
  assert.equal(summary.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
});

test("#1866 fail-closed propagates: decideEnqueueRefinementGate blocks a Non-goals miss", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n- [ ] AC1\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /Non-goals/);
  assert.deepEqual(decision.missing, ["explicit Non-goals section"]);

  const diverted = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: true });
  assert.equal(diverted.action, "divert");
  assert.deepEqual(diverted.missing, ["explicit Non-goals section"]);
});

test("#1866 rejects an empty Non-goals section (heading only, or fenced-only body)", () => {
  const headingOnly = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Non-goals\n",
  });
  assert.equal(headingOnly.hasACs, false);
  assert.equal(headingOnly.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);

  // Anti-spoof (#1025 fence logic): a fenced-only Non-goals body is empty.
  const fencedOnly = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Non-goals\n\n```\n- [ ] spoof\n```\n",
  });
  assert.equal(fencedOnly.hasACs, false);
  assert.equal(fencedOnly.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
});

test("#1866 accepts 'out of scope' as an explicit non-goals heading (shared patterns)", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n" + DOD + "\n## Out of scope\n\n- everything else\n",
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

test("#1866 an unresolved linked doc falls back to AC/DoD artifacts when present", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n" + DOD + "\n## Plan\n\nSee tmp/refinement/gone.md.\n" + NGOALS,
    resolveLinkedDoc: () => false,
  });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
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
    // With the repoRoot anchor the doc resolves even though it does not exist
    // relative to the ambient cwd (the test runner's cwd).
    const decision = await runPickupRefinementGate({
      issueNumber: 532,
      repo: "o/r",
      env: {},
      runChild,
      repoRoot,
    });
    assert.equal(decision.action, "enqueue");

    // Without an anchor that points at the doc's root, the doc does not
    // resolve and the gate blocks (fail-closed), never a silent pass.
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

test("#1877 matrix floor: AC checklist without DoD checklist fails closed with missing_dod_checklist", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n- [x] AC2\n" + NGOALS,
  });
  assert.equal(artifact.hasACs, false);
  assert.equal(artifact.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(artifact.finding, MISSING_DOD_CHECKLIST_FINDING);
  assert.match(artifact.reason, /AC\/DoD\/Non-goals matrix/);
});

test("#1877 matrix floor: full AC + DoD + Non-goals matrix passes", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Definition of done\n\n- [ ] DoD1\n" + NGOALS,
  });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(artifact.finding, null);
});

test("#1877 matrix floor: Non-goals miss is reported before the DoD arm (ordering preserved)", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n",
  });
  assert.equal(artifact.finding, MISSING_EXPLICIT_NON_GOALS_FINDING);
});

test("#1877 matrix floor: linked refinement doc alone stays a complete artifact", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Plan\n\nSee tmp/refinement/10-plan.md for the AC/DoD matrix.\n" + NGOALS,
    resolveLinkedDoc: () => true,
  });
  assert.equal(artifact.hasACs, true);
  assert.equal(artifact.source, REFINEMENT_SOURCE.LINKED_DOC);
  assert.equal(artifact.finding, null);
});

test("#1877 extractPrBodyUncheckedChecklistItems returns unchecked AC and DoD boxes only", () => {
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

test("#1877 extractPrBodyUncheckedChecklistItems: empty body and absent sections contribute no items", () => {
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body: "" }), { uncheckedAcItems: [], uncheckedDodItems: [] });
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Summary\n\nno AC/DoD sections at all\n" }),
    { uncheckedAcItems: [], uncheckedDodItems: [] },
  );
});

test("#1877 extractPrBodyUncheckedChecklistItems: a fenced checkbox cannot spoof the count", () => {
  const { uncheckedAcItems } = extractPrBodyUncheckedChecklistItems({
    body: "## Acceptance criteria\n\n```\n- [ ] spoofed\n```\n\n- [x] real\n",
  });
  assert.deepEqual(uncheckedAcItems, []);
});

// ---- #1877 alias-precedence + deep/duplicate section reads (round-1 review) ----

test("#1877 alias precedence: an 'AC/DoD matrix' heading before '## Acceptance criteria' must not hijack the AC read", () => {
  const body = [
    "## Problem", "", "X", "",
    "## AC/DoD matrix", "",
    "| AC | DoD |", "|---|---|", "| AC1 | tests |", "",
    "## Acceptance criteria", "",
    "- [ ] AC1", "",
    "## Definition of done", "",
    "- [ ] tests", "",
    "## Non-goals", "", "- none",
  ].join("\n");
  const artifact = detectIssueRefinementArtifact({ body });
  // The refined epic-matrix shape must read the real AC checklist, not the
  // mapping table (pre-fix this false-blocked as missing_ac_checklist).
  assert.equal(artifact.finding, null);
  assert.equal(artifact.hasACs, true);
  assert.deepEqual(artifact.acItems, ["AC1"]);
  assert.deepEqual(artifact.dodItems, ["tests"]);
  // PR side: the same body shape must surface its unchecked boxes (no fail-open).
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body }), {
    uncheckedAcItems: ["AC1"],
    uncheckedDodItems: ["tests"],
  });
});

test("#1877 alias precedence: '## AC → DoD mapping' before the canonical DoD section must not hijack the DoD read", () => {
  const body = [
    "## Acceptance criteria", "", "- [ ] AC1", "",
    "## AC → DoD mapping", "",
    "| AC | DoD |", "|---|---|", "| AC1 | tests |", "",
    "## Definition of done", "",
    "- [x] tests", "",
    "## Non-goals", "", "- none",
  ].join("\n");
  const artifact = detectIssueRefinementArtifact({ body });
  assert.equal(artifact.finding, null);
  assert.deepEqual(artifact.dodItems, ["tests"]);
});

test("#1877 alias-only bodies still read via the loose alias arm (no canonical heading)", () => {
  const artifact = detectIssueRefinementArtifact({
    body: [
      "## AC checklist", "", "- [ ] AC1", "",
      "## DoD", "", "- [ ] tests", "",
      "## Non-goals", "", "- none",
    ].join("\n"),
  });
  assert.equal(artifact.finding, null);
  assert.deepEqual(artifact.acItems, ["AC1"]);
  assert.deepEqual(artifact.dodItems, ["tests"]);
});

test("#1877 PR-body extractor sees unchecked boxes under ### sub-headings and in duplicate AC sections", () => {
  // The reviewer's pinned failing scenario: pre-fix this yielded
  // { uncheckedAcItems: [], uncheckedDodItems: [] } — the block failed open.
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

  // Duplicate canonical AC sections union their unchecked boxes.
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

test("#1877 enqueue gate: an AC-only issue blocks naming the missing DoD checklist, not 'no artifact'", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n- [ ] AC1\n" + NGOALS,
  });
  assert.equal(artifact.finding, MISSING_DOD_CHECKLIST_FINDING);
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /no Definition of done checklist/);
  assert.match(decision.reason, /AC\/DoD\/Non-goals matrix/);
  assert.doesNotMatch(decision.reason, /no refinement artifact/);
  assert.deepEqual(decision.missing, ["Definition of done checklist"]);

  const diverted = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: true });
  assert.equal(diverted.action, "divert");
  assert.deepEqual(diverted.missing, ["Definition of done checklist"]);
});

test("#1877 enqueue gate: a DoD-only issue blocks naming the missing AC checklist", () => {
  const artifact = detectIssueRefinementArtifact({
    body: "## Definition of done\n\n- [ ] DoD1\n" + NGOALS,
  });
  assert.equal(artifact.finding, MISSING_AC_CHECKLIST_FINDING);
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /no Acceptance criteria checklist/);
  assert.doesNotMatch(decision.reason, /no refinement artifact/);
  assert.deepEqual(decision.missing, ["Acceptance criteria checklist"]);
});

test("#1877 enqueue gate: the generic no-artifact reason states the full-matrix floor (doc-alone alternative kept)", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Problem\n\nX\n" });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.equal(decision.action, "block");
  assert.match(decision.reason, /full AC\/DoD\/Non-goals matrix/);
  assert.match(decision.reason, /complete artifact on its own/);
  assert.doesNotMatch(decision.reason, /Add at least ONE of them/);
});

// ---- #1877 round-2 pins: draft-gate wrapper + issue/PR read asymmetry ----

test("#1877 draft-gate wrapper: summarizeRefinementGateCheck blocks on missing_dod_checklist (AC-only body with Non-goals)", () => {
  const summary = summarizeRefinementGateCheck({
    body: "## Acceptance criteria\n\n- [ ] AC1\n" + NGOALS,
  });
  assert.equal(summary.verdict, "blocked");
  assert.equal(summary.blocking, true);
  assert.equal(summary.finding, MISSING_DOD_CHECKLIST_FINDING);
});

test("#1877 draft-gate wrapper: summarizeRefinementGateCheck blocks on missing_ac_checklist (DoD-only body with Non-goals)", () => {
  const summary = summarizeRefinementGateCheck({
    body: "## Definition of done\n\n- [ ] DoD1\n" + NGOALS,
  });
  assert.equal(summary.verdict, "blocked");
  assert.equal(summary.blocking, true);
  assert.equal(summary.finding, MISSING_AC_CHECKLIST_FINDING);
});

test("#1877 seam pin: issue side reads ONE exact-first AC section with NO deep flattening — a sub-heading-only AC checklist reports missing (intentional asymmetry)", () => {
  // The same body shape on the PR side yields its boxes (hard gate must never
  // miss an unchecked box); on the issue side the strict presence read fails
  // CLOSED — the issue stays parked for human refinement. Both directions are
  // deliberate; see the CONSUMER-CONTRACT BOUNDARY comment in the source.
  const artifact = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n### edge cases\n\n- [ ] AC1 hidden under a sub-heading\n\n## Definition of done\n\n- [ ] DoD1\n\n## Non-goals\n\n- none\n" });
  assert.deepEqual(artifact.acItems, []);
  assert.equal(artifact.finding, MISSING_AC_CHECKLIST_FINDING, "sub-heading-only AC checklist fails closed as a matrix miss");
  // PR side: the same shape surfaces the unchecked box (deep flatten + union).
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n### edge cases\n\n- [ ] AC1 hidden\n" }),
    { uncheckedAcItems: ["AC1 hidden"], uncheckedDodItems: [] },
  );
});

test("#1877 seam pin (mixed exact+alias): issue side — exact section wins over an earlier alias; PR side — BOTH sections' unchecked boxes are surfaced", () => {
  const body = [
    "## AC checklist", "", "- [ ] alias AC open", "",
    "## Acceptance criteria", "", "- [ ] exact AC open", "",
    "## DoD", "", "- [ ] alias DoD open", "",
    "## Definition of done", "", "- [ ] exact DoD open", "",
    "## Non-goals", "", "- none",
  ].join("\n");

  // Issue side: the single exact-first read picks the canonical sections; the
  // earlier alias sections' boxes are NOT in acItems/dodItems.
  const artifact = detectIssueRefinementArtifact({ body });
  assert.deepEqual(artifact.acItems, ["exact AC open"]);
  assert.deepEqual(artifact.dodItems, ["exact DoD open"]);
  assert.equal(artifact.finding, null);

  // PR side: the union surfaces unchecked boxes from BOTH the alias and the
  // exact sections — a hard gate must never miss an unchecked box.
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body }), {
    uncheckedAcItems: ["alias AC open", "exact AC open"],
    uncheckedDodItems: ["alias DoD open", "exact DoD open"],
  });
});

// ---------------------------------------------------------------------------
// #1877 round-6 parser-hardening pins (draft_gate round-6 act list): GFM
// task-list marker grammar, decorated-heading normalization, heading-name
// re-injection, malformed-input guard. Fail arms were reproduced against the
// pre-fix parser before the fix landed (star/plus/ordered/blockquote forms
// and decorated headings returned empty unchecked lists; a checkbox-shaped
// heading name fabricated a phantom item; a fence-opening heading name ate
// following boxes).
// ---------------------------------------------------------------------------

test("#1877 round-6 grammar pin: a star-bullet unchecked AC box IS surfaced (fail arm: pre-fix returned [])", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n* [ ] star unchecked\n" }),
    { uncheckedAcItems: ["star unchecked"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 grammar pin: a plus-bullet unchecked AC box IS surfaced", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n+ [ ] plus unchecked\n" }),
    { uncheckedAcItems: ["plus unchecked"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 grammar pin: an ordered-list unchecked AC box IS surfaced", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n1. [ ] ordered unchecked\n" }),
    { uncheckedAcItems: ["ordered unchecked"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 grammar pin: a blockquote-nested unchecked AC box IS surfaced", () => {
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria\n\n> - [ ] blockquote unchecked\n" }),
    { uncheckedAcItems: ["blockquote unchecked"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 grammar pin: the unticked-AC read (#1621) and the issue-side matrix read recognize star-only checklists", () => {
  // Issue side: a full matrix written with star bullets is a complete artifact
  // (pre-fix: star-only AC section false-blocked as missing_ac_checklist).
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n* [x] star AC\n\n## Definition of done\n\n* [x] star DoD\n\n## Non-goals\n\n- none",
  });
  assert.equal(artifact.finding, null);
  assert.deepEqual(artifact.acItems, ["star AC"]);
  // #1621 unticked read: a star unchecked box is an unticked AC item.
  assert.deepEqual(
    extractUncheckedChecklistItems("* [ ] star unchecked"),
    ["star unchecked"],
  );
});

test("#1877 round-6 anti-spoof pin: a code-fenced star checkbox still cannot spoof the count (#1025)", () => {
  // The fence skip is shared with the widened grammar: a star box inside a
  // fenced block is invisible to every read, exactly as the dash form is.
  const body = "## Acceptance criteria\n\n```\n* [ ] fenced star unchecked\n```\n\n- [x] real ticked";
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body }),
    { uncheckedAcItems: [], uncheckedDodItems: [] },
  );
  const artifact = detectIssueRefinementArtifact({
    body: "## Acceptance criteria\n\n```\n* [ ] fenced star unchecked\n```\n\n## Definition of done\n\n- [x] DoD\n\n## Non-goals\n\n- none",
  });
  // A fenced-only star AC section is still an empty section (anti-spoof): the
  // issue-side read must NOT count it as a real AC checklist.
  assert.equal(artifact.acItems.length, 0);
});

test("#1877 round-6 grammar pin: tick-verified-checkboxes parity — star/plus/ordered forms are checklist items for every consumer of parseChecklistItems", () => {
  // tick-verified-checkboxes.mjs CHECKBOX_RE accepts [-*+]; the extractor must
  // agree, so a box the tick tool can flip is never invisible to the block.
  assert.deepEqual(extractChecklistItems("* [x] star item"), ["star item"]);
  assert.deepEqual(extractChecklistItems("+ [x] plus item"), ["plus item"]);
  assert.deepEqual(extractChecklistItems("1. [x] ordered item"), ["ordered item"]);
  // checked-state read: star/plus/ordered ticked boxes are checked, not unticked.
  assert.deepEqual(extractUncheckedChecklistItems("* [x] star ticked\n* [ ] star unticked"), ["star unticked"]);
  // Empty placeholders are skipped in the widened grammar too.
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

test("#1877 round-6 decorated-heading pin: a decorated-variant canonical heading (v2/dash suffix) matches the exact anchor family", () => {
  // The exact pattern is an anchor family (^acceptance criteria\\b), so a
  // variant like `## Acceptance criteria (v2)` lands in the exact bucket
  // rather than matching no pattern at all.
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Acceptance criteria (v2)\n\n- [ ] under v2\n" }),
    { uncheckedAcItems: ["under v2"], uncheckedDodItems: [] },
  );
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: "## Definition of done — core\n\n- [ ] dod item\n" }),
    { uncheckedAcItems: [], uncheckedDodItems: ["dod item"] },
  );
});

test("#1877 round-6 decorated-heading pin: the issue-side presence read recognizes a decorated full matrix", () => {
  // Pre-fix: a full matrix under decorated headings false-blocked as
  // missing_refinement_artifact. Both decorated canonical sections AND the
  // anchor-family variants are recognized.
  const artifact = detectIssueRefinementArtifact({
    body: [
      "## **Acceptance criteria**", "", "- [x] AC1", "",
      "## **Definition of done**", "", "- [x] DoD1", "",
      "## Non-goals", "", "- none",
    ].join("\n"),
  });
  assert.equal(artifact.finding, null);
  assert.equal(artifact.hasACs, true);
  assert.deepEqual(artifact.acItems, ["AC1"]);
  assert.deepEqual(artifact.dodItems, ["DoD1"]);
});

test("#1877 round-6 re-injection pin: a checkbox-shaped sub-heading name produces NO phantom item; real boxes under it stay visible", () => {
  // Pre-fix: the heading name `### - [ ] fake dod box as heading` was
  // re-injected into the flattened body and counted as an unchecked DoD item.
  const body = [
    "## Definition of done", "",
    "### - [ ] fake dod box as heading", "",
    "- [x] real one",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body }),
    { uncheckedAcItems: [], uncheckedDodItems: [] },
  );
  // And a checked-shaped heading name injects no phantom checked item:
  // the real unchecked box after it is still surfaced (no fence corruption,
  // no swallow).
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
  // Pre-fix: `### ` + ``` as the heading NAME re-opened fence state in the
  // flattened string and swallowed every following real box (fail-open,
  // defeating the #1025 anti-spoof invariant for the heading-name form).
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
  // Same arm with an info-string suffix on the fence-like name.
  const bodyInfo = [
    "## Acceptance criteria", "",
    "### notes ```js", "",
    "- [ ] AC3 after info-string heading",
  ].join("\n");
  assert.deepEqual(
    extractPrBodyUncheckedChecklistItems({ body: bodyInfo }),
    { uncheckedAcItems: ["AC3 after info-string heading"], uncheckedDodItems: [] },
  );
});

test("#1877 round-6 malformed-input pin: extractPrBodyUncheckedChecklistItems guards non-string bodies", () => {
  // The guard exists specifically for malformed input; this pins it.
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body: null }), { uncheckedAcItems: [], uncheckedDodItems: [] });
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({ body: 42 }), { uncheckedAcItems: [], uncheckedDodItems: [] });
  assert.deepEqual(extractPrBodyUncheckedChecklistItems({}), { uncheckedAcItems: [], uncheckedDodItems: [] });
});
