import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASH_GATE_RULES,
  decideBashGateDeny,
  decideMergePrOwnerDeny,
  decideUnresolveOwnerDeny,
} from "../src/loop/bash-gate-decisions.mjs";

const TARGET = "mfittko/dev-loops";

// The gate's rule bodies and their reason texts moved out of the Claude seam into this shared
// module, so the move has to be PINNED rather than trusted: everything below freezes the ordered rule
// list, each rule's reason strings exactly as the module emits them, the two inline denies' place in
// the same ordered body, and the attribution each lifecycle verb gives a command that names no PR
// number. That covers every draft-gate gate-error suffix the `readyGate` probe adds to the ready and
// raw-merge denies (the raw-merge reason also carries an optional "also writes gate evidence" hint, so
// all four of its composed forms are pinned) and BOTH verbs' unparsable-PR attributions — the ready
// verb's in `RULE_FIXTURES`, the merge verb's in its own exact-string test. Every one of those reasons
// is pinned as a full literal, so a reworded or removed suffix or attribution fails an exact-string
// assertion here rather than relying on the Claude seam's fragment assertions
// (claude-hook-decisions.test.mjs). The fact-validation refusals are the deliberate exception: they
// stay fragment-pinned, because each must name the fact it rejected, which an exact literal would not
// add. Reordering two checks, rewording a pinned reason or dropping a rule fails here — which is what
// makes a later edit to the shared set (or a second adapter that consumes it) safe to review.
const BASE = Object.freeze({
  role: null,
  repoSlug: TARGET,
  managedRepoSlug: TARGET,
  inManagedContext: true,
  humanMergeOnly: false,
  enforceCoordinator: false,
  readyGate: null,
});

/**
 * One triggering fixture per registered rule, in EVALUATION ORDER — one entry per reason VARIANT, so
 * a rule with two actor-scoped reason texts (COORDINATOR-VERIFY-BOUNDARY) appears twice.
 */
