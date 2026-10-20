import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../extension/index.ts";
import { findProjectRoot, renderProjectAgents } from "../extension/sync-packaged-agents.ts";

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
    assert.match(res.reason, /provision-worktree/);
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

const PKG_GIT = [".pi", "agent", "git", "github.com", "mfittko", "dev-loops", "agents"];
const PKG_NPM = [".pi", "agent", "npm", "node_modules", "dev-loops", "agents"];

for (const [label, parts] of [["git", PKG_GIT], ["npm", PKG_NPM]]) {
  test(`a rendered ~/.agents copy shadows a raw ${label} package copy and the launch is allowed`, () =>
    withHome(async (root, home) => {
      writeAt(path.join(home, ...parts, "quality.agent.md"), RAW);
      writeAt(path.join(home, ".agents", "quality.agent.md"), RENDERED);
      assert.deepEqual(await launch(root, { agent: "quality" }), { block: false });
    }));
}

for (const [label, parts] of [["~/.agents", [".agents"]], ["~/.pi/agent/agents", [".pi", "agent", "agents"]]]) {
  test(`a raw ${label} role copy is refused with a global remedy`, () =>
    withHome(async (root, home) => {
      const file = path.join(home, ...parts, "quality.agent.md");
      writeAt(file, RAW);
      const res = await launch(root, { agent: "quality" });
      assert.equal(res.block, true);
      assert.match(res.reason, /^agent_set_not_rendered/);
      assert.ok(res.reason.includes(file));
      assert.match(res.reason, /agentScope/);
      assert.doesNotMatch(res.reason, /provision-worktree/);
    }));
}

test("a project offender gets the provisioning remedy, not the global one", () =>
  withHome(async (root) => {
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    const res = await launch(root, { agent: "quality" });
    assert.match(res.reason, /provision-worktree\.mjs --worktree-path <worktree> --repo-root <main-checkout>/);
    assert.match(res.reason, /restart the Pi session/);
    assert.doesNotMatch(res.reason, /agentScope/);
  }));

test("the project root is the nearest ancestor holding .pi or .agents, not .git", () =>
  withHome(async (root) => {
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    const sub = path.join(root, "packages", "core");
    fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
    assert.match((await launch(sub, { agent: "quality" })).reason, /^agent_set_not_rendered/);
    const alone = path.join(root, "alone");
    fs.mkdirSync(path.join(alone, ".git"), { recursive: true });
    writeAt(path.join(alone, ".pi", "agents", "quality.agent.md"), RENDERED);
    assert.deepEqual(await launch(alone, { agent: "quality" }), { block: false });
    const agentsRoot = path.join(root, "viaAgents");
    fs.mkdirSync(path.join(agentsRoot, ".agents"), { recursive: true });
    const deep = path.join(agentsRoot, "x", "y");
    fs.mkdirSync(deep, { recursive: true });
    assert.deepEqual(await launch(deep, { agent: "quality" }), { block: false });
  }));

test("a launch from a subdirectory checks the project root's raw .pi/agents", () =>
  withHome(async (root) => {
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    const sub = path.join(root, "packages", "core");
    fs.mkdirSync(sub, { recursive: true });
    const res = await launch(sub, { agent: "quality" });
    assert.match(res.reason, /^agent_set_not_rendered/);
  }));

test("model-schema options.tasks, nested chain parallel steps and input.cwd are inspected", () =>
  withHome(async (root, home) => {
    writeAt(path.join(home, ".agents", "quality.agent.md"), RAW);
    for (const input of [
      { options: { tasks: [{ agent: "quality" }] } },
      { chain: [{ parallel: [{ agent: "quality" }] }] },
      { options: { chain: [{ parallel: [{ agent: "quality" }] }] } },
    ]) {
      assert.equal((await launch(root, input)).block, true);
    }
    writeAt(path.join(home, ".agents", "quality.agent.md"), RENDERED);
    const wt = path.join(root, "wt");
    writeAt(path.join(wt, ".pi", "agents", "quality.agent.md"), RAW);
    const clean = path.join(root, "clean");
    fs.mkdirSync(path.join(clean, ".pi"), { recursive: true });
    assert.equal((await launch(clean, { agent: "quality", cwd: wt })).block, true);
    assert.equal((await launch(clean, { agent: "quality", cwd: "../wt" })).block, true);
  }));

