// PRE-PUSH-DELTA-PUSH-AUTHORITY at the Bash gate hook: a sequence marker written before the delta
// result makes a non-fixer push (and a commit_only fixer push) refused; the full grant admits the fixer.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { sequenceMarkerPath, writeSequenceMarker } from "../../.claude/hooks/_fix-push-authority.mjs";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });

const bash = (cwd, command, agentType) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd, agent_id: "agent-a", ...(agentType === undefined ? {} : { agent_type: agentType }) };
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: env() });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withRepo(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, env: env(), encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    await fn(root, git("rev-parse", "HEAD").trim());
  }, { prefix: "dev-loops-push-authority-hook-" });
}

test("without a sequence marker every push is allowed", async () => {
  await withRepo(async (root) => {
    for (const agentType of ["dev-loops:pre-pr-reviewer", "fixer", "developer"]) assert.equal(bash(root, "git push origin b", agentType).decision, "allow", agentType);
  });
});

test("with a marker written before any delta result a non-fixer and the commit_only fixer are refused", async () => {
  await withRepo(async (root, head) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head });
    for (const [command, agentType] of [["git push origin b", "dev-loops:pre-pr-reviewer"], ["git -C x push", "developer"], ["git -c x=y push", "developer"], ["git --no-pager push", "developer"], ["git push", "fixer"], ["git push", "dev-loops:fixer"]]) {
      const out = bash(root, command, agentType);
      assert.equal(out.decision, "deny", `${agentType}: ${command}`);
      assert.match(out.reason, /PRE-PUSH-DELTA-PUSH-AUTHORITY/);
    }
    assert.equal(bash(root, "git push origin b", undefined).decision, "allow", "no agentType is the operator");
    assert.equal(bash(root, "git push origin b", "").decision, "allow", "an empty agentType is the operator");
    assert.equal(bash(root, 'echo "git push"', "developer").decision, "allow");
  });
});

test("after the full work order only the fixer may push", async () => {
  await withRepo(async (root, head) => {
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: head, fullGranted: true });
    assert.equal(bash(root, "git push origin b", "fixer").decision, "allow");
    assert.equal(bash(root, "git push origin b", "developer").decision, "deny");
  });
});

test("a malformed marker file fails closed and a marker for another baseline is ignored", async () => {
  await withRepo(async (root, head) => {
    await mkdir(path.join(root, "tmp", "gate-delta"), { recursive: true });
    await writeFile(sequenceMarkerPath(path.join(root, "tmp"), head), "{not json");
    assert.equal(bash(root, "git push origin b", "developer").decision, "deny");
    assert.equal(bash(root, "git push origin b", "fixer").decision, "deny");
  });
  await withRepo(async (root) => {
    // The head is no descendant of the recorded baseline (the head moved): not active.
    writeSequenceMarker({ tmpRoot: path.join(root, "tmp"), baselineHead: "f".repeat(40) });
    assert.equal(bash(root, "git push origin b", "developer").decision, "allow");
  });
});