const RULE_FIXTURES = [
  {
    id: "COORDINATOR-VERIFY-BOUNDARY",
    facts: { ...BASE, enforceCoordinator: true, role: "dev-loop", command: "bun run verify" },
    reason: "COORDINATOR-VERIFY-BOUNDARY: the dev-loop coordinator must not run code-verification/build commands inline. Delegate targeted checks to a fresh worker subagent (developer/fixer/quality), which reports back a compact pass/fail plus any failing-test names. Request local full-repository validation through `dev-loops-run cli/index.mjs gate resolve-validation` on a clean commit; when checking a pushed commit, prefer CI's structured conclusion (`gh pr checks` / scripts/github/detect-checkpoint-evidence.mjs) over a local run. See skills/docs/main-agent-contract.md.",
  },
  {
    // The same rule's gate-coordinator variant: the rule owns TWO reason texts, and a reason freeze
    // that pinned only the dev-loop one would let this half be reworded silently.
    id: "COORDINATOR-VERIFY-BOUNDARY",
    facts: { ...BASE, enforceCoordinator: true, role: "gate-coordinator", command: "bun run verify" },
    reason: "COORDINATOR-VERIFY-BOUNDARY: the gate coordinator must not run code-verification/build commands inline. Run the round's full validation through `dev-loops-run cli/index.mjs gate resolve-validation`; for any other check, stop and return a typed observation to the dev-loop coordinator (GATE-EXEC-GATE-COORDINATOR). See skills/docs/main-agent-contract.md.",
  },
  {
    id: "OPS-NO-INLINE-INTERPRETER",
    facts: { ...BASE, command: "node -e 'console.log(1)'" },
    reason: "OPS-NO-INLINE-INTERPRETER: inline interpreters (node -e/--eval/-p, python3 -c, bun -e/--eval/-p/--print, bun -, heredoc to node/python/bun) are barred in the dev-loop flow. Parse tool output via --jq/--silent and mutate files via the editor/patch tools or a --jq-composed --body-file, never an inline interpreter.",
  },
  {
    id: "COPILOT-FOLLOWUP-WAIT-TOOLS",
    facts: { ...BASE, command: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &" },
    reason: "COPILOT-FOLLOWUP-WAIT-TOOLS: wait only through a bounded FOREGROUND probe (scripts/github/probe-copilot-review.mjs or scripts/github/wait-pr-checks.mjs with an explicit --timeout <seconds>; scripts/loop/detect-copilot-loop-state.mjs one-shot; dev-loops-run cli/index.mjs loop watch-cycle; gh run watch) — nohup/disown/tmux/screen detach, while-sleep-poll loops, and bare-`&` backgrounding of a probe/wait script are barred for the coordinator and every subagent (a backgrounded wait orphans under Claude Code, which has no async wake to join it).",
  },
  {
    id: "SUBISSUE-NO-ADHOC-BYPASS",
    facts: { ...BASE, command: "gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6" },
    reason: "SUBISSUE-NO-ADHOC-BYPASS: ad-hoc `gh api` writes to the target repo's sub_issues endpoint are blocked. Manage sub-issues via the sanctioned manage-sub-issues wrapper instead.",
  },
  {
    id: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
    facts: { ...BASE, command: "gh api graphql -f query='mutation { resolveReviewThread }'" },
    reason: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER: ad-hoc thread-reply mutations are blocked. Resolve review threads via scripts/github/reply-resolve-review-thread.mjs (one thread) or reply-resolve-review-threads.mjs (multiple threads, --message-map), not raw gh api/graphql. To reopen a wrongly resolved thread, the orchestrator or dev-loop coordinator runs scripts/github/unresolve-review-thread.mjs (never raw unresolveReviewThread).",
  },
  {
    id: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
    facts: { ...BASE, command: "gh api -X POST repos/mfittko/dev-loops/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent" },
    reason: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY: ad-hoc Copilot review requests are blocked. Request Copilot via scripts/github/request-copilot-review.mjs — do not write requested_reviewers or post a literal /copilot comment.",
  },
  {
    id: "ADR-TRIPWIRE-STANDING-WAIVER",
    facts: { ...BASE, command: "gh pr edit 5 --body hello" },
    reason: "ADR-TRIPWIRE-STANDING-WAIVER: raw `gh pr edit` body writes and `gh api` body writes to pulls/<n> or issues/<n> are blocked. Edit a PR body through the launcher (`dev-loops-run cli/index.mjs pr edit`), which refuses a hand-written adr-tripwire:allow line. Edit an issue body through `dev-loops-run cli/index.mjs issue edit`. Write the ADR tripwire waiver only through the launcher (`dev-loops-run cli/index.mjs pr waive-adr-tripwire`), which needs a standing authorization on the default branch.",
  },
  {
    id: "WORKTREE-NO-STASH",
    facts: { ...BASE, command: "git stash" },
    reason: "git stash blocked: refs/stash is shared across every worktree over this repo's one .git directory, so a stash can pop into a different worktree. Use `git diff` (or `git diff --staged`), save changes to a patch file, or use a separate scratch worktree instead of stashing.",
  },
  {
    id: "STOP-HUMAN-MERGE-001",
    facts: { ...BASE, humanMergeOnly: true, command: "gh pr merge 5" },
    reason: "STOP-HUMAN-MERGE-001: this repo resolves autonomy.humanMergeOnly — the loop must stop at merge for a human action; the agent MUST NOT run `gh pr merge`. Leave the PR merge-ready and a human merges it.",
  },
  {
    id: "OPS-DRAFT-FIRST-PR",
    facts: { ...BASE, command: "gh pr create --fill" },
    reason: "gh pr create blocked: open PRs via the canonical wrapper `node scripts/github/create-pr.mjs` (a.k.a. `dev-loops-run cli/index.mjs pr create`), which always creates a draft and self-assigns. Raw `gh pr create` defaults to ready-for-review and bypasses the draft-first contract (workflow.requireDraftFirst).",
  },
  {
    id: "RAW-GH-PR-MERGE-BYPASS",
    facts: { ...BASE, command: "gh pr merge 5" },
    reason: "gh pr merge is forbidden: route the merge through the sanctioned wrapper `node scripts/github/merge-pr.mjs --repo <owner/name> --pr 5 --human-approved-by <login>`, which runs the full precondition set fail-closed (mandatory approver, merge class, fresh approval) — a raw `gh pr merge` bypasses those (RAW-GH-PR-MERGE-BYPASS).",
  },
  {
    id: "GATE-COMMENT-DRAFT-REQUIREMENTS",
    facts: { ...BASE, command: "gh pr ready 5" },
    reason: "gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #5.",
  },
  {
    // The same rule's PROBED-FAILURE variant: when the draft-gate guard ran and reported an error, the
    // ready deny names the evidence check instead of the missing comment. No fixture reached it, so a
    // reworded `draft-gate evidence check failed (...)` message used to leave every suite green.
    id: "GATE-COMMENT-DRAFT-REQUIREMENTS",
    facts: { ...BASE, command: "gh pr ready 5", readyGate: { passed: false, error: "draft-gate guard unavailable" } },
    reason: "gh pr ready blocked: draft-gate evidence check failed (draft-gate guard unavailable).",
  },
  {
    // The same rule's UNPARSABLE-PR variant: `gh pr ready` with no PR number reaches neither the
    // not-probed nor the probed-failure branch above, so the attribution has to come from the verb
    // alone. The Claude seam matched that attribution only as a fragment
    // (claude-hook-decisions.test.mjs), so pinning its complete text here gives the ready verb the
    // same freeze the merge verb's attribution has.
    id: "GATE-COMMENT-DRAFT-REQUIREMENTS",
    facts: { ...BASE, command: "gh pr ready" },
    reason: "gh pr ready blocked: could not determine the PR number from the command. Include the PR number explicitly.",
  },
  {
    // The raw-merge deny's probed-failure variant: the same `readyGate` error is appended as a suffix to
    // the merge reason, which no fixture pinned either. The merge verb keeps RAW-GH-PR-MERGE-BYPASS as
    // its rule id.
    id: "RAW-GH-PR-MERGE-BYPASS",
    facts: { ...BASE, command: "gh pr merge 5", readyGate: { passed: false, error: "draft-gate guard unavailable" } },
    reason:
      "gh pr merge is forbidden: route the merge through the sanctioned wrapper `node scripts/github/merge-pr.mjs --repo <owner/name> --pr 5 --human-approved-by <login>`, which runs the full precondition set fail-closed (mandatory approver, merge class, fresh approval) — a raw `gh pr merge` bypasses those (RAW-GH-PR-MERGE-BYPASS)." +
      " (pre-merge gate evidence check also failed: draft-gate guard unavailable)",
  },
  {
    // The raw-merge deny's compound evidence-write variant (#1172): an evidence write chained with the
    // merge gets a THIRD reason suffix, which the Claude seam pinned only as a fragment. Pinning the
    // complete emitted reason here gives the hint the same freeze as every other variant, so rewording
    // or removing "never chain an evidence write with the merge" fails this table.
    id: "RAW-GH-PR-MERGE-BYPASS",
    facts: { ...BASE, command: "node scripts/loop/write-gate-findings-log.mjs --pr 5 && gh pr merge 5" },
    reason:
      "gh pr merge is forbidden: route the merge through the sanctioned wrapper `node scripts/github/merge-pr.mjs --repo <owner/name> --pr 5 --human-approved-by <login>`, which runs the full precondition set fail-closed (mandatory approver, merge class, fresh approval) — a raw `gh pr merge` bypasses those (RAW-GH-PR-MERGE-BYPASS)." +
      " This command also writes gate evidence, but hooks evaluate before the command runs — never chain an evidence write with the merge.",
  },
  {
    // The raw-merge deny's LAST composed form: the `readyGate` failure suffix and the evidence-write
    // hint STACK, and their order is part of the emitted text. Pinning the composition freezes that
    // order, and completes the rule's four forms (plain, probe-failed, evidence-write, both).
    id: "RAW-GH-PR-MERGE-BYPASS",
    facts: {
      ...BASE,
      command: "node scripts/loop/write-gate-findings-log.mjs --pr 5 && gh pr merge 5",
      readyGate: { passed: false, error: "draft-gate guard unavailable" },
    },
    reason:
      "gh pr merge is forbidden: route the merge through the sanctioned wrapper `node scripts/github/merge-pr.mjs --repo <owner/name> --pr 5 --human-approved-by <login>`, which runs the full precondition set fail-closed (mandatory approver, merge class, fresh approval) — a raw `gh pr merge` bypasses those (RAW-GH-PR-MERGE-BYPASS)." +
      " (pre-merge gate evidence check also failed: draft-gate guard unavailable)" +
      " This command also writes gate evidence, but hooks evaluate before the command runs — never chain an evidence write with the merge.",
  },
];

/** The inline denies: real denials that carry no registered rule ID, so they stay out of the list. */
const INLINE_FIXTURES = [
  {
    name: "unresolve owner allowlist",
    facts: { ...BASE, role: "fixer", command: "dev-loops-run scripts/github/unresolve-review-thread.mjs --repo mfittko/dev-loops --pr 5 --thread-id T1" },
    reason: "The fixer agent may not unresolve review threads: scripts/github/unresolve-review-thread.mjs is owned by the orchestrator (main agent) and the dev-loop coordinator. Report the wrongly resolved thread in your hand-back and let the owner run it.",
  },
  {
    name: "timeout-wrapped sanctioned command",
    facts: { ...BASE, command: "timeout 30 dev-loops-run cli/index.mjs gate resolve-validation" },
    reason: "Do not wrap sanctioned dev-loops commands in `timeout N`: the wrapper hides the `dev-loops-run` head from operator allow rules. Run the command bare. Wait/probe tools bound themselves with `--timeout <seconds>`; other commands rely on the harness tool-call timeout.",
  },
  {
    name: "subagent ad-hoc external write",
    facts: { ...BASE, role: "developer", command: "gh issue comment 5 --body hi" },
    reason: "Ad-hoc GitHub issue/PR creation, comments, and edits from a subagent are blocked. Use the sanctioned node wrappers instead — gate-verdict comments via scripts/github/upsert-checkpoint-verdict.mjs, review-thread replies via scripts/github/reply-resolve*.mjs, board sync, issue comments via scripts/github/comment-issue.mjs, or issue-body edits via scripts/github/edit-issue.mjs. Direct `gh issue create` is reserved for the main agent / operator.",
  },
];

test("BASH_GATE_RULES matches the fixture rule order", () => {
  // The list is compared against the fixtures' rule IDS in order (a rule with two reason variants owns
  // two fixture entries). This is the LIST assertion only: that the list IS the evaluation order is the
  // separate order test below.
  assert.deepEqual([...BASH_GATE_RULES], [...new Set(RULE_FIXTURES.map((f) => f.id))]);
});

test("every registered rule fires with its own id and its exact reason text", () => {
  for (const { id, facts, reason } of RULE_FIXTURES) {
    const decision = decideBashGateDeny(facts);
    assert.ok(decision, `${id} did not deny its own fixture — the rule moved, lost, or was reordered`);
    assert.equal(decision.ruleId, id, `${id} returned another rule's id`);
    assert.equal(decision.reason, reason, `${id} reason text changed`);
  }
});

test("every listed rule id is a rule entry in skills/docs/required-rules.json", () => {
  // The list cannot grow a rule the registry does not own. Match the id as a PARSED entry, not as a
  // substring of the file: an id that merely appears in prose is not a registered rule.
  const rulesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/docs/required-rules.json");
  const registered = new Set(JSON.parse(fs.readFileSync(rulesFile, "utf8")).requiredRules.map((rule) => rule.id));
  for (const id of BASH_GATE_RULES) {
    assert.ok(registered.has(id), `${id} is not a rule entry in skills/docs/required-rules.json`);
  }
});

test("the inline denies carry no rule id and keep their exact reason text", () => {
  for (const { name, facts, reason } of INLINE_FIXTURES) {
    const decision = decideBashGateDeny(facts);
    assert.ok(decision, `${name} did not deny`);
    assert.equal(decision.ruleId, null, `${name} must not claim a registered rule id`);
    assert.equal(decision.reason, reason, `${name} reason text changed`);
  }
});

/**
 * Every consecutive pair in `BASH_GATE_RULES`, with one command that trips BOTH bodies. A command
 * matching two rules must report the EARLIER one, so a hand-swapped pair of adjacent rule bodies
 * fails here even though each rule still matches its own fixture in `RULE_FIXTURES`.
 *
 * Each entry also carries a `laterOnly` command that trips ONLY the entry's `later` rule under the
 * entry's facts, so the table proves its own premise (both bodies still match) instead of assuming
 * it — a silently narrowed `later` predicate then fails here rather than weakening the pair check.
 */
const ORDER_PAIRS = [
  {
    earlier: "COORDINATOR-VERIFY-BOUNDARY",
    later: "OPS-NO-INLINE-INTERPRETER",
    facts: { ...BASE, enforceCoordinator: true, role: "dev-loop" },
    command: "bun run verify && node -e 'x'",
    laterOnly: "node -e 'console.log(1)'",
  },
  {
    earlier: "OPS-NO-INLINE-INTERPRETER",
    later: "COPILOT-FOLLOWUP-WAIT-TOOLS",
    command: "node -e 'x' && nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &",
    laterOnly: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 &",
  },
  {
    earlier: "COPILOT-FOLLOWUP-WAIT-TOOLS",
    later: "SUBISSUE-NO-ADHOC-BYPASS",
    command: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 & gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6",
    laterOnly: "gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6",
  },
  {
    earlier: "SUBISSUE-NO-ADHOC-BYPASS",
    later: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
    command: "gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6 && gh api graphql -f query='mutation { resolveReviewThread }'",
    laterOnly: "gh api graphql -f query='mutation { resolveReviewThread }'",
  },
  {
    earlier: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
    later: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
    command: "gh api graphql -f query='mutation { resolveReviewThread }' && gh api -X POST repos/mfittko/dev-loops/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent",
    laterOnly: "gh api -X POST repos/mfittko/dev-loops/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent",
  },
  {
    earlier: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
    later: "ADR-TRIPWIRE-STANDING-WAIVER",
    command: "gh api -X POST repos/mfittko/dev-loops/pulls/5/requested_reviewers -f reviewers[]=copilot-swe-agent && gh pr edit 5 --body hello",
    laterOnly: "gh pr edit 5 --body hello",
  },
  {
    earlier: "ADR-TRIPWIRE-STANDING-WAIVER",
    later: "WORKTREE-NO-STASH",
    command: "gh pr edit 5 --body hello && git stash",
    laterOnly: "git stash",
  },
  {
    earlier: "WORKTREE-NO-STASH",
    later: "STOP-HUMAN-MERGE-001",
    facts: { ...BASE, humanMergeOnly: true },
    command: "git stash && gh pr merge 5",
    laterOnly: "gh pr merge 5",
  },
  {
    earlier: "STOP-HUMAN-MERGE-001",
    later: "OPS-DRAFT-FIRST-PR",
    facts: { ...BASE, humanMergeOnly: true },
    command: "gh pr merge 5 && gh pr create --fill",
    laterOnly: "gh pr create --fill",
  },
  {
    earlier: "OPS-DRAFT-FIRST-PR",
    later: "RAW-GH-PR-MERGE-BYPASS",
    command: "gh pr create --fill && gh pr merge 5",
    laterOnly: "gh pr merge 5",
  },
  {
    earlier: "RAW-GH-PR-MERGE-BYPASS",
    later: "GATE-COMMENT-DRAFT-REQUIREMENTS",
    command: "gh pr merge 5 && gh pr ready 5",
    laterOnly: "gh pr ready 5",
  },
];

/**
 * The two INLINE denies (no registered rule id) sit INSIDE the same ordered body: the `timeout`-wrapped
 * sanctioned-command deny between COPILOT-FOLLOWUP-WAIT-TOOLS and SUBISSUE-NO-ADHOC-BYPASS, and the
 * subagent ad-hoc external-write deny between WORKTREE-NO-STASH and STOP-HUMAN-MERGE-001. The pair
 * table above is asserted to cover exactly the registered consecutive pairs, so an inline deny cannot
 * ride in it; each entry here pins its deny's PLACE with two commands: one that also trips the
 * registered rule ABOVE it (that rule must still win) and one that also trips the registered rule BELOW
 * it (the inline deny must win, with `ruleId: null` and its own exact reason — which also proves the
 * inline body still matches, so the pairs above are real order tests).
 */
const INLINE_ORDER_PAIRS = [
  {
    name: "timeout-wrapped sanctioned command",
    facts: BASE,
    above: {
      id: "COPILOT-FOLLOWUP-WAIT-TOOLS",
      command: "nohup node scripts/github/probe-copilot-review.mjs --pr 5 > /tmp/x.log 2>&1 & timeout 30 dev-loops-run cli/index.mjs gate resolve-validation",
    },
    below: {
      id: "SUBISSUE-NO-ADHOC-BYPASS",
      command: "timeout 30 dev-loops-run cli/index.mjs gate resolve-validation && gh api -X POST repos/mfittko/dev-loops/issues/5/sub_issues -f child=6",
    },
  },
  {
    name: "subagent ad-hoc external write",
    facts: { ...BASE, role: "developer", humanMergeOnly: true },
    above: { id: "WORKTREE-NO-STASH", command: "git stash && gh issue comment 5 --body hi" },
    below: { id: "STOP-HUMAN-MERGE-001", command: "gh issue comment 5 --body hi && gh pr merge 5" },
  },
];

test("rule order is the evaluation order, not just the list order", () => {
  // EVERY consecutive pair, not a sample: a command that matches two adjacent rules must report the
  // EARLIER one. A hand-swapped pair of `if` bodies then fails here even though `RULE_FIXTURES` still
  // sees each rule fire on its own isolated command.
  assert.deepEqual(
    ORDER_PAIRS.map(({ earlier, later }) => [earlier, later]),
    [...BASH_GATE_RULES].slice(0, -1).map((id, i) => [id, BASH_GATE_RULES[i + 1]]),
    "ORDER_PAIRS must cover exactly the consecutive pairs of BASH_GATE_RULES",
  );
  for (const { earlier, later, command, laterOnly, facts } of ORDER_PAIRS) {
    const entryFacts = facts ? { ...BASE, ...facts } : BASE;
    const decision = decideBashGateDeny({ ...entryFacts, command });
    assert.ok(decision, `${earlier} vs ${later}: the shared command denied nothing`);
    assert.equal(
      decision.ruleId,
      earlier,
      `${earlier} must beat ${later} — the two rule bodies are swapped or reordered`,
    );
    // The premise check that keeps the pair assertion meaningful: `laterOnly` must still trip the
    // LATER rule on its own, so the pair above is a real order test and not two dead bodies.
    assert.equal(
      decideBashGateDeny({ ...entryFacts, command: laterOnly }).ruleId,
      later,
      `${later} did not deny its own laterOnly command — the ${earlier} vs ${later} pair proves nothing`,
    );
  }
  // A consecutive-pair table cannot express NON-ADJACENT order, so these three stay: each command
  // pairs an EARLIER rule with a rule further down the list and must still report the earlier one.
  assert.equal(
    decideBashGateDeny({ ...BASE, command: "gh pr create --fill && node -e 'x'" }).ruleId,
    "OPS-NO-INLINE-INTERPRETER",
    "OPS-NO-INLINE-INTERPRETER (2) must beat OPS-DRAFT-FIRST-PR (10)",
  );
  assert.equal(
    decideBashGateDeny({ ...BASE, humanMergeOnly: true, command: "node -e 'x' && gh pr merge 5" }).ruleId,
    "OPS-NO-INLINE-INTERPRETER",
    "OPS-NO-INLINE-INTERPRETER (2) must beat STOP-HUMAN-MERGE-001 (9)",
  );
  assert.equal(
    decideBashGateDeny({ ...BASE, humanMergeOnly: true, command: "git stash && gh pr merge 5" }).ruleId,
    "WORKTREE-NO-STASH",
    "WORKTREE-NO-STASH (8) must beat STOP-HUMAN-MERGE-001 (9)",
  );
});

test("the inline denies keep their place inside the ordered body", () => {
  for (const { name, facts, above, below } of INLINE_ORDER_PAIRS) {
    const entryFacts = { ...BASE, ...facts };
    const inlineReason = INLINE_FIXTURES.find((fixture) => fixture.name === name)?.reason;
    assert.ok(inlineReason, `${name} needs an INLINE_FIXTURES entry so its reason text has one home`);
    assert.equal(
      decideBashGateDeny({ ...entryFacts, command: above.command }).ruleId,
      above.id,
      `the inline deny ${name} must not outrank ${above.id}`,
    );
    const belowDecision = decideBashGateDeny({ ...entryFacts, command: below.command });
    assert.ok(belowDecision, `${name} vs ${below.id}: the shared command denied nothing`);
    assert.equal(belowDecision.ruleId, null, `the inline deny ${name} must beat ${below.id} and claim no rule id`);
    assert.equal(belowDecision.reason, inlineReason, `the inline deny ${name} reason text changed`);
  }
});

test("the unresolve owner allowlist is the shared set's FIRST rule", () => {
  // Exported on its own because the Claude seam evaluates it ahead of its two Claude-only role
  // boundaries, so the shared decision must reach the SAME body — and reach it first, which is why
  // a `judge` attempt on the script reports this reason rather than the judge boundary's.
  const command = "dev-loops-run scripts/github/unresolve-review-thread.mjs --repo mfittko/dev-loops --pr 5 --thread-id T1";
  assert.equal(decideUnresolveOwnerDeny({ command, role: null }), null, "the main agent owns unresolve");
  assert.equal(decideUnresolveOwnerDeny({ command, role: "dev-loop" }), null, "the dev-loop coordinator owns unresolve");
  assert.equal(
    decideBashGateDeny({ ...BASE, role: "judge", command }).reason,
    decideUnresolveOwnerDeny({ command, role: "judge" }).reason,
    "the shared decision must not reach the allowlist through another rule",
  );
  // A command that ALSO trips a registered rule must still report the allowlist: this pins the
  // allowlist above the first registered rule this command also trips (`WORKTREE-NO-STASH`).
  const combined = `${command} && git stash`;
  const allowlist = decideUnresolveOwnerDeny({ command: combined, role: "fixer" });
  assert.ok(allowlist, "the allowlist must deny this combined command");
  const shared = decideBashGateDeny({ ...BASE, role: "fixer", command: combined });
  assert.equal(shared.ruleId, null, "the allowlist carries no registered rule id");
  assert.equal(shared.reason, allowlist.reason, "a registered rule must not outrank the allowlist block");
  // The FIRST registered rule (COORDINATOR-VERIFY-BOUNDARY) needs `enforceCoordinator` plus a
  // coordinator role, and `gate-coordinator` — unlike `dev-loop` — does NOT own unresolve, so an
  // unresolve chained with a code-verification entrypoint trips BOTH bodies and must still report the
  // allowlist. Swapping the allowlist with that first registered check would surface the coordinator
  // reason here and fail.
  const coordinatorCombined = `${command} && bun run verify`;
  const coordinatorAllowlist = decideUnresolveOwnerDeny({ command: coordinatorCombined, role: "gate-coordinator" });
  assert.ok(coordinatorAllowlist, "the allowlist must deny an unresolve run by the gate coordinator");
  const coordinatorShared = decideBashGateDeny({ ...BASE, enforceCoordinator: true, role: "gate-coordinator", command: coordinatorCombined });
  assert.equal(coordinatorShared.ruleId, null, "the allowlist carries no registered rule id");
  assert.equal(coordinatorShared.reason, coordinatorAllowlist.reason, "COORDINATOR-VERIFY-BOUNDARY must not outrank the allowlist block");
});

test("an unparsable lifecycle verb is attributed to the verb's own rule", () => {
  // `gh pr merge` with no PR number never reaches the wrapper hint, so the rule has to name itself
  // from the verb alone — the attribution no PR-number branch owns.
  const decision = decideBashGateDeny({ ...BASE, command: "gh pr merge" });
  assert.equal(decision.ruleId, "RAW-GH-PR-MERGE-BYPASS");
  assert.equal(decision.reason, "gh pr merge blocked: could not determine the PR number from the command. Include the PR number explicitly.");
});

test("an allowed command returns no decision", () => {
  assert.equal(decideBashGateDeny({ ...BASE, command: "gh pr ready 5", readyGate: { passed: true, error: null } }), null);
  assert.equal(
    decideBashGateDeny({ command: "ls", role: "dev-loop", repoSlug: null, managedRepoSlug: null, inManagedContext: false, humanMergeOnly: false, enforceCoordinator: false }),
    null,
  );
});

test("a missing or mistyped required fact is refused instead of defaulted (fail closed)", () => {
  // One case per failure shape: omitted, mistyped (a boolean given as its string form), and the two
  // ways `command` — the fact EVERY rule reads — can be wrong. The reason names the fact the caller
  // did not supply, so a validator relaxed to `typeof value !== "undefined"` fails here.
  const drop = (bag, ...names) => Object.fromEntries(Object.entries(bag).filter(([name]) => !names.includes(name)));
  const complete = { ...BASE, command: "gh pr merge 5" };
  const omitted = drop(complete, "enforceCoordinator");
  const misspelled = { ...drop(complete, "command"), cmd: "gh pr merge 5" };
  const cases = [
    ["enforceCoordinator omitted", omitted, "enforceCoordinator"],
    ["humanMergeOnly mistyped", { ...complete, humanMergeOnly: "false" }, "humanMergeOnly"],
    ["command misspelled `cmd`", misspelled, "command"],
    ["command undefined", { ...complete, command: undefined }, "command"],
    ["command not a string", { ...complete, command: null }, "command"],
  ];
  for (const [name, facts, missing] of cases) {
    const decision = decideBashGateDeny(facts);
    assert.ok(decision, `${name}: a missing fact must deny, never run the rules on a default`);
    assert.match(decision.reason, new RegExp(`supplied no valid ${missing} fact`));
    assert.equal(decision.ruleId, null);
  }
});

test("a null or absent facts bag is refused, never thrown on", () => {
  // A throw in a PreToolUse seam does not block the command, so the deny has to survive `null`.
  // `readyGate` is in the list too: it is a validated fact now, so the whole-bag refusal names it.
  const everyFact = ["command", "role", "repoSlug", "managedRepoSlug", "inManagedContext", "humanMergeOnly", "enforceCoordinator", "readyGate"];
  for (const bag of [undefined, null, {}]) {
    const decision = decideBashGateDeny(bag);
    assert.ok(decision, `facts ${String(bag)} must deny instead of throwing or allowing`);
    assert.equal(decision.ruleId, null);
    for (const fact of everyFact) assert.match(decision.reason, new RegExp(fact), `a whole-bag refusal must name ${fact}`);
  }
  // The argument-less spelling is the same call as the `undefined` bag above, asserted on its own
  // because it is the form a second adapter's missing facts resolver produces.
  assert.match(decideBashGateDeny().reason, /supplied no valid command/);
});

/**
 * `readyGate` input-form coverage (GATE-EXEC-REMEDIATION-SITE-QUERY, #3032): one test per accepted and
 * rejected form. `readyGate` is the adapter fact whose "not probed" value is meaningful, and it used to
 * be the ONE fact the required-fact check skipped — a malformed NON-null probe was silently read as "not
 * probed", so the deny misattributed the block to missing evidence instead of naming the bad fact.
 */
const READY_PROBE = { ...BASE, command: "gh pr ready 5" };

test("readyGate accepts null, its 'not probed' value", () => {
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: null });
  assert.equal(decision.ruleId, "GATE-COMMENT-DRAFT-REQUIREMENTS");
  assert.equal(decision.reason, "gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #5.");
});

