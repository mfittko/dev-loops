import assert from "node:assert/strict";
import test from "node:test";

import {
  MISSING_EXPLICIT_NON_GOALS_FINDING,
  REFINEMENT_SOURCE,
  decideEnqueueRefinementGate,
  detectIssueRefinementArtifact,
  detectLinkedRefinementDoc,
  detectGrillMarker,
  detectGrillEmbedHeading,
  extractChecklistItems,
  extractUncheckedChecklistItems,
  parseMarkdownSections,
  summarizeRefinementGateCheck,
} from "../src/loop/issue-refinement-artifact.mjs";

// #1866: a refined tracker-backed issue body carries an explicit Non-goals
// section (loop-grill / artifact-authority contract). Fixture suffix shared by
// every "artifact present" fixture below.
const NGOALS = "\n\n## Non-goals\n\n- None beyond the stated scope.\n";

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
    body: "## Problem\n\nX\n\n## Acceptance criteria\n\n- [ ] First AC\n- [x] Second AC\n" + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(result.finding, null);
  assert.deepEqual(result.acItems, ["First AC", "Second AC"]);
});

test("detectIssueRefinementArtifact detects Acceptance criteria with plain bullets", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Acceptance criteria\n\n- First AC\n- Second AC\n" + NGOALS,
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
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_DOD);
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
    body: "## Acceptance criteria\n\n- foo\n  - detail of foo\n- bar\n" + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.deepEqual(result.acItems, ["foo", "bar"]);
});

test("detectIssueRefinementArtifact detects DoD section when AC is absent", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Definition of Done\n\n- [ ] DoD1\n- [x] DoD2\n" + NGOALS,
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_DOD);
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
    body: "## Acceptance criteria\n\n- [ ] real ac\n- [ ]\n" + NGOALS,
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
    body: "## Acceptance criteria\n\n- [ ] AC1\n" + NGOALS,
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
  const artifact = detectIssueRefinementArtifact({ body: "## Acceptance criteria\n\n- [ ] AC1\n" + NGOALS });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
});

test("decideEnqueueRefinementGate enqueues a DoD-only refined issue into the pickup column", () => {
  const artifact = detectIssueRefinementArtifact({ body: "## Definition of done\n\n- [ ] DoD1\n" + NGOALS });
  const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
  assert.deepEqual(decision, { action: "enqueue" });
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
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Out of scope\n\n- everything else\n",
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
    body: "## Acceptance criteria\n\n- [ ] AC1\n\n## Plan\n\nSee tmp/refinement/gone.md.\n" + NGOALS,
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
