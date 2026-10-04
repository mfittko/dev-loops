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

// Structural claim check. A claim is a list of literal tokens (rule IDs, flags, fields, RFC-2119 modalities)
// that must co-occur in ONE sentence of the located block, so rewording keeps passing and a dropped literal
// or modality fails. `assertClaims` also proves both directions on the real block: a reworded copy (filler clause between tokens, sentence order reversed) passes,
// and removing a claim's last token makes exactly that claim fail.
const collapse = (text) => text.replace(/\s+/g, " ");
const sentences = (text) => collapse(text).split(/(?<=[.!?:])\s+(?=[A-Z`*(|-])/);
const missingClaims = (block, claims) => claims.filter((tokens) => !sentences(block).some((s) => tokens.every((t) => s.includes(t))));
const reword = (block, claims) => sentences(block).map((s) => (claims.find((tokens) => tokens.every((t) => s.includes(t)))?.slice(0, -1) ?? []).reduce((acc, t) => acc.replace(t, `${t} (as the contract records, without exception)`), s)).reverse().join(" ");
function assertClaims(block, claims, label) {
  assert.deepEqual(missingClaims(block, claims), [], `${label}: missing claim`);
  assert.deepEqual(missingClaims(reword(block, claims), claims), [], `${label}: a reworded copy must pass`);
  for (const tokens of claims) {
    const broken = collapse(block).split(tokens.at(-1)).join("");
    assert.ok(missingClaims(broken, claims).includes(tokens), `${label}: dropping ${tokens.at(-1)} must fail ${tokens.join(" + ")}`);
  }
}

test("the rule states it is the only sanctioned round shape", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assert.match(section, /GATE-EXEC-GATE-COORDINATOR/, "expected the rule id restated in its own prose");
  assertClaims(section, [["only sanctioned", "shape"]], "round shape");
});

test("the rule scopes to draft_gate and pre_approval_gate lifecycle rounds", async () => {
  const content = await readRepo(CONTRACT_DOC);
  assertClaims(ruleSection(content), [["`draft_gate`", "`pre_approval_gate`", "MUST", "gate coordinator"]], "lifecycle scope");
});

test("the rule covers the light-mode inline_single_agent round", async () => {
  const content = await readRepo(CONTRACT_DOC);
  assertClaims(ruleSection(content), [["light-mode", "`inline_single_agent`", "gate coordinator"]], "light-mode round");
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
  // One claim per returned field, all anchored to the typed-result sentence.
  const fields = [
    "verdict", "execution mode", "inline reason", "findings summary", "severity counts", "fan-in output path",
    "durable findings-log path", "act-list path", "spec-authority identity path", "judge summary",
  ];
  assertClaims(section, [
    ...fields.map((field) => ["typed result", field]),
    ["Reviewer", "judge outputs", "never propagate"],
  ], "returned fields");
});

test("the rule pins the reserved-lifecycle-writes sentence", async () => {
  const content = await readRepo(CONTRACT_DOC);
  assertClaims(ruleSection(content), [["never posts", "verdict comment", "flips ready", "pushes", "merges"]], "reserved lifecycle writes");
});

test("the rule states the typed-observation stop on head change, unrecovered dispatch failure, fan-in failure, or a failed Phase 3.5 judge rerun", async () => {
  const content = await readRepo(CONTRACT_DOC);
  assertClaims(ruleSection(content), [
    ["head change", "`GATE-EXEC-DISPATCH-RETRY-BACKOFF`", "fan-in", "typed observation"],
    ["Phase 3.5", "judge rerun", "typed observation"],
  ], "typed-observation stops");
});

test("the rule states the fail-closed fan-out-unavailable path and never degrading to inline review", async () => {
  const content = await readRepo(CONTRACT_DOC);
  const section = ruleSection(content);
  assertClaims(section, [["`FANOUT_UNAVAILABLE_MESSAGE`", "fails closed", "never degrades", "inline"]], "fail-closed signal");

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
  assertClaims(failClosedSection, [["`GATE-EXEC-GATE-COORDINATOR`", "returns this signal", "dev-loop coordinator"]], "fail-closed routing");
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

// ADR 0112: the gate coordinator is a dedicated agent definition.
const GATE_COORDINATOR_AGENT = "agents/gate-coordinator.agent.md";

test("the gate-coordinator agent names the rule, the verbatim relay and defers the typed round result to the rule", async () => {
  const body = await readRepo(GATE_COORDINATOR_AGENT);
  assert.match(body, /^name: "gate-coordinator"$/m);
  assert.match(body, /GATE-EXEC-GATE-COORDINATOR/);
  // The agent cites the rule for the typed result; the contract owns the field list (asserted against the rule above).
  assertClaims(body, [
    ["relay", "`dispatchPrompt`", "byte for byte"],
    ["typed round result", "`GATE-EXEC-GATE-COORDINATOR`"],
  ], "gate-coordinator agent");
  const boundary = body.slice(body.indexOf("## Boundary"));
  assertClaims(boundary, [["tracked-file edits", "verdict comment", "ready flip", "push", "merge", "fixer dispatch"]], "agent boundary");
});

test("renderPiAgent maps the gate-coordinator subagent tool to the Pi subagent tool", async () => {
  const rendered = renderPiAgent(await readRepo(GATE_COORDINATOR_AGENT));
  const toolsLine = rendered.split("\n").find((line) => line.startsWith("tools:"));
  assert.deepEqual(toolsLine.slice("tools:".length).split(",").map((t) => t.trim()), ["read", "bash", "write", "subagent"]);
});

test("every gate-coordinator dispatch site names the gate-coordinator agent", async () => {
  for (const file of ["agents/dev-loop.agent.md", ".claude/agents/dev-loop.md"]) {
    const lines = (await readRepo(file)).split("\n");
    const subLoop = lines.find((line) => line.trimStart().startsWith("- Every sub-loop"));
    const childSpawn = lines.find((line) => line.trimStart().startsWith("- No child subagent spawning"));
    assert.match(subLoop, /`gate-coordinator` agent/, `${file}: sub-loop bullet`);
    assert.match(childSpawn, /`gate-coordinator` agent/, `${file}: child-spawning bullet`);
  }
  for (const file of [CONTRACT_DOC, ".claude/skills/docs/gate-review-sub-loop-contract.md"]) {
    assert.match(ruleSection(await readRepo(file)), /`gate-coordinator` agent/, `${file}: rule section`);
  }
  for (const file of ["skills/copilot-pr-followup/SKILL.md", ".claude/skills/copilot-pr-followup/SKILL.md"]) {
    assert.match(await readRepo(file), /dedicated `gate-coordinator` agent \(`GATE-EXEC-GATE-COORDINATOR`\) drives the fan-out/, file);
  }
});

test("the review skill's dev-loop route dispatches a gate-coordinator agent for the round", async () => {
  const content = (await readRepo("skills/review/SKILL.md")).replace(/\s+/g, " ");
  assert.ok(content.includes(
    "When the `review` route runs inside a `dev-loop` agent (`loop startup --pr <n> --review`), that agent dispatches one `gate-coordinator` agent for the round.",
  ));
  assert.ok(content.includes("In the main session this skill dispatches the `review` agents directly."));
});

test("the dev-loop agent reads only the gate coordinator's typed round result", async () => {
  const content = await readRepo("agents/dev-loop.agent.md");
  assert.match(content, /The coordinator reads only the gate coordinator's typed round result, as `GATE-EXEC-GATE-COORDINATOR` lists it\./);
});