test("readyGate accepts an absent key, its other 'not probed' value", () => {
  const noReadyGate = { ...READY_PROBE };
  delete noReadyGate.readyGate;
  const decision = decideBashGateDeny(noReadyGate);
  assert.equal(decision.ruleId, "GATE-COMMENT-DRAFT-REQUIREMENTS");
  assert.equal(decision.reason, "gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #5.");
});

test("readyGate accepts a well-formed passing probe", () => {
  assert.equal(decideBashGateDeny({ ...READY_PROBE, readyGate: { passed: true, error: null } }), null);
});

test("readyGate accepts a well-formed failing probe", () => {
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: { passed: false, error: "draft-gate verdict missing" } });
  assert.equal(decision.ruleId, "GATE-COMMENT-DRAFT-REQUIREMENTS");
  assert.equal(decision.reason, "gh pr ready blocked: draft-gate evidence check failed (draft-gate verdict missing).");
});

test("a readyGate bag with no boolean `passed` is refused naming readyGate", () => {
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: { ok: true } });
  assert.ok(decision, "a malformed probe must deny instead of degrading to 'not probed'");
  assert.equal(decision.ruleId, null);
  assert.match(decision.reason, /supplied no valid readyGate fact/);
});

test("a readyGate probe whose `passed` is a string is refused naming readyGate", () => {
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: { passed: "true" } });
  assert.ok(decision, "a mistyped `passed` must deny instead of degrading to 'not probed'");
  assert.equal(decision.ruleId, null);
  assert.match(decision.reason, /supplied no valid readyGate fact/);
});

