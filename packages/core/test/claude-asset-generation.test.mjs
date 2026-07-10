import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_NAME_MAP,
  mapTool,
  mapTools,
  splitFrontmatter,
  stripPiOnlyBlocks,
  rewriteCliInvocation,
  transformAgent,
  transformSkill,
  transformCommand,
} from "../src/claude/asset-generation.mjs";

test("rewriteCliInvocation pins the package-local CLI to npx dev-loops@<version> (#801, #833)", () => {
  const body = "Run `node <dev-loops-package-root>/cli/index.mjs loop info` and `node <dev-loops-package-root>/cli/index.mjs loop startup`.";
  const out = rewriteCliInvocation(body, "0.2.6");
  assert.equal(out.includes("node <dev-loops-package-root>/cli/index.mjs"), false);
  assert.equal((out.match(/npx dev-loops@0\.2\.6/g) ?? []).length, 2, "every token is rewritten");
});

test("transformAgent and transformSkill rewrite the package-local CLI form to the pinned npx form", () => {
  const agentRaw = `---\nname: a\ndescription: d\ntools: [read]\n---\nRun \`node <dev-loops-package-root>/cli/index.mjs loop startup\`.\n`;
  const agent = transformAgent({ source: "agents/a.agent.md", raw: agentRaw, version: "1.2.3" });
  assert.ok(agent.includes("npx dev-loops@1.2.3 loop startup"));
  assert.equal(agent.includes("<dev-loops-package-root>"), false);

  const skillRaw = `---\nname: s\ndescription: d\nallowed-tools: read\n---\nRun \`node <dev-loops-package-root>/cli/index.mjs loop info\`.\n`;
  const skill = transformSkill({ source: "skills/s/SKILL.md", raw: skillRaw, version: "1.2.3" });
  assert.ok(skill.includes("npx dev-loops@1.2.3 loop info"));
  assert.equal(skill.includes("<dev-loops-package-root>"), false);
});

test("stripPiOnlyBlocks removes <!-- pi-only --> blocks and collapses blank runs; keeps other prose", () => {
  const body = "Keep A.\n\n<!-- pi-only -->\nPi-only line about contact_supervisor.\n<!-- /pi-only -->\n\nKeep B.\n";
  const out = stripPiOnlyBlocks(body);
  assert.equal(out.includes("contact_supervisor"), false);
  assert.equal(out.includes("pi-only"), false);
  assert.match(out, /Keep A\./);
  assert.match(out, /Keep B\./);
  assert.equal(out.includes("\n\n\n"), false, "blank-line runs collapsed");
});

test("stripPiOnlyBlocks is a byte-exact no-op without markers, even with pre-existing blank runs", () => {
  // Must NOT collapse intentional double-blank runs in marker-free bodies (drift guard).
  const body = "Para one.\n\n\nPara two (after a double blank).\n\nPara three.\n";
  assert.equal(stripPiOnlyBlocks(body), body);
});

test("stripPiOnlyBlocks removes multiple blocks non-greedily (no over-strip between them)", () => {
  const body = "A\n\n<!-- pi-only -->\nfirst\n<!-- /pi-only -->\n\nKEEP MIDDLE\n\n<!-- pi-only -->\nsecond\n<!-- /pi-only -->\n\nB\n";
  const out = stripPiOnlyBlocks(body);
  assert.equal(out.includes("first"), false);
  assert.equal(out.includes("second"), false);
  assert.match(out, /KEEP MIDDLE/);
  assert.match(out, /A\n/);
  assert.match(out, /B\n/);
});

test("transformAgent strips pi-only blocks from the body", () => {
  const raw = `---\nname: x\ndescription: d\ntools: [read]\n---\nIntro.\n<!-- pi-only -->\nmaxSubagentDepth: 3 lives here.\n<!-- /pi-only -->\nOutro.\n`;
  const out = transformAgent({ source: "agents/x.agent.md", raw });
  assert.equal(out.includes("maxSubagentDepth"), false);
  assert.match(out, /Intro\./);
  assert.match(out, /Outro\./);
});

test("transformSkill strips pi-only blocks from the body too", () => {
  const raw = `---\nname: s\ndescription: d\nallowed-tools: read bash\n---\nKeep this.\n<!-- pi-only -->\ncontact_supervisor guidance here.\n<!-- /pi-only -->\nAnd keep this.\n`;
  const out = transformSkill({ source: "skills/s/SKILL.md", raw });
  assert.equal(out.includes("contact_supervisor"), false);
  assert.match(out, /Keep this\./);
  assert.match(out, /And keep this\./);
});

