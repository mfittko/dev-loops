// Doc-drift guard for issue 2370: every draft_gate / pre_approval_gate review
// round must run in a dedicated, fresh-context gate coordinator agent. This
// is the only sanctioned round shape (GATE-EXEC-GATE-COORDINATOR). Fails if
// the rule text, its registration, or its cross-harness mirrors regress.
import { FANOUT_UNAVAILABLE_MESSAGE } from "@dev-loops/core/loop/gate-fanin";

import { renderPiAgent } from "../../extension/sync-packaged-agents.ts";
import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

const CONTRACT_DOC = "skills/docs/gate-review-sub-loop-contract.md";
const MARKER = "<!-- rule: GATE-EXEC-GATE-COORDINATOR -->";

// The rule's own section: from its marker to the next `### ` heading, so the
// slice tracks the prose instead of a fixed, wrap-dependent character count.
function ruleSection(content) {
  const idx = content.indexOf(MARKER);
  assert.ok(idx !== -1, "expected the GATE-EXEC-GATE-COORDINATOR marker in the contract doc");
  const nextHeadingIdx = content.indexOf("\n### ", idx);
  const end = nextHeadingIdx === -1 ? content.length : nextHeadingIdx;
  return content.slice(idx, end);
}

test("GATE-EXEC-GATE-COORDINATOR is defined once, owned by the gate-review sub-loop contract", () => {
  assertRulePresent("GATE-EXEC-GATE-COORDINATOR");
  assertRuleOwned("GATE-EXEC-GATE-COORDINATOR", CONTRACT_DOC);
});

test("the rule states it is the only sanctioned round shape", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(section, /GATE-EXEC-GATE-COORDINATOR/, "expected the rule id restated in its own prose");
  assert.match(section, /only sanctioned round\s+shape/, "expected the rule to name itself as the only sanctioned round shape");
});

test("the rule scopes to draft_gate and pre_approval_gate lifecycle rounds", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(
    section,
    /Every `draft_gate` and `pre_approval_gate` review round MUST run/,
    "expected the rule to scope itself to the two lifecycle gates",
  );
});

test("the rule covers the light-mode inline_single_agent round", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(
    section,
    /A light-mode\s+`inline_single_agent` round also runs inside the gate coordinator/,
    "expected the rule to state the light-mode round also runs inside the gate coordinator",
  );
});

test("skills/docs/required-rules.json registers GATE-EXEC-GATE-COORDINATOR", async () => {
  const parsed = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  const entry = parsed.requiredRules.find((rule) =>
    (typeof rule === "string" ? rule : rule.id) === "GATE-EXEC-GATE-COORDINATOR");
  assert.ok(entry, "expected GATE-EXEC-GATE-COORDINATOR registered in required-rules.json's requiredRules");
});

test("the rule lists the returned fields and keeps reviewer/judge output in the gate coordinator's context", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  for (const field of [
    "verdict",
    "the execution mode",
    "inline reason and findings summary",
    "severity counts",
    "fan-in\noutput path",
    "durable findings-log path",
    "act-list path",
    "spec-authority identity path",
    "judge summary",
  ]) {
    const pattern = new RegExp(field.replace(/\s+/g, "\\s+"));
    assert.match(section, pattern, `expected the returned-result field "${field}" in the rule`);
  }
  assert.match(
    section,
    /[Rr]eviewer\s+and judge outputs stay in the gate coordinator's context/,
    "expected the rule to state reviewer/judge outputs never propagate to the dev-loop coordinator",
  );
});

test("the rule pins the reserved-lifecycle-writes sentence", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(
    section,
    /never posts the verdict comment, flips ready, pushes, or\s+merges/,
    "expected the rule to pin that the gate coordinator never performs these reserved lifecycle writes",
  );
});

test("the rule states the typed-observation stop on head change, unrecovered dispatch failure, fan-in failure, or a failed Phase 3.5 judge rerun", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(
    section,
    /On a head change, a\s+dispatch failure that `GATE-EXEC-DISPATCH-RETRY-BACKOFF` does not recover, or a fan-in\s+failure,\s+the gate coordinator stops and returns a typed observation instead of choosing the next step/,
    "expected the rule to state the head-change/dispatch/fan-in typed-observation stop condition",
  );
  assert.match(
    section,
    /If\s+the Phase 3\.5 judge rerun at the current head also fails, the gate coordinator stops and returns\s+a typed observation/,
    "expected the rule to state the Phase 3.5 judge-rerun-failure typed-observation stop condition",
  );
});