test("a readyGate probe whose `error` is neither a string nor null is refused naming readyGate", () => {
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: { passed: false, error: 0 } });
  assert.ok(decision, "a mistyped `error` must deny instead of degrading to 'not probed'");
  assert.equal(decision.ruleId, null);
  assert.match(decision.reason, /supplied no valid readyGate fact/);
});

test("a readyGate probe with a boolean `passed` but no `error` key is refused naming readyGate", () => {
  // The form where the error-presence requirement decides the outcome: a natural shape for an adapter
  // that reports only success. An absent `error` is malformed, never defaulted to null.
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: { passed: true } });
  assert.ok(decision, "an absent `error` must deny instead of degrading to 'not probed'");
  assert.equal(decision.ruleId, null);
  assert.match(decision.reason, /supplied no valid readyGate fact/);
});

test("a non-object non-null readyGate probe is refused naming readyGate", () => {
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: "probe" });
  assert.ok(decision, "a non-object probe must deny instead of degrading to 'not probed'");
  assert.equal(decision.ruleId, null);
  assert.match(decision.reason, /supplied no valid readyGate fact/);
});

test("a readyGate probe whose `error` is an empty string is refused naming readyGate", () => {
  // A well-formed failing probe with an empty message would otherwise be kept by `?? null` and then
  // read as "not probed" by the truthiness tests at both deny sites, misattributing the block.
  const decision = decideBashGateDeny({ ...READY_PROBE, readyGate: { passed: false, error: "" } });
  assert.ok(decision, "an empty `error` must deny instead of degrading to 'not probed'");
  assert.equal(decision.ruleId, null);
  assert.match(decision.reason, /supplied no valid readyGate fact/);
});

