import assert from "node:assert/strict";
import test from "node:test";

import {
  REFINEMENT_SOURCE,
  detectIssueRefinementArtifact,
  detectLinkedRefinementDoc,
  extractChecklistItems,
  parseMarkdownSections,
  summarizeRefinementGateCheck,
} from "../src/loop/issue-refinement-artifact.mjs";

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
    body: "## Problem\n\nX\n\n## Acceptance criteria\n\n- [ ] First AC\n- [x] Second AC\n",
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(result.finding, null);
  assert.deepEqual(result.acItems, ["First AC", "Second AC"]);
});

test("detectIssueRefinementArtifact detects Acceptance criteria with plain bullets", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Acceptance criteria\n\n- First AC\n- Second AC\n",
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.equal(result.finding, null);
  assert.deepEqual(result.acItems, ["First AC", "Second AC"]);
});

test("detectIssueRefinementArtifact detects DoD section with plain bullets when AC is absent", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Definition of Done\n\n- Ship it\n- Docs updated\n",
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
    body: "## Acceptance criteria\n\n- foo\n  - detail of foo\n- bar\n",
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_AC);
  assert.deepEqual(result.acItems, ["foo", "bar"]);
});

test("detectIssueRefinementArtifact detects DoD section when AC is absent", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\n## Definition of Done\n\n- [ ] DoD1\n- [x] DoD2\n",
  });
  assert.equal(result.hasACs, true);
  assert.equal(result.source, REFINEMENT_SOURCE.ISSUE_BODY_DOD);
  assert.deepEqual(result.dodItems, ["DoD1", "DoD2"]);
});

test("detectIssueRefinementArtifact detects a linked refinement doc path", () => {
  const result = detectIssueRefinementArtifact({
    body: "## Problem\n\nX\n\nSee `tmp/refinement/532-plan.md` for ACs.\n",
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
    body: "## Acceptance criteria\n\n- [ ] real ac\n- [ ]\n",
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
    body: "## Acceptance criteria\n\n- [ ] AC1\n",
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
