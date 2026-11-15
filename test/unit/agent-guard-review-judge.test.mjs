import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { withTempDir } from "../_helpers.mjs";

const GUARD = path.resolve(import.meta.dirname, "../../.claude/hooks/pre-tool-use-agent-guard.mjs");
const ID = "j1790000000000-abcdef12";
const POINTER = `Run \`dev-loops-run scripts/github/pull-work-order.mjs ${ID}\`; follow its printed work order exactly. Exit 1: report its JSON verbatim, stop.`;

const runGuard = (cwd, agentType, prompt) => {
  const r = spawnSync("node", [GUARD], { cwd, encoding: "utf8", env: { ...process.env, DEVLOOPS_AGENT_OVERRIDES: undefined }, input: JSON.stringify({ agent_type: agentType, cwd, tool_input: { subagent_type: "dev-loops:judge", prompt } }) });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : { permissionDecision: "allow" };
};

async function checkout(dir, gate) {
  assert.equal(spawnSync("git", ["init", "-q", dir]).status, 0);
  const index = path.join(dir, "tmp", "work-order-executions");
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, `${ID}.json`), JSON.stringify({ executionIdentity: ID, workOrderRef: `judge:o/r#7:${gate}:abc123:${ID}`, workOrderDigest: "d" }));
}

test("#3199: dev-loop may dispatch the indexed review-gate judge pointer, with trailing whitespace", async () => {
  await withTempDir(async (dir) => {
    await checkout(dir, "review");
    assert.equal(runGuard(dir, "dev-loops:dev-loop", POINTER).permissionDecision, "allow");
    assert.equal(runGuard(dir, "dev-loops:dev-loop", `${POINTER}\n`).permissionDecision, "allow");
  });
});

test("#3199: dev-loop judge dispatch resolving to a lifecycle gate stays denied with a diagnostic", async () => {
  await withTempDir(async (dir) => {
    await checkout(dir, "draft_gate");
    const d = runGuard(dir, "dev-loops:dev-loop", POINTER);
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /^GATE_COORDINATOR_REQUIRED.*resolved to gate draft_gate/);
  });
});
