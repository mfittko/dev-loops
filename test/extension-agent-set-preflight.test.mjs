import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initGitFixture, runGitFixture } from "./_helpers.mjs";
import extension from "../extension/index.ts";
import { findProjectRoot, renderProjectAgents } from "../extension/sync-packaged-agents.ts";

const repoRoot = path.resolve(new URL("../", import.meta.url).pathname);
const RAW = "---\nname: quality\ntools: read, search, execute\n---\nbody\n";
const RENDERED = "---\nname: quality\ntools: read, grep, find, ls, bash\n---\nbody\n";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-set-"));
}

function writeAt(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function dl(dir) {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "dev-loops" }));
}

function launch(cwd, input = { agent: "quality" }) {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  return events.get("tool_call")({ toolName: "subagent", input }, { cwd });
}

async function withHome(fn) {
  const prev = process.env.HOME;
  const home = tmpProject();
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withProject(fn) {
  const root = tmpProject();
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a raw rendered dev-loops file blocks the launch and names its path and tokens", () =>
  withProject(async (root) => {
    dl(root);
    const file = path.join(root, ".pi", "agents", "quality.agent.md");
    writeAt(file, RAW);
    const res = await launch(root);
    assert.equal(res.block, true);
    assert.match(res.reason, /^agent_set_not_rendered/);
    assert.ok(res.reason.includes(file));
    assert.ok(res.reason.includes("search, execute"));
  }));

test("a consumer root with its own raw agents is never blocked", () =>
  withProject(async (root) => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "some-consumer" }));
    writeAt(path.join(root, ".pi", "agents", "developer.agent.md"), "---\nname: developer\ntools: read, search, execute\n---\nbody\n");
    writeAt(path.join(root, ".pi", "agents", "my-consumer-agent.agent.md"), RAW);
    assert.deepEqual(await launch(root, { agent: "developer" }), { block: false });
    assert.deepEqual(await launch(root, { agent: "my-consumer-agent" }), { block: false });
  }));

test("a symlink to the raw agent sources is refused", () =>
  withProject(async (root) => {
    dl(root);
    fs.mkdirSync(path.join(root, ".pi"));
    fs.symlinkSync(path.join(repoRoot, "agents"), path.join(root, ".pi", "agents"));
    const res = await launch(root);
    assert.match(res.reason, /^agent_set_not_rendered/);
    assert.match(res.reason, /search/);
  }));

test("render output passes", () =>
  withProject(async (root) => {
    dl(root);
    renderProjectAgents(root);
    assert.deepEqual(await launch(root), { block: false });
  }));

test("an absent .pi/agents passes", () =>
  withProject(async (root) => {
    dl(root);
    assert.deepEqual(await launch(root), { block: false });
    assert.equal(fs.existsSync(path.join(root, ".pi", "agents")), false);
  }));

test("the dev-loops remedy names provision-worktree and a session restart", () =>
  withProject(async (root) => {
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    dl(root);
    const own = (await launch(root)).reason;
    assert.match(own, /provision-worktree\.mjs --worktree-path <worktree> --repo-root <main-checkout>/);
    assert.match(own, /restart the Pi session/);
  }));

test("the project root is the nearest ancestor holding .pi or .agents, not .git", () =>
  withProject(async (root) => {
    dl(root);
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    const sub = path.join(root, "packages", "core");
    fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
    assert.match((await launch(sub)).reason, /^agent_set_not_rendered/);
    const alone = path.join(root, "alone");
    fs.mkdirSync(path.join(alone, ".git"), { recursive: true });
    dl(alone);
    writeAt(path.join(alone, ".pi", "agents", "quality.agent.md"), RENDERED);
    assert.deepEqual(await launch(alone), { block: false });
  }));

test("input.cwd, relative or absolute, selects the checked project", () =>
  withProject(async (root) => {
    const wt = path.join(root, "wt");
    dl(wt);
    writeAt(path.join(wt, ".pi", "agents", "quality.agent.md"), RAW);
    const clean = path.join(root, "clean");
    dl(clean);
    fs.mkdirSync(path.join(clean, ".pi"), { recursive: true });
    assert.equal((await launch(clean, { agent: "quality", cwd: wt })).block, true);
    assert.equal((await launch(clean, { agent: "quality", cwd: "../wt" })).block, true);
    assert.equal((await launch(clean, { agent: "quality", options: { cwd: wt } })).block, true);
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

test("a cwd that names a file does not throw in the project-root walk", () =>
  withProject(async (root) => {
    const file = path.join(root, "afile");
    fs.writeFileSync(file, "x");
    assert.doesNotThrow(() => findProjectRoot(path.join(file, "child")));
    dl(root);
    assert.deepEqual(await launch(root, { agent: "quality", cwd: file }), { block: false });
  }));

test("session_start syncs the resolved project root", () =>
  withProject(async (root) => {
    dl(root);
    writeAt(path.join(root, "agents", "quality.agent.md"), RAW);
    writeAt(path.join(root, ".pi", "agents", "quality.agent.md"), RAW);
    const sub = path.join(root, "packages", "core");
    fs.mkdirSync(sub, { recursive: true });
    const events = new Map();
    extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
    await withHome(() => events.get("session_start")({}, { cwd: sub, getSessionId: () => "s" }));
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, ".pi", "agents", "quality.agent.md"), "utf8"),
      /tools:.*\b(search|execute)\b/,
    );
    assert.deepEqual(await launch(sub), { block: false });
    assert.equal(fs.existsSync(path.join(sub, ".pi")), false);
  }));

