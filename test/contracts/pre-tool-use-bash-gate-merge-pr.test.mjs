import assert from "node:assert/strict";
import { test } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Acceptance test: the real PreToolUse Bash hook denies a subagent merge-pr.mjs run without
// --check (issue 2500). All cases run unconditionally.
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const hook = path.join(repoRoot, ".claude", "hooks", "pre-tool-use-bash-gate.mjs");

const MERGE = "dev-loops-run scripts/github/merge-pr.mjs --repo mfittko/dev-loops --pr 5 --human-approved-by u";

function decide(command, agent_type) {
  const payload = { tool_name: "Bash", tool_input: { command }, cwd: repoRoot };
  if (agent_type) payload.agent_type = agent_type;
  const res = spawnSync("node", [hook], { input: JSON.stringify(payload), encoding: "utf8" });
  const json = res.stdout.trim() ? JSON.parse(res.stdout) : null;
  return json?.hookSpecificOutput?.permissionDecision ?? "allow";
}

test("a dev-loop subagent running merge-pr.mjs without --check is denied (issue 2500)", () => {
  assert.equal(decide(MERGE, "dev-loop"), "deny");
});

test("a dev-loop subagent running merge-pr.mjs --check is allowed (issue 2500)", () => {
  assert.equal(decide(`${MERGE} --check`, "dev-loop"), "allow");
});

test("the top-level session (no agent_type) running merge-pr.mjs is allowed (issue 2500)", () => {
  assert.equal(decide(MERGE), "allow");
});
