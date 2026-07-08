import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const skill = readFileSync(new URL("skills/loop-grill/SKILL.md", `file://${repoRoot}`), "utf8");

test("write-back synthesizes into the canonical sections", () => {
  for (const heading of ["## Acceptance criteria", "## Definition of done", "## Non-goals"]) {
    assert.ok(skill.includes(heading), `SKILL must name synthesis target ${heading}`);
  }
});

test("raw Q&A goes only to the ephemeral gitignored artifact", () => {
  assert.ok(skill.includes("tmp/issues/issue-<n>/grill/"), "SKILL must route raw Q&A to tmp artifact path");
});

test("no positive body-embed of raw Q&A findings", () => {
  const negation = /do not|don't|never|no longer|replac|remove/i;
  for (const line of skill.split("\n")) {
    if (!line.includes("## Grill findings")) continue;
    // Any surviving mention must be a removal/negation, not a positive write instruction.
    assert.match(line, negation, `'## Grill findings' mention must be negative context: ${line}`);
    if (/(write|append|add)[^.\n]{0,40}## Grill findings/i.test(line)) {
      // A write/append/add phrasing is only allowed when explicitly negated on the same line.
      assert.match(line, negation, `positive-embed instruction not negated: ${line}`);
    }
  }
});

test("the single is-it-refined source is referenced", () => {
  assert.ok(skill.includes("detectIssueRefinementArtifact"), "SKILL must reference the single refinement source");
});
