// Every dev-loops hook deny ends with exactly one marker line (OPS-POLICY-HOOK-DENIAL-RECOVERABLE,
// OPS-HOOK-STOP-CLASS): `policy-hook: <id>; compliant form: <text>` or `stop: <class>; <id>; <reason>`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { POLICY_HOOK_COMPLIANT_FORMS, TERMINAL_STOP_REASONS, decideBashGateDeny, withHookMarker } from "../src/loop/bash-gate-decisions.mjs";
import {
  decideAgentDispatch, decideBashGate, decideCoordinatorWriteGuard, decideFixerWriteGuard, decideJudgeWriteGuard,
  decideSubagentStopGuard, decideWorktreeCheckoutGuard, decideWriteGuard,
} from "../src/claude/hook-decisions.mjs";
import { buildApprovalQuestion } from "../src/github/ask-merge-approval.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const POLICY_KEYS = [
  "OPS-NO-INLINE-INTERPRETER", "COPILOT-FOLLOWUP-WAIT-TOOLS", "OPS-NO-TIMEOUT-WRAPPER", "OPERATOR-DECISION-RECORDER",
  "SUBISSUE-NO-ADHOC-BYPASS", "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER", "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
  "ADR-TRIPWIRE-STANDING-WAIVER", "WORKTREE-NO-STASH", "OPS-DRAFT-FIRST-PR", "OPERATOR-OWNED-LINE",
  "COORDINATOR-VERIFY-BOUNDARY", "COORDINATOR_DELEGATION_BOUNDARY", "GATE_COORDINATOR_REQUIRED", "JUDGE_READ_BOUNDARY",
  "FIXER_PULL_LINE", "JUDGE_WRITE_BOUNDARY", "WORKTREE-WRONG-CHECKOUT-GUARD", "FIXER_NO_GRANT",
  "AGENT_OVERRIDE_NAMESPACED_DISPATCH", "GATE_COORDINATOR_DISPATCH_SCOPE", "GATE_DISPATCH_NOT_VERBATIM",
  "MERGE_ASK_APPROVAL_NAME_HIT", "LOCAL-COMMIT-BEFORE-EXIT",
];
const STOP_KEYS = [
  "UNRESOLVE_OWNER", "MERGE_PR_OWNER", "STOP-HUMAN-MERGE-001", "RAW-GH-PR-MERGE-BYPASS", "GATE-COMMENT-DRAFT-REQUIREMENTS",
  "SUBAGENT_EXTERNAL_WRITE", "MAIN_AGENT_READONLY_BOUNDARY", "FIXER_MUTATION_BOUNDARY", "MERGE-ASK-APPROVAL", "HOOK_GUARD_FAILED",
];

test("the two marker maps are frozen, pinned and disjoint, and every stop class is escalate or process-change", () => {
  assert.deepEqual(Object.keys(POLICY_HOOK_COMPLIANT_FORMS), POLICY_KEYS);
  assert.deepEqual(Object.keys(TERMINAL_STOP_REASONS), STOP_KEYS);
  assert.ok(Object.isFrozen(POLICY_HOOK_COMPLIANT_FORMS) && Object.isFrozen(TERMINAL_STOP_REASONS));
  assert.ok(POLICY_KEYS.every((k) => !STOP_KEYS.includes(k)));
  for (const [id, { class: cls, reason }] of Object.entries(TERMINAL_STOP_REASONS)) {
    assert.ok(["escalate", "process-change"].includes(cls), id);
    assert.equal(reason.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, `${id} reason is one sentence`);
  }
  assert.deepEqual(STOP_KEYS.filter((k) => TERMINAL_STOP_REASONS[k].class === "process-change"), ["HOOK_GUARD_FAILED"]);
});

const BASH = { repoSlug: "o/r", managedRepoSlug: "o/r", inManagedContext: true };
const bash = (command, over = {}) => decideBashGate({ command, ...BASH, ...over }).reason;
const fixerCheckouts = [{ root: "/r", branch: "b" }];
const IDENT = "f1-0123abcd";
const pointer = (id) => `Run \`dev-loops-run scripts/github/pull-work-order.mjs ${id}\`; follow its printed work order exactly. Exit 1: report its JSON verbatim, stop.`;
const hook = (script, input, env = {}) => {
  const r = spawnSync("node", ["--import", path.join(root, "test/github/ask-approval-userinfo-preload.mjs"), path.join(root, ".claude/hooks", script)], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env },
  });
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : r.stderr.trim();
};
const approvalText = buildApprovalQuestion({ repo: "o/r", pr: 7, headSha: "a".repeat(40), patchId: "c".repeat(40) });