const MERGE_CMD = "dev-loops-run scripts/github/merge-pr.mjs --repo mfittko/dev-loops --pr 2630 --human-approved-by mfittko";
const MERGE_DENY_FORMS = [
  MERGE_CMD,
  "node scripts/github/merge-pr.mjs --repo mfittko/dev-loops --pr 2902 --standing-authorization",
  "DEVLOOPS_RUN_ID=x dev-loops-run scripts/github/merge-pr.mjs --repo mfittko/dev-loops --pr 5",
  "cd x && dev-loops-run scripts/github/merge-pr.mjs --repo mfittko/dev-loops --pr 5",
  'bash -c "dev-loops-run scripts/github/merge-pr.mjs --pr 5"',
  "dev-loops-run --repo-root /wt scripts/github/merge-pr.mjs --repo mfittko/dev-loops --pr 5",
  "node --import ./x.mjs scripts/github/merge-pr.mjs --pr 5",
  "{ node scripts/github/merge-pr.mjs --pr 5; }",
  "if true; then node scripts/github/merge-pr.mjs --pr 5; fi",
  "for i in 1; do node scripts/github/merge-pr.mjs --pr 5; done",
  "! node scripts/github/merge-pr.mjs --pr 5",
  "node scripts/github/merge-pr.mjs --check=false --pr 5",
  "node scripts/github/merge-pr.mjs --check --check=false --pr 5",
];

