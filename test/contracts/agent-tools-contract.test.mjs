import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "bun:test";

const repoRoot = new URL("../../", import.meta.url);
// #2854: canonical Pi child allowlists and their Claude capability projection.
// #1659 set the precedent: unavailable source tools must not reach child launch.
// Raw-source `search` stays rejected under Pi until the .pi/agents render slice (#2865);
// this slice removes only the redundant `execute` (shell execution uses bash).
const claudeTools = {
  read: ["Read"],
  search: ["Grep", "Glob"],
  bash: ["Bash"],
  edit: ["Edit"],
  write: ["Write"],
  subagent: ["Agent"],
};
const supportedTools = new Set(Object.keys(claudeTools));

function readTools(file) {
  const raw = fs.readFileSync(new URL(file, repoRoot), "utf8");
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  assert.ok(frontmatter, `${file}: missing frontmatter`);
  const tools = frontmatter.match(/^tools: (.+)$/m)?.[1];
  assert.ok(tools, `${file}: missing tools allowlist`);
  return tools.split(",").map((tool) => tool.trim());
}

function assertSupportedTools(tools, file) {
  assert.ok(!(tools.includes("execute") && tools.includes("bash")),
    `${file}: execute is redundant with bash and unavailable to Pi children`);
  for (const tool of tools) {
    assert.ok(supportedTools.has(tool), `${file}: unsupported canonical tool ${tool}`);
  }
}

test("canonical agent tools are child-safe and retain Claude capabilities", () => {
  const agents = fs.readdirSync(new URL("agents/", repoRoot))
    .filter((file) => file.endsWith(".agent.md")).sort();
  assert.ok(agents.length > 0);
  for (const agent of agents) {
    const file = `agents/${agent}`;
    const tools = readTools(file);
    assertSupportedTools(tools, file);
    const mirror = `.claude/agents/${agent.replace(/\.agent\.md$/, ".md")}`;
    assert.deepEqual(readTools(mirror), tools.flatMap((tool) => claudeTools[tool]),
      `${mirror}: Claude tool capabilities must match ${file}`);
  }
});

test("agent tool lint rejects unsupported names and redundant execute with bash", () => {
  assert.throws(() => assertSupportedTools(["read", "unknown"], "fixture.agent.md"),
    /fixture\.agent\.md: unsupported canonical tool unknown/);
  assert.throws(() => assertSupportedTools(["execute"], "fixture.agent.md"),
    /fixture\.agent\.md: unsupported canonical tool execute/);
  assert.throws(() => assertSupportedTools(["read", "execute", "bash"], "fixture.agent.md"),
    /fixture\.agent\.md: execute is redundant with bash/);
});
