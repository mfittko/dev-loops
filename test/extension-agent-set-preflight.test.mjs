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
  return events.get("tool_call")({ toolName: "subagent", input: { agent: "quality" } }, { cwd });
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