test("session_start renders .pi/agents in a fresh dev-loops-shaped clone", () =>
  withProject(async (root) => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dev-loops" }));
    writeAt(path.join(root, "agents", "quality.agent.md"), "---\nname: quality\ntools: read, search, execute, bash\n---\nbody\n");
    fs.writeFileSync(path.join(root, ".devloops"), "version: 1\nmodels:\n  tiers:\n    low:\n      claude: sonnet\n      pi: test/pinned-model\n  roleTiers:\n    quality: low\n");
    const events = new Map();
    extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
    await withHome(() => events.get("session_start")({}, { cwd: root, getSessionId: () => "s" }));
    const dir = path.join(root, ".pi", "agents");
    assert.match(fs.readFileSync(path.join(dir, "quality.agent.md"), "utf8"), /^model: "test\/pinned-model"$/m);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.deepEqual(await launch(root), { block: false });
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "quality.agent.md"), "utf8"), /tools:.*\b(search|execute)\b/);
  }));

test("session_start in a git main checkout leaves git status empty with a real .pi/agents directory", () =>
  withProject(async (root) => {
    initGitFixture(root, { commit: null });
    fs.copyFileSync(path.join(repoRoot, ".gitignore"), path.join(root, ".gitignore"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dev-loops" }));
    writeAt(path.join(root, "agents", "quality.agent.md"), "---\nname: quality\ntools: read, search, execute, bash\n---\nbody\n");
    runGitFixture(root, ["add", "-A"]);
    runGitFixture(root, ["commit", "-q", "-m", "init"]);
    const events = new Map();
    extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
    await withHome(() => events.get("session_start")({}, { cwd: root, getSessionId: () => "s" }));
    const dir = path.join(root, ".pi", "agents");
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "quality.agent.md"), "utf8"), /tools:.*\b(search|execute)\b/);
    assert.equal(runGitFixture(root, ["status", "--porcelain", "--untracked-files=all"]), "");
  }));

test("session_start leaves a consumer root with its own agents/ without .pi/agents", () =>
  withProject(async (root) => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "some-consumer" }));
    writeAt(path.join(root, "agents", "x.agent.md"), "---\nname: x\ntools: read\n---\nbody\n");
    const events = new Map();
    extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
    await withHome(() => events.get("session_start")({}, { cwd: root, getSessionId: () => "s" }));
    assert.equal(fs.existsSync(path.join(root, ".pi", "agents")), false);
  }));

test("a tracked .pi/agents symlink refusal names the rebase step, the path and the tokens", () =>
  withProject(async (root) => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dev-loops" }));
    writeAt(path.join(root, "agents", "quality.agent.md"), RAW);
    fs.mkdirSync(path.join(root, ".pi"));
    fs.symlinkSync("../agents", path.join(root, ".pi", "agents"));
    const { checkAgentSetRendered } = await import("../extension/sync-packaged-agents.ts");
    const reason = checkAgentSetRendered(root, path.join(root, "agents"));
    assert.match(reason, /Rebase or merge the branch onto main first/);
    assert.match(reason, /quality\.agent\.md \(search, execute\)/);
    assert.match(reason, /cannot read Pi's project-trust state/);
  }));

test("a raw global copy is never checked", () =>
  withProject(async (root) => {
    dl(root);
    const prev = process.env.HOME;
    const home = tmpProject();
    process.env.HOME = home;
    try {
      writeAt(path.join(home, ".agents", "quality.agent.md"), RAW);
      assert.deepEqual(await launch(root), { block: false });
    } finally {
      process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }));

test("an unreadable or missing packaged agents source refuses", () =>
  withProject(async (root) => {
    const { checkAgentSetRendered } = await import("../extension/sync-packaged-agents.ts");
    dl(root);
    const missing = path.join(root, "no-such-source");
    assert.match(checkAgentSetRendered(root, missing), /^agent_set_not_rendered.*no-such-source/);
    assert.match(checkAgentSetRendered(root, missing), /cannot read Pi's project-trust state/);
    const notDir = path.join(root, "file-source");
    fs.writeFileSync(notDir, "x");
    assert.match(checkAgentSetRendered(root, notDir), /^agent_set_not_rendered.*file-source/);
  }));

test("a directory at a rendered name refuses while a missing file passes", () =>
  withProject(async (root) => {
    const { checkAgentSetRendered } = await import("../extension/sync-packaged-agents.ts");
    dl(root);
    const src = path.join(root, "src");
    writeAt(path.join(src, "quality.agent.md"), RENDERED);
    assert.equal(checkAgentSetRendered(root, src), null);
    const asDir = path.join(root, ".pi", "agents", "quality.agent.md");
    fs.mkdirSync(asDir, { recursive: true });
    const res = checkAgentSetRendered(root, src);
    assert.match(res, /^agent_set_not_rendered/);
    assert.ok(res.includes(`${asDir} (unreadable)`));
  }));
