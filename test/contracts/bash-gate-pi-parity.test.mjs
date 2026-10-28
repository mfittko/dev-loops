import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideBashGate } from "@dev-loops/core/claude/hook-decisions";
import { BASH_GATE_RULES, decideBashGateDeny } from "@dev-loops/core/loop/bash-gate-decisions";
import { decidePiToolCall } from "../../extension/readonly-role-gate.ts";

// Issue #2965 AC2/AC3. One shared deny decision (loop/bash-gate-decisions.mjs) backs both the
// Claude PreToolUse Bash gate and the Pi `tool_call` handler, so the two harnesses must return the
// same verdict for the same command, and every rule must carry an explicit Pi verdict that the
// cross-harness contract states.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SLUG = "mfittko/dev-loops";
const CONTRACT = path.join(repoRoot, "skills/docs/cross-harness-regression-contract.md");

const MANAGED = Object.freeze({
  inManagedContext: true,
  managedRepoSlug: SLUG,
  repoSlug: SLUG,
  humanMergeOnly: false,
  enforceCoordinator: false,
  readyGate: Object.freeze({ passed: false, error: null }),
});

/**
 * One command per Bash-gate rule, with the facts that rule needs. `ruleId` is the verdict the
 * shared decision must produce (`null` for the two inline denies that carry no registered rule ID);
 * the AC3 parity loop runs the same fixtures through both adapters.
 */
