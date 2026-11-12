// The Claude Bash hook allows any command its quick pre-check does not name, before the shared
// decider runs. The raw comment-write and standing-authorization shapes must reach the decider.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });

const bash = (cwd, command, agentType) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd, ...(agentType ? { agent_type: agentType } : {}) };
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
    execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: root, env: env() });
    writeFileSync(path.join(root, ".devloops"), "version: 1\n");
    await fn(root);
  }, { prefix: "dev-loops-owned-line-hook-" });
}

test("the hook denies raw comment writes with no agent type", async () => {
  await withManagedRepo(async (root) => {
    for (const command of [
      "gh api repos/o/r/issues/5/comments -f body=x",
      "gh issue close 5 --comment x",
      "gh api graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'",
    ]) {
      const { decision, reason } = bash(root, command);
      assert.equal(decision, "deny", command);
      assert.match(reason, /^OPERATOR-OWNED-LINE: /);
    }
  });
});

test("the hook denies a subagent running a comment wrapper with --standing-authorization", async () => {
  await withManagedRepo(async (root) => {
    const command = "dev-loops-run scripts/github/comment-issue.mjs --repo o/r --issue 5 --body x --standing-authorization";
    const { decision, reason } = bash(root, command, "developer");
    assert.equal(decision, "deny");
    assert.match(reason, /^STANDING-AUTHORIZATION-MAIN-AGENT-ONLY: /);
    assert.equal(bash(root, command).decision, "allow", "the main agent runs the same command");
  });
});

test("the hook allows a read-only gh api GET of a comments path", async () => {
  await withManagedRepo(async (root) => {
    assert.equal(bash(root, "gh api repos/o/r/issues/5/comments").decision, "allow");
  });
});
