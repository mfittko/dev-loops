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
import { BASH_GATE_RULES } from "@dev-loops/core/loop/bash-gate-decisions";

const BASH_HOOK = path.resolve(".claude/hooks/pre-tool-use-bash-gate.mjs");
const env = (extra = {}) => ({ ...runIdFreeEnv(), GIT_DIR: undefined, GIT_WORK_TREE: undefined, ...extra });

const bash = (cwd, command, agentType, extraEnv) => {
  const input = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType !== undefined) input.agent_type = agentType;
  const result = spawnSync("node", [BASH_HOOK], { input: JSON.stringify(input), encoding: "utf8", env: env(extraEnv) });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? "allow", reason: out?.permissionDecisionReason ?? "" };
};

async function withManagedRepo(fn, { config = "version: 1\n" } = {}) {
  await withTempDir(async (dir) => {
    const root = path.join(await realpath(dir), "repo");
    await mkdir(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: env() });
    fs.writeFileSync(path.join(root, ".devloops"), config, "utf8");
    await fn(root);
  }, { prefix: "dev-loops-bash-gate-hook-" });
}

/**
 * One fixture per rule in the shared module's `BASH_GATE_RULES`. The hook's pre-check owns an
 * allow-by-default non-match path (`emitAllow()` then exit), so a rule whose shape is not nominated
 * there is UNREACHABLE and fails open on Claude even though the shared decision denies it and Pi
 * enforces it. Each fixture therefore drives the real hook and asserts a deny, so a rule added
 * without a reachable shape fails this suite instead of shipping a Claude-side hole.
 */
const HOOK_FIXTURES = Object.freeze([
  {
    rule: "COORDINATOR-VERIFY-BOUNDARY",
    command: "bun run verify",
    agentType: "dev-loop",
    extraEnv: { DEVLOOPS_COORDINATOR_READONLY: "1" },
    reason: /COORDINATOR-VERIFY-BOUNDARY/,
  },
  { rule: "OPS-NO-INLINE-INTERPRETER", command: 'node -e "console.log(1)"', reason: /OPS-NO-INLINE-INTERPRETER/ },
  {
    rule: "COPILOT-FOLLOWUP-WAIT-TOOLS",
    command: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &",
    reason: /COPILOT-FOLLOWUP-WAIT-TOOLS/,
  },
  {
    rule: "SUBISSUE-NO-ADHOC-BYPASS",
    command: "gh api -X POST issues/5/sub_issues -f child=6",
    reason: /SUBISSUE-NO-ADHOC-BYPASS/,
  },
  {
    rule: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
    command: "gh api -X POST pulls/5/comments/10/replies -f body=hi",
    reason: /COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER/,
  },
  {
    rule: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
    command: "gh api -X POST pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent",
    reason: /COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY/,
  },
  {
    rule: "ADR-TRIPWIRE-STANDING-WAIVER",
    command: "gh pr edit 5 --body-file waiver.md",
    reason: /ADR-TRIPWIRE-STANDING-WAIVER/,
  },
  { rule: "WORKTREE-NO-STASH", command: "git stash", reason: /git stash blocked/ },
  {
    rule: "STOP-HUMAN-MERGE-001",
    command: "gh pr merge 5 --squash",
    config: "version: 1\nautonomy:\n  humanMergeOnly: true\n",
    reason: /STOP-HUMAN-MERGE-001/,
  },
  { rule: "OPS-DRAFT-FIRST-PR", command: "gh pr create --fill", reason: /gh pr create blocked/ },
  {
    rule: "RAW-GH-PR-MERGE-BYPASS",
    command: "gh pr merge 5 --squash",
    config: "version: 1\nautonomy:\n  humanMergeOnly: false\n",
    reason: /RAW-GH-PR-MERGE-BYPASS/,
  },
  { rule: "GATE-COMMENT-DRAFT-REQUIREMENTS", command: "gh pr ready 5", reason: /gh pr ready blocked/ },
]);

test("every Bash-gate rule is reachable at the Claude PreToolUse seam and denied there", async () => {
  assert.deepEqual(
    HOOK_FIXTURES.map((fixture) => fixture.rule).sort(),
    BASH_GATE_RULES.map((rule) => rule.id).sort(),
    "one hook-level fixture per rule in BASH_GATE_RULES",
  );
  for (const fixture of HOOK_FIXTURES) {
    await withManagedRepo(
      async (root) => {
        const { decision, reason } = bash(root, fixture.command, fixture.agentType, fixture.extraEnv);
        assert.equal(decision, "deny", `${fixture.rule}: the hook must not short-circuit to allow`);
        assert.match(reason, fixture.reason, `${fixture.rule}: the deny must carry that rule's own message`);
      },
      { config: fixture.config ?? "version: 1\n" },
    );
  }
});

test("the ADR tripwire body-write deny is reachable at the Claude seam for both accepted forms", async () => {
  await withManagedRepo(async (root) => {
    // Accepted forms (#2965): a raw `gh pr edit` body write and a raw `gh api` body-field write.
    for (const command of ["gh pr edit 5 --body-file waiver.md", "gh api -X PATCH repos/o/r/pulls/5 -f body=x"]) {
      const { decision, reason } = bash(root, command, undefined);
      assert.equal(decision, "deny", command);
      assert.match(reason, /ADR-TRIPWIRE-STANDING-WAIVER/, command);
    }
    // Rejected forms: a read that merely mentions a body, and the sanctioned launcher writer.
    for (const command of ["grep -n body README.md", "dev-loops-run cli/index.mjs pr edit --body-file waiver.md"]) {
      assert.equal(bash(root, command, undefined).decision, "allow", command);
    }
  });
});

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
