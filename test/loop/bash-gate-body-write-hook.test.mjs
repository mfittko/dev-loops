// Bash gate hook (#2689): raw PR/issue body writes are denied for every actor; the quick
// pre-check must not short-circuit them to allow.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });

const bash = (cwd, command, subagent) => {
  const payload = { tool_name: "Bash", tool_input: { command }, cwd, ...(subagent ? { agent_type: "developer", agent_id: "agent-a" } : {}) };
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: env() });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withManagedRepo(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: env() });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/mfittko/dev-loops.git"], { cwd: root, env: env() });
    writeFileSync(path.join(root, ".devloops"), "{}\n");
    await fn(root);
  }, { prefix: "dev-loops-body-write-hook-" });
}

test("raw PR and issue body writes are denied for the main agent and subagents", async () => {
  await withManagedRepo(async (root) => {
    const denied = [
      ["gh pr edit 5 --body-file pr.md", "pr edit"],
      ["gh pr edit 5 --body 'adr-tripwire:allow because'", "pr edit"],
      ["gh api -X PATCH repos/mfittko/dev-loops/pulls/5 -f body=x", "pr edit"],
      ["gh issue edit 5 --body-file i.md", "issue edit"],
      ["gh api -X PATCH repos/mfittko/dev-loops/issues/5 -f body=x", "issue edit"],
    ];
    for (const subagent of [true, false]) {
      for (const [command, launcher] of denied) {
        const { decision, reason } = bash(root, command, subagent);
        assert.equal(decision, "deny", `${subagent ? "subagent" : "main"}: ${command}`);
        assert.ok(reason.includes(`cli/index.mjs ${launcher}`), reason);
      }
    }
  });
});

test("non-body PR commands pass for the main agent and subagents", async () => {
  await withManagedRepo(async (root) => {
    for (const subagent of [true, false]) {
      for (const command of ["gh pr view 5", "gh pr edit 5 --add-label x"]) {
        assert.equal(bash(root, command, subagent).decision, "allow", `${subagent ? "subagent" : "main"}: ${command}`);
      }
    }
  });
});