const FIXTURES = {
  "OPS-NO-INLINE-INTERPRETER": () => bash("node -e 'x'"),
  "COPILOT-FOLLOWUP-WAIT-TOOLS": () => bash("nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &"),
  "OPS-NO-TIMEOUT-WRAPPER": () => bash("timeout 30 dev-loops-run cli/index.mjs gate resolve-validation"),
  "OPERATOR-DECISION-RECORDER": () => bash("dev-loops-run cli/index.mjs decision record --kind accept", { agentType: "developer" }),
  "SUBISSUE-NO-ADHOC-BYPASS": () => bash("gh api -X POST repos/o/r/issues/5/sub_issues -f child=6"),
  "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER": () => bash("gh api graphql -f query='mutation { resolveReviewThread }'"),
  "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY": () => bash("gh api -X POST repos/o/r/pulls/5/requested_reviewers -f reviewers[]=x"),
  "ADR-TRIPWIRE-STANDING-WAIVER": () => bash("gh pr edit 5 --body hello"),
  "WORKTREE-NO-STASH": () => bash("git stash"),
  "OPS-DRAFT-FIRST-PR": () => bash("gh pr create --fill"),
  "OPERATOR-OWNED-LINE": () => hook("pre-tool-use-bash-gate.mjs", { tool_name: "Bash", tool_input: { command: "gh issue comment 5 --body hi" }, cwd: root }),
  "COORDINATOR-VERIFY-BOUNDARY": () => bash("bun run verify", { agentType: "dev-loop", enforceCoordinator: true }),
  COORDINATOR_DELEGATION_BOUNDARY: () => decideCoordinatorWriteGuard({ filePath: "a", isRepoMutation: true, enforce: true, agentType: "dev-loop" }).reason,
  GATE_COORDINATOR_REQUIRED: () => decideAgentDispatch({ callerAgentType: "dev-loop", targetAgentType: "judge", prompt: "x" }).reason,
  JUDGE_READ_BOUNDARY: () => bash("ls", { agentType: "judge" }),
  FIXER_PULL_LINE: () => bash(`cd /x && dev-loops-run scripts/github/pull-work-order.mjs ${IDENT}`, { agentType: "fixer" }),
  JUDGE_WRITE_BOUNDARY: () => decideJudgeWriteGuard({ agentType: "judge", targetPath: "/x", gateJudgeRoots: [] }).reason,
  "WORKTREE-WRONG-CHECKOUT-GUARD": () => decideWorktreeCheckoutGuard({ filePath: "f", activeWorktreeRoot: "/w", isMainCheckoutTracked: true }).reason,
  FIXER_NO_GRANT: () => decideFixerWriteGuard({ agentType: "fixer", targetPath: "/r/x", checkouts: fixerCheckouts, grants: [] }).reason,
  AGENT_OVERRIDE_NAMESPACED_DISPATCH: () => decideAgentDispatch({ targetAgentType: "dev-loops:fixer", agentOverrides: "fixer" }).reason,
  GATE_COORDINATOR_DISPATCH_SCOPE: () => decideAgentDispatch({ callerAgentType: "gate-coordinator", targetAgentType: "fixer" }).reason,
  GATE_DISPATCH_NOT_VERBATIM: () => decideAgentDispatch({ callerAgentType: "gate-coordinator", targetAgentType: "review", prompt: "hi" }).reason,
  MERGE_ASK_APPROVAL_NAME_HIT: () => hook("pre-tool-use-approval-guard.mjs", { tool_name: "Bash", tool_input: { command: "cat .claude/hooks/post-tool-use-ask-approval.mjs" }, cwd: root }),
  "LOCAL-COMMIT-BEFORE-EXIT": () => decideSubagentStopGuard({ cwd: "/a/tmp/worktrees/x", porcelain: " M a" }).reason,
  UNRESOLVE_OWNER: () => bash("dev-loops-run scripts/github/unresolve-review-thread.mjs --repo o/r --pr 5 --thread-id T1", { agentType: "fixer" }),
  MERGE_PR_OWNER: () => bash("dev-loops-run scripts/github/merge-pr.mjs --check", { agentType: "developer" }),
  "STOP-HUMAN-MERGE-001": () => bash("gh pr merge 5", { humanMergeOnly: true }),
  "RAW-GH-PR-MERGE-BYPASS": () => bash("gh pr merge 5"),
  "GATE-COMMENT-DRAFT-REQUIREMENTS": () => bash("gh pr ready 5"),
  SUBAGENT_EXTERNAL_WRITE: () => bash("gh issue create --title x", { agentType: "developer" }),
  MAIN_AGENT_READONLY_BOUNDARY: () => decideWriteGuard({ filePath: "a", isRepoMutation: true, enforce: true }).reason,
  FIXER_MUTATION_BOUNDARY: () => decideFixerWriteGuard({ agentType: "fixer", targetPath: "/r/x", symlinked: true, checkouts: fixerCheckouts }).reason,
  "MERGE-ASK-APPROVAL": () => hook("pre-tool-use-ask-answers-guard.mjs", { tool_input: { questions: [{ question: approvalText }], answers: { [approvalText]: "Yes" } } }),
  HOOK_GUARD_FAILED: () => hook("pre-tool-use-approval-guard.mjs", { tool_name: "mcp__x", tool_input: { items: Array.from({ length: 10001 }, () => "x") }, cwd: root }),
};

