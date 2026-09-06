// Pins the default-on spec-authority wiring (issue 2008 / ADR 0061 AC4): the Phase 3.5
// gate flow docs must keep prescribing the spec-context seam and the judge-pass
// spec-authority flags. Without this test, an edit that drops the flags from the
// gate flow prose would silently revert the feature with no failing test.
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const REQUIRED_TOKENS = [
  "spec-context.mjs",
  "--spec-file",
  "--content-digest",
  "--spec-authority-verdict",
  "--prior-approvals",
  "--approvals-out",
];

function extractPhase35(content, endBoundary) {
  const startMatch = content.match(/Spec authority is engaged by default|Spec-context seam \(default-on/);
  assert.ok(startMatch, "Phase 3.5 default-on spec-authority prose not found");
  const start = startMatch.index;
  const endMatch = content.slice(start).match(endBoundary);
  return endMatch ? content.slice(start, start + endMatch.index) : content.slice(start);
}

test("skills/dev-loop/SKILL.md pins default-on spec-authority wiring in the gate flow (issue 2008)", async () => {
  const skill = await readRepo("skills/dev-loop/SKILL.md");
  const section = extractPhase35(skill, /\*\*Bounded test runs/);
  for (const token of REQUIRED_TOKENS) {
    assert.ok(section.includes(token), `SKILL.md Phase 3.5 section should reference ${token}`);
  }
});

test("skills/docs/gate-review-sub-loop-contract.md pins default-on spec-authority wiring in the gate flow (issue 2008)", async () => {
  const contract = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  const section = extractPhase35(contract, /\n## /);
  for (const token of REQUIRED_TOKENS) {
    assert.ok(section.includes(token), `gate-review-sub-loop-contract.md Phase 3.5 section should reference ${token}`);
  }
});
