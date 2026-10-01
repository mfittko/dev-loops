import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoleExtraTools } from "@dev-loops/core/config";
import extension from "../extension/index.ts";
import { renderPiAgent } from "../extension/sync-packaged-agents.ts";
import { AGENT_TYPE_ENV } from "../extension/readonly-role-gate.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const PULL = "dev-loops-run scripts/github/pull-work-order.mjs j1-0123abcd";

async function judgeCall(command) {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  const prior = process.env[AGENT_TYPE_ENV];
  process.env[AGENT_TYPE_ENV] = "judge";
  try {
    return await events.get("tool_call")({ toolName: "bash", input: { command } }, {});
  } finally {
    if (prior === undefined) delete process.env[AGENT_TYPE_ENV];
    else process.env[AGENT_TYPE_ENV] = prior;
  }
}

// Cross-harness non-regression: extraTools is Claude-only (see skills/docs/cross-harness-regression-contract.md).
test("Pi renders every agent identically with and without extraTools and keeps its read-only gate", async () => {
  const config = { version: 1, extraTools: { developer: ["mcp__codebase-memory"] } };
  assert.deepEqual(resolveRoleExtraTools(config, "developer"), ["mcp__codebase-memory"]);
  for (const file of fs.readdirSync(path.join(repoRoot, "agents")).filter((f) => f.endsWith(".agent.md"))) {
    const rendered = renderPiAgent(fs.readFileSync(path.join(repoRoot, "agents", file), "utf8"));
    assert.equal(rendered.includes("mcp__"), false, file);
  }
  assert.equal(fs.readFileSync(path.join(repoRoot, "extension/sync-packaged-agents.ts"), "utf8").includes("extraTools"), false);
  assert.deepEqual(await judgeCall(PULL), { block: false });
  assert.equal((await judgeCall("bun run test")).block, true);
});