test("mapTool expands search to Grep+Glob and maps subagent/review_loop to Agent", () => {
  assert.deepEqual(mapTool("read"), ["Read"]);
  assert.deepEqual(mapTool("search"), ["Grep", "Glob"]);
  assert.deepEqual(mapTool("subagent"), ["Agent"]);
  assert.deepEqual(mapTool("review_loop"), ["Agent"]);
  assert.deepEqual(mapTool("todo"), ["TodoWrite"]);
  assert.deepEqual(mapTool("unknown-tool"), []);
});

test("mapTools dedupes and preserves first-seen order", () => {
  // execute+bash both → Bash; subagent+review_loop both → Agent.
  assert.deepEqual(
    mapTools(["read", "search", "execute", "bash", "edit", "write"]),
    ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
  );
  assert.deepEqual(
    mapTools(["read", "bash", "edit", "write", "subagent", "review_loop"]),
    ["Read", "Bash", "Edit", "Write", "Agent"],
  );
  assert.deepEqual(mapTools(["agent", "subagent"]), ["Agent"]);
});

test("TOOL_NAME_MAP is frozen and complete for the Pi tool vocabulary", () => {
  assert.throws(() => { TOOL_NAME_MAP.read = ["x"]; }, TypeError);
  for (const pi of ["read", "search", "execute", "bash", "edit", "write", "agent", "subagent", "todo", "review_loop"]) {
    assert.ok(Array.isArray(TOOL_NAME_MAP[pi]), `expected mapping for ${pi}`);
  }
});

test("splitFrontmatter throws on a file without frontmatter", () => {
  assert.throws(() => splitFrontmatter("no frontmatter here"), /missing a leading YAML frontmatter/);
});

const AGENT_SRC = `---
name: "developer"
description: "Implements code."
tools: [read, search, execute, bash, edit, write]
argument-hint: "task"
systemPromptMode: append
inheritProjectContext: true
user-invocable: false
maxSubagentDepth: 3
---
You are a focused implementation agent.
- bullet one
`;

test("transformAgent maps tools (comma), drops Pi-only fields, keeps the body + generated note", () => {
  const out = transformAgent({ source: "agents/developer.agent.md", raw: AGENT_SRC });
  // `developer` is a low-tier role, so `model: "sonnet"` is stamped after tools (#1134).
  assert.match(out, /^---\nname: "developer"\ndescription: "Implements code\."\ntools: Read, Grep, Glob, Bash, Edit, Write\nmodel: "sonnet"\n---\n/);
  // Pi-only fields must be gone.
  for (const dropped of ["argument-hint", "systemPromptMode", "inheritProjectContext", "user-invocable", "maxSubagentDepth"]) {
    assert.equal(out.includes(`${dropped}:`), false, `${dropped} should be dropped`);
  }
  assert.match(out, /<!-- GENERATED from agents\/developer\.agent\.md by/);
  assert.match(out, /You are a focused implementation agent\.\n- bullet one/);
});

const SKILL_SRC = `---
name: local-implementation
description: "Internal routed strategy."
compatibility: Pi skill for git-based repositories.
allowed-tools: read bash edit write subagent review_loop
user-invocable: false
---
# Local Implementation
body text
`;