test("a spaced namespaced name is normalized and a non-array tasks value does not throw", () =>
  withHome(async (root, home) => {
    writeAt(path.join(home, ".agents", "quality.agent.md"), RAW);
    assert.equal((await launch(root, { agent: "dev-loops: quality" })).block, true);
    assert.deepEqual(await launch(root, { tasks: "quality", chain: { agent: "quality" } }), { block: false });
  }));

test("the project-root walk stops at the home directory", () => {
  const home = tmpProject();
  try {
    fs.mkdirSync(path.join(home, ".pi"));
    const cwd = path.join(home, "work", "proj");
    fs.mkdirSync(cwd, { recursive: true });
    assert.equal(findProjectRoot(cwd, home), cwd);
    fs.mkdirSync(path.join(home, "work", ".pi"));
    assert.equal(findProjectRoot(cwd, home), path.join(home, "work"));
    assert.equal(findProjectRoot(home, home), home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the project remedy names the resolved project root and session_start syncs that root", () =>
  withHome(async (root, home) => {
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    const sub = path.join(root, "packages", "core");
    fs.mkdirSync(sub, { recursive: true });
    const res = await launch(sub, { agent: "quality" });
    assert.ok(res.reason.includes(path.join(root, ".pi", "agents")));
    const events = new Map();
    extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
    await events.get("session_start")({}, { cwd: sub, getSessionId: () => "s" });
    assert.deepEqual(await launch(sub, { agent: "quality" }), { block: false });
    assert.equal(fs.existsSync(path.join(sub, ".pi")), false);
  }));

test("agentScope user refuses a raw global copy even when the project set is rendered", () =>
  withHome(async (root, home) => {
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RENDERED);
    const file = path.join(home, ".agents", "quality.agent.md");
    writeAt(file, RAW);
    assert.deepEqual(await launch(root, { agent: "quality" }), { block: false });
    const res = await launch(root, { agent: "quality", agentScope: "user" });
    assert.equal(res.block, true);
    assert.ok(res.reason.includes(file));
    writeAt(file, RENDERED);
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    assert.deepEqual(await launch(root, { agent: "quality", agentScope: "user" }), { block: false });
  }));

test("agentScope project keeps the home walk boundary and skips the global roots", () =>
  withHome(async (root, home) => {
    writeAt(path.join(home, ".pi", "agents", "quality.agent.md"), RAW);
    const cwd = path.join(home, "work", "proj");
    fs.mkdirSync(cwd, { recursive: true });
    assert.deepEqual(await launch(cwd, { agent: "quality", options: { agentScope: "project" } }), { block: false });
  }));

test("a cwd that names a file does not throw in the project-root walk", () =>
  withHome(async (root) => {
    const file = path.join(root, "afile");
    fs.writeFileSync(file, "x");
    assert.doesNotThrow(() => findProjectRoot(path.join(file, "child")));
    assert.deepEqual(await launch(root, { agent: "quality", cwd: file }), { block: false });
  }));

test("session_start renders .pi/agents in a fresh dev-loops-shaped clone", () =>
  withHome(async (root) => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dev-loops" }));
    writeAt(path.join(root, "agents", "quality.agent.md"), "---\nname: quality\ntools: read, search, execute, bash\n---\nbody\n");
    const events = new Map();
    extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
    await events.get("session_start")({}, { cwd: root, getSessionId: () => "s" });
    const dir = path.join(root, ".pi", "agents");
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.deepEqual(await launch(root, { agent: "quality" }), { block: false });
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "quality.agent.md"), "utf8"), /tools:.*\b(search|execute)\b/);
  }));
