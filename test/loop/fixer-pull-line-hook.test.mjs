// Fixer pull-line binding at the Bash gate hook (issue 2551, ADR 0115): only an exact pull
// line records the binding; a modified line is denied with the exact line and records nothing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { parseFixerPullCommand } from "../../.claude/hooks/_fixer-grants.mjs";
import { writeExecutionIndex } from "../../scripts/github/_work-order-protocol.mjs";
import { runIdFreeEnv, withTempDir } from "../_helpers.mjs";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = () => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined });
const ID = "f1790630175394-a189d082";
const ENTRY = { executionIdentity: ID, workOrderRef: `fixer:o/r#7:${"a".repeat(40)}:${ID}`, workOrderDigest: `sha256:${"b".repeat(64)}` };
const LINE = `dev-loops-run scripts/github/pull-work-order.mjs ${ID}`;
const markersDir = (root) => path.join(root, "tmp", "work-order-receipts", "fixer-agents");
const markerPath = (root, { workOrderRef, workOrderDigest, executionIdentity }) =>
  path.join(markersDir(root), `${createHash("sha256").update(`${workOrderRef}\n${workOrderDigest}\n${executionIdentity}`).digest("hex")}.json`);

const bash = (cwd, command, agentType = "fixer") => {
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, agent_type: agentType, agent_id: "agent-a" }), encoding: "utf8", env: env() });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withRepo(fn) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: env() });
    await writeExecutionIndex(path.join(root, "tmp"), ENTRY);
    await fn(root);
  }, { prefix: "dev-loops-fixer-pull-hook-" });
}

test("the exact short pull line from a fixer is allowed and records the binding keyed by the index entry", async () => {
  await withRepo(async (root) => {
    for (const agentType of ["fixer", "dev-loops:fixer"]) {
      await rm(markersDir(root), { recursive: true, force: true });
      assert.equal(bash(root, LINE, agentType).decision, "allow");
      const marker = JSON.parse(readFileSync(markerPath(root, ENTRY), "utf8"));
      assert.deepEqual({ ...marker, recordedAt: undefined }, { agentId: "agent-a", ...ENTRY, recordedAt: undefined });
    }
  });
});

test("a suffixed, prefixed or redirected fixer pull line is denied with the exact line and records no binding", async () => {
  await withRepo(async (root) => {
    for (const command of [`${LINE}; echo "EXIT $?"`, `cd ${root} && ${LINE}`, `${LINE} >/dev/null`]) {
      const { decision, reason } = bash(root, command);
      assert.equal(decision, "deny", command);
      assert.ok(reason.includes(`\`${LINE}\``), reason);
      assert.match(reason, /alone, with no prefix, suffix, redirect/);
      assert.equal(existsSync(markersDir(root)) && readdirSync(markersDir(root)).length > 0, false, command);
    }
  });
});

test("parseFixerPullCommand resolves only an exact fixer line whose index entry names a fixer ref for that execution", async () => {
  await withRepo(async (root) => {
    assert.deepEqual(parseFixerPullCommand(LINE, root), ENTRY);
    assert.equal(parseFixerPullCommand(`${LINE}; echo`, root), null);
    // Step 1 keeps the 3-flag line: it binds its own values when the ref is a fixer ref.
    const threeFlag = (ref) => `dev-loops-run scripts/github/pull-work-order.mjs --ref ${ref} --digest ${ENTRY.workOrderDigest} --execution ${ID}`;
    assert.deepEqual(parseFixerPullCommand(threeFlag(ENTRY.workOrderRef), root), ENTRY);
    assert.equal(parseFixerPullCommand(threeFlag("review:o/r#7:x"), root), null);
    assert.equal(parseFixerPullCommand("dev-loops-run scripts/github/pull-work-order.mjs f1-deadbeef", root), null, "missing index entry");
    const reviewRef = { executionIdentity: "f2-deadbeef", workOrderRef: "review:o/r#7:x", workOrderDigest: "sha256:0" };
    await writeExecutionIndex(path.join(root, "tmp"), reviewRef);
    assert.equal(parseFixerPullCommand(`dev-loops-run scripts/github/pull-work-order.mjs ${reviewRef.executionIdentity}`, root), null, "non-fixer ref");
    for (const identity of ["j1-deadbeef", "r1-deadbeef-u0"]) {
      await writeExecutionIndex(path.join(root, "tmp"), { ...ENTRY, executionIdentity: identity });
      assert.equal(parseFixerPullCommand(`dev-loops-run scripts/github/pull-work-order.mjs ${identity}`, root), null, identity);
    }
  });
});