const FIXTURES = Object.freeze([
  { ruleId: "COORDINATOR-VERIFY-BOUNDARY", command: "bun run verify", role: "dev-loop", facts: { enforceCoordinator: true } },
  { ruleId: "OPS-NO-INLINE-INTERPRETER", command: 'node -e "console.log(1)"' },
  { ruleId: "COPILOT-FOLLOWUP-WAIT-TOOLS", command: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &" },
  { ruleId: null, command: `timeout 300 dev-loops-run scripts/github/merge-pr.mjs --repo ${SLUG} --pr 5` },
  { ruleId: "SUBISSUE-NO-ADHOC-BYPASS", command: `gh api -X POST repos/${SLUG}/issues/5/sub_issues -f child=6` },
  { ruleId: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER", command: `gh api -X POST repos/${SLUG}/pulls/5/comments/10/replies -f body=hi` },
  { ruleId: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY", command: `gh api -X POST repos/${SLUG}/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent` },
  { ruleId: "ADR-TRIPWIRE-STANDING-WAIVER", command: "gh pr edit 5 --body-file pr.md" },
  { ruleId: "WORKTREE-NO-STASH", command: "git stash" },
  { ruleId: null, command: "gh issue create --title x --body y", role: "developer" },
  { ruleId: "STOP-HUMAN-MERGE-001", command: "gh pr merge 5 --squash", facts: { humanMergeOnly: true } },
  { ruleId: "OPS-DRAFT-FIRST-PR", command: "gh pr create --fill" },
  { ruleId: "RAW-GH-PR-MERGE-BYPASS", command: "gh pr merge 5 --squash" },
  { ruleId: "GATE-COMMENT-DRAFT-REQUIREMENTS", command: "gh pr ready 5" },
]);

// Commands both gates must let through, including the proven-foreign and gate-passed escapes.
const ALLOW_FIXTURES = Object.freeze([
  "gh pr view 5",
  "npm test",
  "node scripts/github/comment-issue.mjs 5",
  "gh pr merge --repo other/repo 5",
]);

// Roles for which the Pi read-only role gate adds nothing beyond the shared decision, so the two
// adapters must agree exactly (`judge`/`review` are additionally restricted on Pi by #2509).
const PARITY_ROLES = Object.freeze([null, "developer", "fixer", "quality", "docs", "dev-loop", "gate-coordinator", "refiner"]);

/** The Claude Bash-gate verdict, given the same facts the Pi handler injects. */
function claudeAllows(command, role, facts) {
  return decideBashGate({
    command,
    agentType: role,
    repoSlug: facts.repoSlug,
    managedRepoSlug: facts.managedRepoSlug,
    inManagedContext: facts.inManagedContext,
    humanMergeOnly: facts.humanMergeOnly,
    enforceCoordinator: facts.enforceCoordinator,
    gatePassed: facts.readyGate?.passed === true,
    gateError: facts.readyGate?.error ?? null,
  }).decision === "allow";
}

const piBlocks = (command, role, facts) => decidePiToolCall({ toolName: "bash", input: { command }, agentType: role, facts }).block;

test("every Bash-gate rule is enforced through the shared decision on Pi (AC2)", () => {
  for (const fixture of FIXTURES) {
    const role = fixture.role ?? null;
    const facts = { ...MANAGED, ...fixture.facts };
    const decision = decideBashGateDeny({
      command: fixture.command,
      role,
      repoSlug: facts.repoSlug,
      managedRepoSlug: facts.managedRepoSlug,
      inManagedContext: facts.inManagedContext,
      humanMergeOnly: facts.humanMergeOnly,
      enforceCoordinator: facts.enforceCoordinator,
      readyGate: facts.readyGate,
    });
    assert.equal(decision?.ruleId, fixture.ruleId, fixture.command);
    assert.ok(decision.reason.length > 0, `${fixture.ruleId} must explain the deny`);
    assert.equal(piBlocks(fixture.command, role, facts), true, `${fixture.ruleId} must be blocked on Pi`);
  }
  // One fixture per listed rule, no rule left without a command that trips it, and no fixture
  // claiming a rule ID the shared list does not carry.
  assert.deepEqual(FIXTURES.filter((f) => f.ruleId).map((f) => f.ruleId).sort(), BASH_GATE_RULES.map((r) => r.id).sort());
});

test("the two inline denies without a registered rule ID still block on both harnesses (#2965)", () => {
  for (const fixture of FIXTURES.filter((f) => f.ruleId === null)) {
    const role = fixture.role ?? null;
    const facts = { ...MANAGED, ...fixture.facts };
    assert.equal(piBlocks(fixture.command, role, facts), true, fixture.command);
    assert.equal(claudeAllows(fixture.command, role, facts), false, fixture.command);
  }
});

test("the Claude and Pi adapters agree on every Bash-gate fixture (AC3, #1086)", () => {
  for (const fixture of FIXTURES) {
    const role = fixture.role ?? null;
    const facts = { ...MANAGED, ...fixture.facts };
    assert.equal(claudeAllows(fixture.command, role, facts), !piBlocks(fixture.command, role, facts), fixture.command);
  }
  for (const command of ALLOW_FIXTURES) {
    for (const role of PARITY_ROLES) {
      assert.equal(claudeAllows(command, role, MANAGED), true, `${command} as ${String(role)}`);
      assert.equal(piBlocks(command, role, MANAGED), false, `${command} as ${String(role)}`);
    }
  }
  // The gate-passed escape for `gh pr ready` agrees on both harnesses.
  const passed = { ...MANAGED, readyGate: { passed: true, error: null } };
  assert.equal(claudeAllows("gh pr ready 5", null, passed), !piBlocks("gh pr ready 5", null, passed));
  assert.equal(piBlocks("gh pr ready 5", null, passed), false);
});

test("the Bash-gate rule list pins each rule's Pi verdict against the cross-harness contract (AC2)", () => {
  const rows = new Map();
  for (const [, id, claude, pi, reason] of fs.readFileSync(CONTRACT, "utf8").matchAll(/^\| `([A-Z0-9-]+)` \| ([^|]*) \| ([a-z-]+) \| ([^|]*) \|$/gm)) {
    rows.set(id, { claude: claude.trim(), pi: pi.trim(), reason: reason.trim() });
  }
  assert.deepEqual([...rows.keys()].sort(), BASH_GATE_RULES.map((rule) => rule.id).sort(), "the contract matrix must list exactly the Bash-gate rules");
  for (const rule of BASH_GATE_RULES) {
    const row = rows.get(rule.id);
    assert.equal(row.pi, rule.pi, `${rule.id}: contract Pi verdict must match BASH_GATE_RULES`);
    assert.notEqual(row.claude, "", `${rule.id}: contract Claude verdict must not be empty`);
    if (rule.pi !== "enforced") {
      assert.ok(row.reason.length > 0 && row.reason !== "—", `${rule.id}: a non-enforced Pi verdict states its reason`);
    }
  }
});
