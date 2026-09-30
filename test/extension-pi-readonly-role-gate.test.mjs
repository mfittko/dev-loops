import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { READONLY_SUBAGENT_ROLES } from "@dev-loops/core/claude/hook-decisions";
import extension from "../extension/index.ts";
import { mapAgentToolsForPi, renderPiAgent } from "../extension/sync-packaged-agents.ts";
import { BASH_RESTRICTED_ROLES, AGENT_TYPE_ENV } from "../extension/readonly-role-gate.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const PULL = "dev-loops-run scripts/github/pull-work-order.mjs j1-0123abcd";

// Registers the extension on a Pi double and returns the real `tool_call` handler.
function toolCallHandler() {
  const events = new Map();
  extension({ on: (e, h) => events.set(e, h), registerCommand() {}, exec: async () => ({ code: 0 }) });
  return events.get("tool_call");
}

async function callAs(role, command, toolName = "bash") {
  const prior = process.env[AGENT_TYPE_ENV];
  if (role === undefined) delete process.env[AGENT_TYPE_ENV];
  else process.env[AGENT_TYPE_ENV] = role;
  try {
    return await toolCallHandler()({ toolName, input: { command } }, {});
  } finally {
    if (prior === undefined) delete process.env[AGENT_TYPE_ENV];
    else process.env[AGENT_TYPE_ENV] = prior;
  }
}

test("Pi judge runs the sanctioned pull and nothing else (J7)", async () => {
  assert.deepEqual(await callAs("judge", PULL), { block: false });
  assert.deepEqual(await callAs("dev-loops:judge", PULL), { block: false });
  for (const cmd of ["rm -rf /", "bun run test", `${PULL} && ls`, `${PULL}; id`, "git diff", "cat README.md"]) {
    assert.equal((await callAs("judge", cmd)).block, true, cmd);
  }
});

test("Pi reviewer reads and searches but cannot run tests or builds", async () => {
  for (const cmd of ["git diff origin/main...HEAD", "grep -rn foo src", "rg foo", "cat README.md", PULL]) {
    assert.deepEqual(await callAs("review", cmd), { block: false }, cmd);
  }
  for (const cmd of ["bun run test", "npm test", "bun run build", "node script.mjs", "cat a > b", "git push", "grep x $(id)", "ls; bun test"]) {
    assert.equal((await callAs("review", cmd)).block, true, cmd);
  }
});

test("Pi tool_call fails closed on a blank marker and leaves the unmarked and non-read-only callers alone", async () => {
  assert.equal((await callAs("", "ls")).block, true);
  assert.deepEqual(await callAs(undefined, "bun run test"), { block: false });
  assert.deepEqual(await callAs("developer", "bun run test"), { block: false });
  assert.deepEqual(await callAs("judge", "bun run test", "read"), { block: false });
});

function toolsOf(file) {
  return /^tools:\s*(.*)$/m.exec(fs.readFileSync(path.join(repoRoot, file), "utf8"))[1].split(/[\s,]+/).filter(Boolean);
}

test("source agents, generated .claude assets and the Pi mapping agree on read-only role capabilities", () => {
  for (const role of BASH_RESTRICTED_ROLES) {
    assert.ok(READONLY_SUBAGENT_ROLES.includes(role), role);
    const source = toolsOf(`agents/${role}.agent.md`);
    const claude = toolsOf(`.claude/agents/${role}.md`).map((t) => t.toLowerCase());
    const pi = toolsOf(`agents/${role}.agent.md`) && mapAgentToolsForPi(source);
    const piRendered = renderPiAgent(fs.readFileSync(path.join(repoRoot, `agents/${role}.agent.md`), "utf8"));
    assert.deepEqual(toolsOfText(piRendered), pi);
    // Shell access exists on all three surfaces; the Pi gate restricts it to the role's allowed operations.
    assert.equal(source.includes("bash"), claude.includes("bash"), role);
    assert.equal(pi.includes("bash"), claude.includes("bash"), role);
    // Write access agrees across the three surfaces.
    for (const tool of ["edit", "write"]) {
      assert.equal(pi.includes(tool), claude.includes(tool), `${role} ${tool}`);
    }
  }
});

function toolsOfText(text) {
  return /^tools:\s*(.*)$/m.exec(text)[1].split(/[\s,]+/).filter(Boolean);
}

test("the Pi pull-line matcher agrees with the Claude gate's parseSanctionedPullLine", async () => {
  const { parseSanctionedPullLine } = await import("@dev-loops/core/claude/hook-decisions");
  const lines = [
    PULL,
    "dev-loops-run scripts/github/pull-work-order.mjs --ref r1 --digest abc --execution j1-0123abcd",
    `${PULL} extra`,
    `${PULL}; id`,
    "dev-loops-run scripts/github/pull-work-order.mjs",
    "node scripts/github/pull-work-order.mjs j1-0123abcd",
  ];
  for (const line of lines) {
    assert.equal((await callAs("judge", line)).block, parseSanctionedPullLine(line) === null, line);
  }
});