test("one fixture per key of both maps ends its deny with exactly the exact marker line", () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...POLICY_KEYS, ...STOP_KEYS].sort());
  for (const id of Object.keys(FIXTURES)) {
    const lines = FIXTURES[id]().split("\n");
    const expected = withHookMarker(id, "").slice(1);
    assert.ok(expected.length > 0, `${id} has a marker`);
    assert.equal(lines.at(-1), expected, `${id} last line`);
    assert.equal(lines.filter((l) => /^(?:policy-hook|stop):/.test(l)).length, 1, `${id} carries one marker line`);
  }
});

test("the deny-site count is pinned, so a new deny site must join the fixture table", () => {
  const hookFiles = fs.readdirSync(path.join(root, ".claude/hooks"))
    .filter((f) => /^pre-tool-use-.*\.mjs$/.test(f)).map((f) => `.claude/hooks/${f}`);
  const sites = (files) => files.map((f) => (read(f).match(/decision: "(?:deny|block)"|emitDeny\(|process\.exit\(2\)/g) ?? []).length).reduce((a, b) => a + b, 0);
  assert.equal(sites([
    "packages/core/src/loop/bash-gate-decisions.mjs", "packages/core/src/claude/hook-decisions.mjs",
    ...hookFiles, ".claude/hooks/subagent-stop-uncommitted-guard.mjs",
  ]), 29);
  // The shared deny set returns `{ ruleId, reason }`: every such site has a ruleId line.
  assert.equal((read("packages/core/src/loop/bash-gate-decisions.mjs").match(/^\s+ruleId: /gm) ?? []).length, 19);
});

test("a deny with missing facts ends with the HOOK_GUARD_FAILED stop marker", () => {
  const lines = decideBashGateDeny({}).reason.split("\n");
  assert.ok(lines.at(-1).startsWith("stop: process-change; HOOK_GUARD_FAILED;"));
});

test("the ask-answers guard catch marks its deny HOOK_GUARD_FAILED", () => {
  assert.match(read(".claude/hooks/pre-tool-use-ask-answers-guard.mjs"), /catch[\s\S]*withHookMarker\("HOOK_GUARD_FAILED"/);
});

test("withHookMarker throws on an unregistered id and passes null through", () => {
  assert.throws(() => withHookMarker("NOT-A-RULE", "x"), /unregistered deny id/);
  assert.equal(withHookMarker(null, "x"), "x");
  assert.equal(withHookMarker(undefined, "x"), "x");
});

test("the approval guard drops the old node-limit sentence", () => {
  assert.ok(!read(".claude/hooks/pre-tool-use-approval-guard.mjs").includes("otherwise report it to the operator"));
});

test("the contract docs define OPS-HOOK-STOP-CLASS and the main-agent sentences", () => {
  const ops = read("skills/docs/copilot-loop-operations.md");
  assert.match(ops, /<!-- rule: OPS-HOOK-STOP-CLASS -->/);
  assert.match(ops, /`stop: <class>; <deny-id>; <one-sentence reason>`/);
  assert.match(ops, /`escalate`[\s\S]*`process-change`/);
  assert.match(ops, /the actor stops and hands back the denial text verbatim/);
  assert.match(ops, /adds no command ban on top of the role contracts and the dev-loops hook denials/);
  assert.ok(JSON.parse(read("skills/docs/required-rules.json")).requiredRules.some((r) => r.id === "OPS-HOOK-STOP-CLASS"));
  const main = read("skills/docs/main-agent-contract.md");
  assert.match(main, /`stop: process-change` marker, the main agent files the follow-up named by `OPS-HOOK-STOP-CLASS`/);
  assert.match(main, /orchestrator brief follows the command-ban scope of `OPS-HOOK-STOP-CLASS`/);
});