test("any subagent role is denied merge-pr.mjs without --check (issue 2500)", () => {
  for (const role of ["dev-loop", "dev-loops:dev-loop", "gate-coordinator", "fixer"]) {
    for (const command of MERGE_DENY_FORMS) {
      const d = decideBashGateDeny({ ...BASE, role, command });
      assert.ok(d, `${role}: ${command}`);
      assert.equal(d.ruleId, null);
      assert.equal(d.reason, decideMergePrOwnerDeny({ command, role }).reason);
      assert.match(d.reason, /orchestrator/);
      assert.match(d.reason, /--check/);
    }
  }
});

test("merge-pr.mjs stays open to the top-level session, to --check and to mere mentions (issue 2500)", () => {
  for (const command of MERGE_DENY_FORMS) {
    assert.equal(decideBashGateDeny({ ...BASE, role: null, command }), null, command);
    if (command.includes("--check")) continue;
    assert.equal(decideBashGateDeny({ ...BASE, role: "fixer", command: command.replace("merge-pr.mjs", "merge-pr.mjs --check") }), null, command);
  }
  for (const command of [
    'git commit -m "run merge-pr.mjs later"',
    "grep merge-pr.mjs README.md",
    "cat scripts/github/merge-pr.mjs",
    "echo node scripts/github/merge-pr.mjs",
  ]) {
    assert.equal(decideBashGateDeny({ ...BASE, role: "fixer", command }), null, command);
  }
});
