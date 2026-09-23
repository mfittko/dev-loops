// Doc-drift guard for issue 2370: every gate review round must run in a
// dedicated, fresh-context gate coordinator agent. This is the only
// sanctioned round shape (GATE-EXEC-GATE-COORDINATOR). Fails if the rule
// text, its registration, or its cross-harness mirrors regress.
import { FANOUT_UNAVAILABLE_MESSAGE } from "@dev-loops/core/loop/gate-fanin";

import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

const CONTRACT_DOC = "skills/docs/gate-review-sub-loop-contract.md";
const MARKER = "<!-- rule: GATE-EXEC-GATE-COORDINATOR -->";

test("GATE-EXEC-GATE-COORDINATOR is defined once, owned by the gate-review sub-loop contract", () => {
  assertRulePresent("GATE-EXEC-GATE-COORDINATOR");
  assertRuleOwned("GATE-EXEC-GATE-COORDINATOR", CONTRACT_DOC);
});

test("the rule states it is the only sanctioned round shape", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const idx = content.indexOf(MARKER);
  assert.ok(idx !== -1, "expected the GATE-EXEC-GATE-COORDINATOR marker in the contract doc");
  const section = content.slice(idx, idx + 1200);
  assert.match(section, /GATE-EXEC-GATE-COORDINATOR/, "expected the rule id restated in its own prose");
  assert.match(section, /only sanctioned round shape/, "expected the rule to name itself as the only sanctioned round shape");
});

test("skills/docs/required-rules.json registers GATE-EXEC-GATE-COORDINATOR", async () => {
  const parsed = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  const entry = parsed.requiredRules.find((rule) =>
    (typeof rule === "string" ? rule : rule.id) === "GATE-EXEC-GATE-COORDINATOR");
  assert.ok(entry, "expected GATE-EXEC-GATE-COORDINATOR registered in required-rules.json's requiredRules");
});

test("the rule lists the returned fields and keeps reviewer/judge output in the gate coordinator's context", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const idx = content.indexOf(MARKER);
  const section = content.slice(idx, idx + 1600);
  for (const field of ["verdict", "findings artifact path", "judge summary"]) {
    assert.ok(section.includes(field), `expected the returned-result field "${field}" in the rule`);
  }
  assert.match(
    section,
    /[Rr]eviewer and judge outputs stay in the gate[\s\S]{0,20}coordinator's context/,
    "expected the rule to state reviewer/judge outputs never propagate to the dev-loop coordinator",
  );
});

test("the rule pins the reserved-lifecycle-writes sentence", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const idx = content.indexOf(MARKER);
  const section = content.slice(idx, idx + 1600);
  assert.match(
    section,
    /never posts the verdict comment, flips ready, pushes, or merges/,
    "expected the rule to pin that the gate coordinator never performs these reserved lifecycle writes",
  );
});

test("the rule states the fail-closed fan-out-unavailable path and never degrading to inline review", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const idx = content.indexOf(MARKER);
  const section = content.slice(idx, idx + 1600);
  assert.match(section, /FANOUT_UNAVAILABLE_MESSAGE/, "expected the rule to name the fail-closed signal");
  assert.match(section, /never degrades to inline review/, "expected the rule to forbid inline-review degradation");

  const failClosedIdx = content.indexOf("### Fail-closed: fan-out unavailable");
  assert.ok(failClosedIdx !== -1, "expected the fail-closed fan-out-unavailable section");
  const failClosedSection = content.slice(failClosedIdx, failClosedIdx + 2400);
  const quoted = failClosedSection.match(/> \*\*(.+)\*\*/);
  assert.ok(quoted, "expected the fail-closed section to quote FANOUT_UNAVAILABLE_MESSAGE");
  assert.equal(
    quoted[1],
    FANOUT_UNAVAILABLE_MESSAGE,
    "the contract's quoted fail-closed string must equal the exported FANOUT_UNAVAILABLE_MESSAGE",
  );
  assert.match(
    failClosedSection,
    /Under `GATE-EXEC-GATE-COORDINATOR`, the gate coordinator returns this signal to the dev-loop\s*\ncoordinator as the round's result/,
    "expected the fail-closed section to route the signal through the gate coordinator to the dev-loop coordinator",
  );
});

test("agents/dev-loop.agent.md's sub-loop bullet names the gate coordinator and the rule, and drops the ambiguous phrase", async () => {
  const content = await readRepo("agents/dev-loop.agent.md");
  assert.match(
    content,
    /Every sub-loop[\s\S]{0,120}runs in its own dedicated fresh-context agent/i,
    "expected the sub-loop bullet's opening clause to survive",
  );
  assert.match(content, /gate coordinator/, "expected the sub-loop bullet to name the gate coordinator");
  assert.match(content, /GATE-EXEC-GATE-COORDINATOR/, "expected the sub-loop bullet to link the new rule");
  assert.equal(
    content.includes("review fan-out, judge"),
    false,
    "expected the ambiguous 'review fan-out, judge' phrase to be gone",
  );
});

// Cross-harness non-regression (#1086): a Claude-Code-only or Pi-only doc
// edit here would leave the other harness's read surface stale. Both
// surfaces must carry the rule id and gate-coordinator wording.
test("the Claude surfaces mirror the rule id and gate-coordinator wording", async () => {
  const claudeAgent = await readRepo(".claude/agents/dev-loop.md");
  assert.match(claudeAgent, /gate coordinator/, "expected .claude/agents/dev-loop.md to name the gate coordinator");
  assert.match(claudeAgent, /GATE-EXEC-GATE-COORDINATOR/, "expected .claude/agents/dev-loop.md to link the rule");

  const claudeContract = await readRepo(".claude/skills/docs/gate-review-sub-loop-contract.md");
  assert.match(
    claudeContract,
    /GATE-EXEC-GATE-COORDINATOR/,
    "expected .claude/skills/docs/gate-review-sub-loop-contract.md to carry the rule id",
  );
});

test("the Pi surface (source files Pi reads through its symlinks) carries the same rule id", async () => {
  // Pi reads agents/skills through .pi/agents and .pi/skills symlinks. Read
  // the source paths directly rather than depending on the symlinks existing
  // in this checkout/worktree.
  const piAgentSource = await readRepo("agents/dev-loop.agent.md");
  assert.match(piAgentSource, /GATE-EXEC-GATE-COORDINATOR/, "expected agents/dev-loop.agent.md to link the rule");

  const piContractSource = await readRepo(CONTRACT_DOC);
  assert.match(piContractSource, /GATE-EXEC-GATE-COORDINATOR/, "expected the contract source to carry the rule id");
});
