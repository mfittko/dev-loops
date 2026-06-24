import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOL_NAME_MAP,
  mapTool,
  mapTools,
  splitFrontmatter,
  stripPiOnlyBlocks,
  transformAgent,
  transformSkill,
} from "../src/claude/asset-generation.mjs";

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
  assert.match(out, /^---\nname: "developer"\ndescription: "Implements code\."\ntools: Read, Grep, Glob, Bash, Edit, Write\n---\n/);
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

test("transformSkill preserves user-invocable: true for the public entry skill", () => {
  const out = transformSkill({
    source: "skills/dev-loop/SKILL.md",
    raw: SKILL_SRC.replace("user-invocable: false", "user-invocable: true"),
  });
  assert.match(out, /\nuser-invocable: true\n/);
});
