// Issue #2965 (decision record 0206): the Claude PreToolUse Bash gate short-circuits to allow on a
// command shape its quick pre-check list does not name, before the shared `decideBashGateDeny` ever
// runs. The `timeout N <sanctioned tool>` deny (issue 2755) is decided in the shared module, so a
// missing pre-check entry allowed on Claude exactly what the Pi `tool_call` gate denied — a parity
// inversion in the change whose purpose is that neither harness denies what the other allows.
//
// This drives the REAL hook script (`bash()` in test/loop/fixer-pull-line-hook.test.mjs is the
// harness this mirrors), not the decider the parity contract test already covers.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });

const bash = (cwd, command, agentType) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType !== undefined) input.agent_type = agentType;
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: env() });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withManagedRepo(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: env() });
    fs.writeFileSync(path.join(root, ".devloops"), "version: 1\n", "utf8");
    await fn(root);
  }, { prefix: "dev-loops-bash-gate-hook-" });
}

test("a timeout-wrapped sanctioned command reaches the decider and is denied, for every actor", async () => {
  await withManagedRepo(async (root) => {
    const command = "timeout 300 dev-loops-run scripts/github/merge-pr.mjs --repo acme/widgets --pr 5";
    for (const agentType of [undefined, "developer", "dev-loop"]) {
      const { decision, reason } = bash(root, command, agentType);
      assert.equal(decision, "deny", `agent_type ${String(agentType)}`);
      assert.match(reason, /Do not wrap sanctioned dev-loops commands in `timeout N`/, String(agentType));
    }
    // The pre-check must not turn the hook into a blanket deny: the same script run bare still
    // passes through (the merge wrapper is the sanctioned path).
    assert.equal(bash(root, "dev-loops-run scripts/github/merge-pr.mjs --repo acme/widgets --pr 5").decision, "allow");
  });
});
