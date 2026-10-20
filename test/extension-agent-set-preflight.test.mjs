import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../extension/index.ts";
import { renderProjectAgents } from "../extension/sync-packaged-agents.ts";

const repoRoot = path.resolve(new URL("../", import.meta.url).pathname);

function subagentCall(cwd) {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  return events.get("tool_call")({ toolName: "subagent", input: { agent: "quality", options: { agentScope: "project" } } }, { cwd });
}

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-set-"));
}

test("#2865 subagent launch is refused when .pi/agents holds raw search/execute tokens", async () => {
  const root = tmpProject();
  try {
    fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pi", "agents", "quality.agent.md"), "---\nname: quality\ntools: read, search, execute, bash\n---\nbody\n");
    const res = await subagentCall(root);
    assert.equal(res.block, true);
    assert.match(res.reason, /^agent_set_not_rendered/);
    assert.ok(res.reason.includes(path.join(root, ".pi", "agents", "quality.agent.md")));
    assert.ok(res.reason.includes("search") && res.reason.includes("execute"));
    assert.match(res.reason, /ensure-worktree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#2865 a symlink to the raw agent sources is refused", async () => {
  const root = tmpProject();
  try {
    fs.mkdirSync(path.join(root, ".pi"));
    fs.symlinkSync(path.join(repoRoot, "agents"), path.join(root, ".pi", "agents"));
    const res = await subagentCall(root);
    assert.match(res.reason, /^agent_set_not_rendered/);
    assert.match(res.reason, /search/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#2865 a rendered set is allowed", async () => {
  const root = tmpProject();
  try {
    renderProjectAgents(root);
    assert.deepEqual(await subagentCall(root), { block: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#2865 an absent .pi/agents is allowed (consumer repos resolve from ~/.agents)", async () => {
  const root = tmpProject();
  try {
    assert.deepEqual(await subagentCall(root), { block: false });
    assert.equal(fs.existsSync(path.join(root, ".pi", "agents")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const RAW = "---\nname: quality\ntools: read, search, execute\n---\nbody\n";
const RENDERED = "---\nname: quality\ntools: read, grep, find, ls, bash\n---\nbody\n";

async function withHome(fn) {
  const root = tmpProject();
  const home = tmpProject();
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(root, home);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeAt(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function launch(cwd, input) {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  return events.get("tool_call")({ toolName: "subagent", input }, { cwd });
}

for (const [label, parts] of [
  ["npm", [".pi", "agent", "npm", "node_modules", "dev-loops", "agents"]],
  ["git", [".pi", "agent", "git", "github.com", "mfittko", "dev-loops", "agents"]],
]) {
  test(`stale global ${label} copy is refused with its path named, and ignored under agentScope project`, () =>
    withHome(async (root, home) => {
      const file = path.join(home, ...parts, "quality.agent.md");
      writeAt(file, RAW);
      const res = await launch(root, { tasks: [{ agent: "dev-loops:quality" }] });
      assert.equal(res.block, true);
      assert.match(res.reason, /^agent_set_not_rendered/);
      assert.ok(res.reason.includes(file));
      assert.ok(res.reason.includes("search, execute"));
      assert.deepEqual(await launch(root, { agent: "quality", options: { agentScope: "project" } }), { block: false });
    }));
}

test("a rendered global copy is allowed", () =>
  withHome(async (root, home) => {
    writeAt(path.join(home, ".agents", "quality.agent.md"), RENDERED);
    assert.deepEqual(await launch(root, { chain: [{ agent: "quality" }] }), { block: false });
  }));

test("a requested non-dev-loops agent is not checked against global copies", () =>
  withHome(async (root, home) => {
    writeAt(path.join(home, ".agents", "quality.agent.md"), RAW);
    assert.deepEqual(await launch(root, { agent: "scout" }), { block: false });
  }));