test("the rule states the fail-closed fan-out-unavailable path and never degrading to inline review", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(section, /FANOUT_UNAVAILABLE_MESSAGE/, "expected the rule to name the fail-closed signal");
  assert.match(section, /never degrades to inline review/, "expected the rule to forbid inline-review degradation");

  const failClosedIdx = content.indexOf("### Fail-closed: fan-out unavailable");
  assert.ok(failClosedIdx !== -1, "expected the fail-closed fan-out-unavailable section");
  const nextSubheadingIdx = content.indexOf("\n### ", failClosedIdx + 1);
  const nextHeadingIdx = content.indexOf("\n## ", failClosedIdx + 1);
  const candidates = [nextSubheadingIdx, nextHeadingIdx].filter((idx) => idx !== -1);
  const failClosedEnd = candidates.length === 0 ? content.length : Math.min(...candidates);
  const failClosedSection = content.slice(failClosedIdx, failClosedEnd);
  const quoted = failClosedSection.match(/> \*\*(.+)\*\*/);
  assert.ok(quoted, "expected the fail-closed section to quote FANOUT_UNAVAILABLE_MESSAGE");
  assert.equal(
    quoted[1],
    FANOUT_UNAVAILABLE_MESSAGE,
    "the contract's quoted fail-closed string must equal the exported FANOUT_UNAVAILABLE_MESSAGE",
  );
  assert.match(
    failClosedSection,
    /Under `GATE-EXEC-GATE-COORDINATOR`, the gate coordinator returns this signal to the dev-loop\s+coordinator as the round's result/,
    "expected the fail-closed section to route the signal through the gate coordinator to the dev-loop coordinator",
  );
});

test("agents/dev-loop.agent.md's sub-loop bullet names the gate coordinator and the rule, and drops the ambiguous phrase", async () => {
  const content = await readRepo("agents/dev-loop.agent.md");
  // Scope to the sub-loop bullet line itself (not the whole file): the join
  // bullet a few lines down also says "gate coordinator", so a whole-file
  // match would still pass if the sub-loop bullet stopped naming it (AC2).
  const lines = content.split("\n");
  const subLoopLine = lines.find((line) => line.trimStart().startsWith("- Every sub-loop"));
  assert.ok(subLoopLine, "expected a bullet line starting with '- Every sub-loop'");
  assert.match(
    subLoopLine,
    /Every sub-loop[\s\S]{0,120}runs in its own dedicated fresh-context agent/i,
    "expected the sub-loop bullet's opening clause to survive",
  );
  assert.match(subLoopLine, /gate coordinator/, "expected the sub-loop bullet to name the gate coordinator");
  assert.match(subLoopLine, /GATE-EXEC-GATE-COORDINATOR/, "expected the sub-loop bullet to link the new rule");
  assert.equal(
    content.includes("review fan-out, judge"),
    false,
    "expected the ambiguous 'review fan-out, judge' phrase to be gone",
  );
  assert.equal(
    content.includes("(refine, implement, review fan-out"),
    false,
    "expected the ambiguous '(refine, implement, review fan-out' phrase to be gone",
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

// Pi's actual read path does not depend on `.pi/agents`/`.pi/skills` checkout
// state: extension/sync-packaged-agents.ts's syncPackagedAgents (#1606) can
// replace a `.pi/agents` symlink with a real directory of Pi-rendered copies
// after any Pi session, so asserting on the symlink is checkout-state-dependent
// and does not model what Pi actually reads. Assert on the two deterministic,
// checkout-independent seams instead:
//   1. package.json's `pi` manifest names "agents" and "skills" as the
//      packaged source roots Pi loads from.
//   2. Pi's agent read path renders the source through renderPiAgent (the
//      same function syncPackagedAgents calls); the skills read path has no
//      render step, so the source file is read as-is.
test("the Pi surface (package.json's pi manifest and the rendered agent) carries the same rule id", async () => {
  const pkg = JSON.parse(await readRepo("package.json"));
  assert.deepEqual(pkg.pi?.agents, ["agents"], "expected package.json's pi.agents manifest to name the agents/ source root");
  assert.deepEqual(pkg.pi?.skills, ["skills"], "expected package.json's pi.skills manifest to name the skills/ source root");

  const devLoopAgentSource = await readRepo("agents/dev-loop.agent.md");
  const renderedForPi = renderPiAgent(devLoopAgentSource);
  assert.match(
    renderedForPi,
    /GATE-EXEC-GATE-COORDINATOR/,
    "expected agents/dev-loop.agent.md, rendered through renderPiAgent (Pi's actual read path), to link the rule",
  );

  const piContractContent = await readRepo(CONTRACT_DOC);
  assert.match(
    piContractContent,
    /GATE-EXEC-GATE-COORDINATOR/,
    "expected the contract doc under the pi.skills manifest root to carry the rule id",
  );
});
