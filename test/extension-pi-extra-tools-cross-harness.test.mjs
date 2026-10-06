import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoleExtraTools } from "@dev-loops/core/config";
import extension from "../extension/index.ts";
import { renderPiAgent } from "../extension/sync-packaged-agents.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const PULL = "dev-loops-run scripts/github/pull-work-order.mjs j1-0123abcd";

async function judgeCall(command) {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  return await events.get("tool_call")({ toolName: "bash", input: { command } }, { getSystemPrompt: () => '<active_agent name="judge"/>' });
}

// Cross-harness non-regression: extraTools is Claude-only (see skills/docs/cross-harness-regression-contract.md).
test("Pi renders every agent identically with and without extraTools and keeps its read-only gate", async () => {
  const config = { version: 1, extraTools: { developer: ["mcp__codebase-memory"] } };
  assert.deepEqual(resolveRoleExtraTools(config, "developer"), ["mcp__codebase-memory"]);
  const renderAll = () => fs.readdirSync(path.join(repoRoot, "agents")).filter((f) => f.endsWith(".agent.md")).map((file) => renderPiAgent(fs.readFileSync(path.join(repoRoot, "agents", file), "utf8")));
  const without = renderAll();
  // "With extraTools" is the Claude launcher's session state: the rendered-role env var.
  const prior = process.env.DEVLOOPS_AGENT_OVERRIDES;
  process.env.DEVLOOPS_AGENT_OVERRIDES = "developer";
  let withExtra;
  try {
    withExtra = renderAll();
  } finally {
    if (prior === undefined) delete process.env.DEVLOOPS_AGENT_OVERRIDES;
    else process.env.DEVLOOPS_AGENT_OVERRIDES = prior;
  }
  assert.deepEqual(withExtra, without);
  for (const rendered of without) assert.equal(rendered.includes("mcp__"), false);
  assert.equal(fs.readFileSync(path.join(repoRoot, "extension/sync-packaged-agents.ts"), "utf8").includes("extraTools"), false);
  assert.deepEqual(await judgeCall(PULL), { block: false });
  assert.equal((await judgeCall("bun run test")).block, true);
});