test("transformSkill maps allowed-tools (space), preserves user-invocable, drops compatibility", () => {
  const out = transformSkill({ source: "skills/local-implementation/SKILL.md", raw: SKILL_SRC });
  assert.match(out, /^---\nname: "local-implementation"\ndescription: "Internal routed strategy\."\nallowed-tools: Read Bash Edit Write Agent\nuser-invocable: false\n---\n/);
  assert.equal(out.includes("compatibility:"), false, "Pi-specific compatibility should be dropped");
  assert.match(out, /<!-- GENERATED from skills\/local-implementation\/SKILL\.md by/);
  assert.match(out, /# Local Implementation\nbody text/);
});

test("transformCommand keeps description+argument-hint, rewrites CLI, adds banner (#972)", () => {
  const raw = `---\ndescription: "Show state."\nargument-hint: "<issue|pr>"\n---\nRun \`node <dev-loops-package-root>/cli/index.mjs loop info --issue $ARGUMENTS\`.\n`;
  const out = transformCommand({ source: "commands/info.command.md", raw, version: "1.2.3" });
  assert.match(out, /^---\ndescription: "Show state\."\nargument-hint: "<issue\|pr>"\n---\n/);
  assert.match(out, /<!-- GENERATED from commands\/info\.command\.md by/);
  assert.ok(out.includes("npx dev-loops@1.2.3 loop info --issue $ARGUMENTS"));
  assert.equal(out.includes("<dev-loops-package-root>"), false);
});

test("transformCommand shifts repo-root ../docs links (not bundled ../skills links) for the deeper .claude/commands/ location", () => {
  const raw = `---\ndescription: "Review UI."\n---\nSee the [Recipe Contract](../docs/ui-review-recipe-contract.md) and [Intake](../skills/docs/issue-intake-procedure.md).\n`;
  const out = transformCommand({ source: "commands/loop-review-ui.command.md", raw });
  // Repo-root docs/ is not mirrored into .claude/, so it shifts one level.
  assert.ok(out.includes("(../../docs/ui-review-recipe-contract.md)"));
  assert.equal(out.includes("(../docs/ui-review-recipe-contract.md)"), false);
  // ../skills/docs is bundled to .claude/skills/docs — the relative path is preserved verbatim.
  assert.ok(out.includes("(../skills/docs/issue-intake-procedure.md)"));
});

test("transformAgent shifts repo-root ../docs links (not bundled ../skills links) for the deeper .claude/agents/ location", () => {
  const raw = `---\nname: review\ndescription: "Gate reviewer."\ntools: [read]\n---\nSee the [Gate Contract](../docs/gate-review-sub-loop-contract.md) and [Intake](../skills/docs/issue-intake-procedure.md).\n`;
  const out = transformAgent({ source: "agents/review.agent.md", raw });
  // Repo-root docs/ is not mirrored into .claude/, so it shifts one level.
  assert.ok(out.includes("(../../docs/gate-review-sub-loop-contract.md)"));
  assert.equal(out.includes("(../docs/gate-review-sub-loop-contract.md)"), false);
  // ../skills/docs is bundled to .claude/skills/docs — the relative path is preserved verbatim.
  assert.ok(out.includes("(../skills/docs/issue-intake-procedure.md)"));
});

test("transformSkill preserves user-invocable: true for the public entry skill", () => {
  const out = transformSkill({
    source: "skills/dev-loop/SKILL.md",
    raw: SKILL_SRC.replace("user-invocable: false", "user-invocable: true"),
  });
  assert.match(out, /\nuser-invocable: true\n/);
});

// Model-tier frontmatter policy (#1134): transformAgent stamps `model:` from
// resolveRoleModel(..., { harness: "claude" }); inherit omits the field.
const agentSrcFor = (name) =>
  `---\nname: "${name}"\ndescription: "d"\ntools: [read]\n---\nBody.\n`;

test("transformAgent stamps the low tier (sonnet) for routine roles", () => {
  for (const role of ["developer", "docs", "fixer", "quality"]) {
    const out = transformAgent({ source: `agents/${role}.agent.md`, raw: agentSrcFor(role) });
    assert.match(out, /\nmodel: "sonnet"\n/, `${role} should carry model: "sonnet"`);
  }
});

test("transformAgent stamps the high tier (opus) for refiner and review", () => {
  for (const role of ["refiner", "review"]) {
    const out = transformAgent({ source: `agents/${role}.agent.md`, raw: agentSrcFor(role) });
    assert.match(out, /\nmodel: "opus"\n/, `${role} should carry model: "opus"`);
  }
});

test("transformAgent omits model: for the inherit role (dev-loop)", () => {
  const out = transformAgent({ source: "agents/dev-loop.agent.md", raw: agentSrcFor("dev-loop") });
  assert.equal(out.includes("model:"), false, "dev-loop must not carry a model field");
});

test("transformAgent honors a config override for the generated model frontmatter", () => {
  const config = { models: { roles: { developer: "gpt-5" }, roleTiers: { review: "inherit" } } };
  const dev = transformAgent({ source: "agents/developer.agent.md", raw: agentSrcFor("developer"), config });
  assert.match(dev, /\nmodel: "gpt-5"\n/);
  const review = transformAgent({ source: "agents/review.agent.md", raw: agentSrcFor("review"), config });
  assert.equal(review.includes("model:"), false, "review demoted to inherit omits the field");
});
