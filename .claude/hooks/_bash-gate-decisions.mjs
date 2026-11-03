// GENERATED from packages/core/src/loop/bash-gate-decisions.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Harness-neutral Bash-gate deny decisions, moved VERBATIM out of the Claude Code PreToolUse seam
 * (`packages/core/src/claude/hook-decisions.mjs`, `decideBashGate`), which now delegates to
 * `decideBashGateDeny`: same evaluation order, predicates and reason texts. The rules key on the
 * command string plus injected facts, never on Claude machinery, so a second adapter can reach these
 * same bodies instead of growing a drifting copy. The two rules that DO key on Claude role machinery
 * — the judge command restriction and the fixer pull-line / grant binding — stay at that edge. The
 * fact list and rule inventory are owned by `skills/docs/cross-harness-regression-contract.md`.
 *
 * Facts are injected per call, so this module stays pure. Every fact is REQUIRED, and an omitted or
 * mistyped one is refused fail-closed instead of defaulted: a permissive default silently switches
 * off the deny it backs (`humanMergeOnly: false` fails STOP-HUMAN-MERGE-001 open) and the omission is
 * invisible at the call site. `readyGate` is nullable as its own meaningful "not probed" value, which
 * still gates `gh pr ready`; any other value must be a well-formed probe.
 *
 * `BASH_GATE_RULES` is the ordered registry of registered rule IDs, whose ids and reason literals are
 * pinned by `packages/core/test/bash-gate-decisions.test.mjs`. Inline denies instead carry
 * `ruleId: null`. When a `gh pr ready` / `gh pr merge` command names no PR number, no rule more
 * specific than the triggering verb is attributable, so that site borrows the verb's registry id.
 *
 * Pure and side-effect free.
 */

import {
  deriveInManagedRepo,
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  extractPrNumberFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  extractRepoFlagsFromGhPrCreateSegments,
  extractRepoFlagsFromGhPrMergeSegments,
  extractRepoFlagsFromGhPrReadySegments,
  commandContainsRawExternalWrite,
  extractRepoFlagsFromExternalWriteSegments,
  commandContainsGitStash,
  commandContainsSubIssueAdHocBypass,
  commandContainsReplyResolveBypass,
  commandContainsGraphqlResolveReviewThread,
  commandContainsCopilotRequestBypass,
  commandContainsCopilotSummonComment,
  commandContainsRawPrBodyEdit,
  commandContainsRawPrBodyApiWrite,
  commandContainsDetachedWaitTool,
  commandContainsTimeoutWrappedSanctionedTool,
  commandContainsInlineInterpreter,
  commandContainsCodeVerificationEntrypoint,
} from "./_bash-command-classify.mjs";

/**
 * The agent type (Claude `agent_type` / the canonical agent name) that owns repo mutations.
 * Only this subagent — not arbitrary subagents (Explore, Plan, generic Task agents) — may
 * bypass the main-agent read-only boundary.
 */
export const DEV_LOOP_AGENT_TYPE = "dev-loop";

/** The gate-round capsule agent (GATE-EXEC-GATE-COORDINATOR, ADR 0112). */
export const GATE_COORDINATOR_AGENT_TYPE = "gate-coordinator";
/**
 * Callers that hold the coordinator write and verify boundaries: the gate coordinator never loosens
 * them. Kept module-private and asked through `isCoordinatorRole` below — an exported Set is a mutable
 * boundary container, so a consumer's `.add(...)` would widen the coordinator boundary for the rest of
 * a long-lived hook/extension process.
 */
const COORDINATOR_AGENT_TYPES = new Set([DEV_LOOP_AGENT_TYPE, GATE_COORDINATOR_AGENT_TYPE]);

/**
 * True when the calling agent holds the coordinator write/verify boundaries. The one accessor the
 * shared rules and the Claude seam both call, so the Set above cannot be widened by mutation.
 * @param {string|null|undefined} role @returns {boolean}
 */
export const isCoordinatorRole = (role) => COORDINATOR_AGENT_TYPES.has(normalizeAgentType(role));

/**
 * Normalize a harness agent value that may be PLUGIN-NAMESPACED
 * (`<plugin-name>:<agent-name>`, e.g. `dev-loops:dev-loop`) to the bare agent name the coordinator
 * deciders compare against `DEV_LOOP_AGENT_TYPE`. Returns the substring after the last `:` when
 * present, else `agentType` unchanged (including `null`/non-string, passed through as-is).
 *
 * Applied in the coordinator-scoped deciders (`decideBashGate`, `decideBashGateDeny`,
 * `decideCoordinatorWriteGuard`). Deliberately NOT applied in `decideWriteGuard` — its
 * main-agent allow-set boundary is covered by the `DEVLOOPS_RUN_ID` run-id check first, and
 * broadening that decider's comparison is out of scope for the coordinator→worker delegation
 * boundary.
 * @param {string|null|undefined} agentType @returns {string|null|undefined}
 */
export function normalizeAgentType(agentType) {
  if (typeof agentType !== "string") return agentType;
  const idx = agentType.lastIndexOf(":");
  return idx === -1 ? agentType : agentType.slice(idx + 1);
}

// Intermediate tokens exclude shell separators so a compound command that only names the file is not an invocation.
// The interpreter may carry a path prefix and follow a backtick; the script path itself also matches as a command head.
const UNRESOLVE_INVOCATION = /(?:(?:^|[\s;&|(`])(?:[^\s;&|()`]*\/)?(?:node\s+(?:(?!(?:--check|-c)\s)[^\s;&|()`]+\s+)*?|(?:dev-loops-run|bun)\s+(?:[^\s;&|()`]+\s+)*?)|(?:^|[\n;&|(`])\s*)[^\s;&|()`]*unresolve-review-thread\.mjs(?=$|[\s;&|)`<>"'}])/;
/** True when the command runs scripts/github/unresolve-review-thread.mjs (issue 2577). */
export const isUnresolveInvocation = (command) => typeof command === "string" && UNRESOLVE_INVOCATION.test(command);

/**
 * Whether the command string also invokes an evidence-writing script (findings-log ledger or
 * checkpoint-verdict upsert). Used only to enrich the merge-block message — a compound
 * command combining an evidence write with `gh pr merge` is blocked pre-execution, so the write
 * never runs; this substring check has no false-negative cost (worst case: the plain message).
 */
function commandContainsEvidenceWrite(command) {
  return command.includes("write-gate-findings-log") || command.includes("upsert-checkpoint-verdict");
}

/**
 * The Bash-gate deny rules that carry a registered rule ID (a `skills/docs/required-rules.json`
 * entry defined in an owning contract doc), in EVALUATION ORDER. `decideBashGateDeny` returns the
 * matching id with its deny, so the list travels with the decisions instead of living only in a test
 * fixture — and `packages/core/test/bash-gate-decisions.test.mjs` asserts this exact list and each
 * rule's exact reason literal, so a reordered or reworded rule fails.
 *
 * Three denies below are inline denials with no registered rule ID — the unresolve owner allowlist,
 * the `timeout`-wrapped sanctioned command deny and the subagent ad-hoc external-write deny — so they
 * return `ruleId: null` and stay out of this list: listing them would mint rule IDs the rule registry
 * does not own.
 */
export const BASH_GATE_RULES = Object.freeze([
  "COORDINATOR-VERIFY-BOUNDARY",
  "OPS-NO-INLINE-INTERPRETER",
  "COPILOT-FOLLOWUP-WAIT-TOOLS",
  "SUBISSUE-NO-ADHOC-BYPASS",
  "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
  "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
  "ADR-TRIPWIRE-STANDING-WAIVER",
  "WORKTREE-NO-STASH",
  "STOP-HUMAN-MERGE-001",
  "OPS-DRAFT-FIRST-PR",
  "RAW-GH-PR-MERGE-BYPASS",
  "GATE-COMMENT-DRAFT-REQUIREMENTS",
]);

/**
 * The adapter-supplied facts this decision reads, each with the shape it must have. A missing or
 * mistyped entry refuses the decision instead of defaulting: `humanMergeOnly = false` would fail
 * STOP-HUMAN-MERGE-001 open, `inManagedContext = false` would switch every managed-repo rule off,
 * and a silent default made exactly that omission invisible at the call site. `command` is checked
 * here too — it is the fact every rule reads, so a caller that omits it or spells it `cmd` would
 * otherwise run all of them against an `undefined` command and allow. A slug is nullable (an
 * unresolvable identity still gates, fail closed). `readyGate` is checked here too, with a validator
 * that keeps its meaningful "not probed" value (`null`, or an absent key) while refusing a malformed
 * non-null bag: without it `{ ok: true }` or `{ passed: "true" }` would silently degrade to "not
 * probed", and the deny would then misreport the block as missing evidence instead of naming the bad
 * fact.
 */
const ADAPTER_FACTS = Object.freeze([
  ["command", (value) => typeof value === "string"],
  ["role", (value) => value === null || typeof value === "string"],
  ["repoSlug", (value) => value === null || typeof value === "string"],
  ["managedRepoSlug", (value) => value === null || typeof value === "string"],
  ["inManagedContext", (value) => typeof value === "boolean"],
  ["humanMergeOnly", (value) => typeof value === "boolean"],
  ["enforceCoordinator", (value) => typeof value === "boolean"],
  // `null`/absent is the meaningful "not probed" value; any other value must be a real probe of the
  // documented `{ passed: boolean, error: string|null }` shape, so a malformed bag is refused instead
  // of being read as "not probed". A non-null `error` must be a NON-EMPTY string: both deny sites read
  // `gateError` for truthiness, so an empty string would be read as "not probed" again and the deny
  // would misreport the block as missing evidence.
  ["readyGate", (value) =>
    value === null || value === undefined
    || (typeof value === "object" && typeof value.passed === "boolean"
      && (value.error === null || (typeof value.error === "string" && value.error.length > 0)))],
]);

/**
 * The unresolve owner allowlist (issue 2577) as its own rule: reopening a resolved review thread is
 * owned by the main agent (no role) and the dev-loop coordinator, so any other subagent context is
 * denied the script. The discriminator is the ROLE name alone, which every role-resolving adapter
 * supplies, so this is a harness-neutral rule and not a Claude-only one.
 *
 * Exported because `decideBashGateDeny` runs it FIRST among its rules while a caller that keeps its
 * own role branches ahead of the shared set — the Claude seam, whose judge boundary precedes the
 * shared deny — must reach the SAME body at that earlier point instead of keeping a second copy.
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null|undefined} params.role - Calling agent; null is the main agent / operator.
 * @returns {{ruleId: string|null, reason: string}|null} The deny decision, or null when allowed.
 */
export function decideUnresolveOwnerDeny({ command, role }) {
  const actor = normalizeAgentType(role);
  if (actor != null && actor !== DEV_LOOP_AGENT_TYPE && isUnresolveInvocation(command)) {
    // Inline deny with no registered rule ID (see BASH_GATE_RULES).
    // ponytail: token match only. Quote splitting, globs or variable expansion bypass it; this is a guardrail for cooperative agents.
    return {
      ruleId: null,
      reason:
        `The ${actor} agent may not unresolve review threads: scripts/github/unresolve-review-thread.mjs ` +
        "is owned by the orchestrator (main agent) and the dev-loop coordinator. Report the wrongly resolved thread in your hand-back and let the owner run it.",
    };
  }
  return null;
}

/**
 * Decide whether a Bash command must be denied by a dev-loop gate boundary.
 *
 * Gated commands on the managed repo (each rationale sits inline at its check):
 *   - `gh pr create` — blocked outright; PR creation must flow through the canonical wrapper
 *     (`scripts/github/create-pr.mjs` / `dev-loops-run cli/index.mjs pr create`), which always drafts and self-assigns.
 *   - `gh pr ready` — blocked without clean draft_gate evidence for the command's PR.
 *   - `gh pr merge` — blocked outright, and blocked earlier still under `humanMergeOnly`
 *     (STOP-HUMAN-MERGE-001). The sanctioned path is `scripts/github/merge-pr.mjs`; its gate
 *     evidence check requires a clean draft_gate transition record + current-head pre_approval_gate
 *     (GATE-COMMENT-DRAFT-REQUIREMENTS in skills/docs/gate-review-comment-contract.md).
 *   - raw `gh issue create` / `gh issue comment` / `gh issue edit` / `gh pr comment` — blocked ONLY
 *     from a SUBAGENT context (`role` non-null) on the managed repo. Sanctioned external writes
 *     flow through node wrappers; the MAIN AGENT / operator (role null) retains direct access.
 *   - the actor-independent guard rules (inline interpreters, detached wait tools, `timeout`-wrapped
 *     sanctioned tools, ad-hoc sub-issue / thread-reply / Copilot-request writes, raw PR/issue body
 *     writes, `git stash`), the coordinator verify boundary, and the unresolve owner allowlist.
 *
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null} params.role - Calling agent (the Claude `agent_type`, and the Pi
 *   `active_agent` role once the Pi adapter injects it); null for the main agent / operator, any
 *   other string for a subagent context.
 * @param {string|null} params.repoSlug - Resolved owner/name of the cwd repo (null if unknown).
 * @param {string|null} params.managedRepoSlug - Resolved owner/name of the dev-loops-managed
 *   repo (the repo `inManagedContext` refers to), or null when the identity can't be resolved.
 * @param {boolean} params.inManagedContext - Whether the current repo is dev-loops-managed (a
 *   `.devloops` config exists at its root).
 * @param {boolean} params.humanMergeOnly - Effective repo `autonomy.humanMergeOnly` invariant;
 *   when true, `gh pr merge` is refused actor-independently (STOP-HUMAN-MERGE-001).
 * @param {boolean} params.enforceCoordinator - Strict mode for the COORDINATOR-VERIFY-BOUNDARY
 *   boundary (`DEVLOOPS_COORDINATOR_READONLY=1`). Default fail-open.
 * @param {{passed: boolean, error: string|null}|null} [params.readyGate] - Draft-gate evidence
 *   probe result for the command's PR; null when the adapter did not probe.
 * @returns {{ruleId: string|null, reason: string}|null} The deny decision, or null to allow.
 *   `ruleId` is null for the three inline denies that carry no registered rule ID and for the
 *   missing-facts deny.
 */
export function decideBashGateDeny(facts = {}) {
  // A null BAG is coerced, never destructured directly: a throw does not block a PreToolUse command,
  // so throwing here would lose the very deny this validation exists to produce.
  const injected = facts ?? {};
  const missing = ADAPTER_FACTS.filter(([name, isValid]) => !isValid(injected[name])).map(([name]) => name);
  if (missing.length > 0) {
    return {
      ruleId: null,
      reason:
        `Bash gate blocked: the caller supplied no valid ${missing.join(", ")} fact(s), so the shared deny ` +
        "decision cannot run. Inject every adapter fact (`command`, `role`, `repoSlug`, `managedRepoSlug`, " +
        "`inManagedContext`, `humanMergeOnly`, `enforceCoordinator`, `readyGate`) instead of omitting one; " +
        "`readyGate` accepts only its 'not probed' shapes (`null` or an absent key) or a " +
        "`{ passed: boolean, error: string|null }` probe.",
    };
  }
  // Past the validation `command` is a required string, so the allow path for a non-string command is
  // gone: "nothing to gate" no longer means "run no rule", it means a missing fact.
  const { command, role, repoSlug, managedRepoSlug, inManagedContext, humanMergeOnly, enforceCoordinator, readyGate = null } = injected;
  const gatePassed = readyGate?.passed === true;
  const gateError = readyGate?.error ?? null;

  // Unresolve ownership (issue 2577) is the FIRST rule, so this shared set reproduces the Claude
  // seam's evaluation order exactly (there the owner allowlist is checked before the judge and fixer
  // boundaries, which is why a `judge` attempt on the script reports the owner-allowlist reason).
  const unresolve = decideUnresolveOwnerDeny({ command, role });
  if (unresolve) {
    return unresolve;
  }

  // COORDINATOR-VERIFY-BOUNDARY: a known code-verification/build entrypoint (bun run
  // verify/test, vitest, npm test/run test/run build, ...) run inline by the dev-loop COORDINATOR
  // itself (agent_type "dev-loop" or "gate-coordinator"). The hook allows WORKER subagents to run targeted checks;
  // full-repository runs still belong to gate resolve-validation. Only the coordinator is scoped
  // out here, mirroring `decideCoordinatorWriteGuard`'s
  // agent_type discriminator. Opt-in via the same `DEVLOOPS_COORDINATOR_READONLY=1` flag as the
  // write-guard boundary; default fail-open. Not scoped to `inManagedRepo` — this is a local
  // command-invocation boundary (which binary ran), not a GitHub-repo-targeting one.
  if (enforceCoordinator && isCoordinatorRole(role) && commandContainsCodeVerificationEntrypoint(command)) {
    // A gate coordinator dispatches no worker (decideAgentDispatch), so its reason names its own path.
    const reason = normalizeAgentType(role) === GATE_COORDINATOR_AGENT_TYPE
      ? "COORDINATOR-VERIFY-BOUNDARY: the gate coordinator must not run code-verification/build " +
        "commands inline. Run the round's full validation through `dev-loops-run cli/index.mjs gate resolve-validation`; " +
        "for any other check, stop and return a typed observation to the dev-loop coordinator " +
        "(GATE-EXEC-GATE-COORDINATOR). See skills/docs/main-agent-contract.md."
      : "COORDINATOR-VERIFY-BOUNDARY: the dev-loop coordinator must not run code-verification/build " +
        "commands inline. Delegate targeted checks to a fresh worker subagent (developer/fixer/" +
        "quality), which reports back a compact pass/fail plus any failing-test names. " +
        "Request local full-repository validation through `dev-loops-run cli/index.mjs gate resolve-validation` on a clean commit; when " +
        "checking a pushed commit, prefer CI's structured conclusion (`gh pr checks` / " +
        "scripts/github/detect-checkpoint-evidence.mjs) over a local run. See skills/docs/main-agent-contract.md.";
    return { ruleId: "COORDINATOR-VERIFY-BOUNDARY", reason };
  }
  // Normalize (trim + case-fold) so a divergent slug (surrounding whitespace, casing) does not
  // silently fail OPEN. A repo is dev-loops-managed when inManagedContext is true (a .devloops
  // config exists at its root); the managed slug is that repo's resolved identity, which may be
  // unresolvable (null). FAIL CLOSED: inside a managed context whose identity can't be resolved,
  // every guard below still applies (inManagedRepo stays true) rather than silently allowing
  // everything — an unresolvable identity must never disable the guard suite.
  const managedSlug = (managedRepoSlug ?? "").trim().toLowerCase() || null;
  const inManagedRepo = deriveInManagedRepo({ inManagedContext, managedRepoSlug, repoSlug });

  // OPS-NO-INLINE-INTERPRETER: inline interpreters (`node -e`/`--eval`/`-p`, `python3 -c`,
  // `bun -e`/`--eval`/`-p`/`--print`/`bun -`, heredocs fed to node/python/bun) are barred actor-independently on the target repo — the rule bars
  // "Coordinator and agent flows"; sanctioned output parsing uses `--jq`/`--silent`, never an
  // inline interpreter.
  if (inManagedRepo && commandContainsInlineInterpreter(command)) {
    return {
      ruleId: "OPS-NO-INLINE-INTERPRETER",
      reason:
        "OPS-NO-INLINE-INTERPRETER: inline interpreters (node -e/--eval/-p, python3 -c, bun -e/--eval/-p/--print, bun -, " +
        "heredoc to node/python/bun) are barred in the dev-loop flow. Parse tool output via --jq/--silent and mutate " +
        "files via the editor/patch tools or a --jq-composed --body-file, never an inline interpreter.",
    };
  }

  // COPILOT-FOLLOWUP-WAIT-TOOLS: banned detached/polling wait wrappers. Actor-independent: the
  // coordinator/main agent — not subagents only — is the actor that leaves backgrounded
  // `until`/`while … sleep … done` poll loops and bare-`&` backgrounded probe shells orphaned
  // under the Claude Code harness (no async wake to join them), so the gate must deny its
  // backgrounding too. Evaluated HERE, before the `gh pr ready`/`merge`/`create` classification,
  // so a compound command that pairs a lifecycle verb with a backgrounded wait
  // (`gh pr create --repo other/x && node …/probe-copilot-review.mjs … &`) cannot short-circuit
  // past it via the create/ready ALLOW paths. The sanctioned wait is always a bounded FOREGROUND
  // inline probe (`probe-copilot-review.mjs` / `wait-pr-checks.mjs` with an explicit
  // --timeout <seconds>; `gh run watch`; the watch-cycle CLIs).
  if (inManagedRepo && commandContainsDetachedWaitTool(command)) {
    return {
      ruleId: "COPILOT-FOLLOWUP-WAIT-TOOLS",
      reason:
        "COPILOT-FOLLOWUP-WAIT-TOOLS: wait only through a bounded FOREGROUND probe (scripts/github/" +
        "probe-copilot-review.mjs or scripts/github/wait-pr-checks.mjs with an explicit " +
        "--timeout <seconds>; scripts/loop/detect-copilot-loop-state.mjs one-shot; dev-loops-run cli/index.mjs loop watch-cycle; " +
        "gh run watch) — nohup/disown/tmux/screen detach, while-sleep-poll loops, and bare-`&` " +
        "backgrounding of a probe/wait script are barred for the coordinator and every subagent (a " +
        "backgrounded wait orphans under Claude Code, which has no async wake to join it).",
    };
  }

  // `timeout N <sanctioned command>` hides the `dev-loops-run` head from operator allow rules
  // (issue 2755). Sanctioned wait tools bound themselves with `--timeout <seconds>`. Inline deny with
  // no registered rule ID (see BASH_GATE_RULES).
  if (inManagedRepo && commandContainsTimeoutWrappedSanctionedTool(command)) {
    return {
      ruleId: null,
      reason:
        "Do not wrap sanctioned dev-loops commands in `timeout N`: the wrapper hides the " +
        "`dev-loops-run` head from operator allow rules. Run the command bare. Wait/probe tools bound " +
        "themselves with `--timeout <seconds>`; other commands rely on the harness tool-call timeout.",
    };
  }

  // SUBISSUE-NO-ADHOC-BYPASS: ad-hoc `gh api` writes to the target repo's sub-issue endpoints.
  // Actor-independent (no reserved direct path). Gated on the target repo: the absolute slug-embedded
  // form identifies the target repo; the bare relative form (`gh api issues/5/sub_issues`) resolves
  // against the cwd repo, so it is in scope only when running in the target repo (mirrors the
  // explicit-`--repo`/cwd-target posture).
  if (inManagedRepo && commandContainsSubIssueAdHocBypass(command, managedSlug)) {
    return {
      ruleId: "SUBISSUE-NO-ADHOC-BYPASS",
      reason:
        "SUBISSUE-NO-ADHOC-BYPASS: ad-hoc `gh api` writes to the target repo's sub_issues endpoint are " +
        "blocked. Manage sub-issues via the sanctioned manage-sub-issues wrapper instead.",
    };
  }

  // COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER: ad-hoc thread-resolution writes — raw `gh api` POST
  // to pulls/<n>/comments/<m>/replies, or a `gh api graphql` resolveReviewThread mutation (the Rest
  // path names the target repo; the graphql form has no path-host repo, so it is scoped to the cwd
  // repo). Actor-independent: reply through reply-resolve-review-thread(s).mjs.
  if (inManagedRepo && (commandContainsReplyResolveBypass(command, managedSlug) || commandContainsGraphqlResolveReviewThread(command))) {
    return {
      ruleId: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER",
      reason:
        "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER: ad-hoc thread-reply mutations are blocked. Resolve review " +
        "threads via scripts/github/reply-resolve-review-thread.mjs (one thread) or " +
        "reply-resolve-review-threads.mjs (multiple threads, --message-map), not raw gh api/graphql. " +
        "To reopen a wrongly resolved thread, the orchestrator or dev-loop coordinator runs " +
        "scripts/github/unresolve-review-thread.mjs (never raw unresolveReviewThread).",
    };
  }

  // COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY: ad-hoc Copilot review requests — raw `gh api` writes
  // to pulls/<n>/requested_reviewers, or a bare `/copilot` / `/copilot re-review` comment summon on the
  // target repo. Actor-independent: request Copilot via scripts/github/request-copilot-review.mjs.
  if (inManagedRepo && (commandContainsCopilotRequestBypass(command, managedSlug) || commandContainsCopilotSummonComment(command))) {
    return {
      ruleId: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY",
      reason:
        "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY: ad-hoc Copilot review requests are blocked. Request Copilot " +
        "via scripts/github/request-copilot-review.mjs — do not write requested_reviewers or post a literal " +
        "/copilot comment.",
    };
  }

  // ADR-TRIPWIRE-STANDING-WAIVER: raw PR/issue body writes (`gh pr edit --body`/`--body-file`, a `gh api`
  // write of a body field or --input to pulls/<n> or issues/<n>, a graphql updatePullRequest) are the path that carries an `adr-tripwire:allow` waiver
  // line. Actor-independent defense in depth: the agent and the operator share one GitHub credential,
  // so the sanctioned writers (which refuse a hand-written waiver line) are the only body route.
  if (inManagedRepo && (commandContainsRawPrBodyEdit(command, managedSlug) || commandContainsRawPrBodyApiWrite(command, managedSlug))) {
    return {
      ruleId: "ADR-TRIPWIRE-STANDING-WAIVER",
      reason:
        "ADR-TRIPWIRE-STANDING-WAIVER: raw `gh pr edit` body writes and `gh api` body writes to pulls/<n> or issues/<n> are blocked. Edit a PR body through the launcher " +
        "(`dev-loops-run cli/index.mjs pr edit`), which refuses a hand-written adr-tripwire:allow line. Edit an issue body " +
        "through `dev-loops-run cli/index.mjs issue edit`. Write the ADR " +
        "tripwire waiver only through the launcher (`dev-loops-run cli/index.mjs pr waive-adr-tripwire`), " +
        "which needs a standing authorization on the default branch.",
    };
  }

  // `git stash` writes to `refs/stash`, one ref shared by every worktree over this repo's single
  // `.git` directory — a stash from one worktree can pop into another's. Block it outright on the
  // target repo; see skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout for the
  // stash-free alternative (git diff / a patch file / a scratch checkout).
  if (commandContainsGitStash(command) && inManagedRepo) {
    return {
      ruleId: "WORKTREE-NO-STASH",
      reason:
        "git stash blocked: refs/stash is shared across every worktree over this repo's one .git directory, " +
        "so a stash can pop into a different worktree. Use `git diff` (or `git diff --staged`), save changes " +
        "to a patch file, or use a separate scratch worktree instead of stashing.",
    };
  }
  // Subagent-scoped external-write guard: block ad-hoc `gh issue create`/`gh issue comment`/
  // `gh issue edit`/`gh pr comment` on the target repo from a subagent, so external writes flow through the
  // sanctioned node wrappers. The main-agent/operator path (role null) is unaffected.
  if (typeof role === "string" && commandContainsRawExternalWrite(command)) {
    // The cwd repo IS the managed/target repo exactly when inManagedRepo.
    const cwdTargets = inManagedRepo;
    // Scope PER segment, mirroring the `gh pr create` block: in scope when no explicit --repo and
    // cwd is the target, or an explicit --repo/-R equals the managed slug. An explicit repo that is
    // PROVEN foreign (managedSlug resolves and differs) passes through; otherwise (managedSlug
    // unresolvable) we cannot prove the explicit repo is foreign, so a managed context fails closed
    // (in scope). DENY if ANY external-write segment is in scope.
    const anyWriteInScope = extractRepoFlagsFromExternalWriteSegments(command).some((seg) =>
      seg.explicitRepo == null
        ? cwdTargets
        : managedSlug !== null
          ? seg.explicitRepo.toLowerCase() === managedSlug
          : inManagedContext,
    );
    if (anyWriteInScope) {
      // Inline deny with no registered rule ID (see BASH_GATE_RULES).
      return {
        ruleId: null,
        reason:
          "Ad-hoc GitHub issue/PR creation, comments, and edits from a subagent are blocked. Use the sanctioned " +
          "node wrappers instead — gate-verdict comments via scripts/github/upsert-checkpoint-verdict.mjs, " +
          "review-thread replies via scripts/github/reply-resolve*.mjs, board sync, issue comments via " +
          "scripts/github/comment-issue.mjs, or issue-body edits via scripts/github/edit-issue.mjs. " +
          "Direct `gh issue create` is reserved for the main agent / operator.",
      };
    }
  }
  // Scan ALL shell segments — the PreToolUse gate blocks pre-emptively, so a gated verb in any
  // segment (even after `&&` or `;`) must be caught. This differs from the Pi extension's
  // post-execute `isGhPrReadyCommand`/`isGhPrMergeCommand` which scan only the first segment
  // (correct there: `false && gh pr ready 42` short-circuits so ready never ran).
  const isReady = commandContainsGhPrReady(command);
  const isMerge = commandContainsGhPrMerge(command);
  const isCreate = commandContainsGhPrCreate(command);

  // STOP-HUMAN-MERGE-001: when the repo resolves `autonomy.humanMergeOnly`, `gh pr merge` is
  // refused actor-independently — the main agent is the actor that performs GitHub writes, so only an
  // actor-independent deny enforces the human-merge invariant (an agent-scoped deny would enforce
  // nothing on the main-agent write path).
  if (humanMergeOnly && isMerge && inManagedRepo) {
    return {
      ruleId: "STOP-HUMAN-MERGE-001",
      reason:
        "STOP-HUMAN-MERGE-001: this repo resolves autonomy.humanMergeOnly — the loop must stop at merge " +
        "for a human action; the agent MUST NOT run `gh pr merge`. Leave the PR merge-ready and a human " +
        "merges it.",
    };
  }

  if (!isReady && !isMerge && !isCreate) {
    // The detached-wait deny (COPILOT-FOLLOWUP-WAIT-TOOLS) is evaluated earlier — actor-independently
    // and BEFORE this lifecycle-verb classification — so a compound command pairing a lifecycle verb
    // with a backgrounded wait cannot short-circuit past it through the create/ready ALLOW paths.
    return null;
  }

  // Raw `gh pr create` is blocked outright on the target repo (no PR number / gate evidence
  // exists yet): PR creation must flow through the canonical wrapper, which always drafts and
  // self-assigns. This closes the draft-first hole where raw `gh pr create` opens a ready PR.
  if (isCreate) {
    // The cwd repo IS the managed/target repo exactly when inManagedRepo.
    const cwdTargets = inManagedRepo;
    // Evaluate scope PER create segment, not just the first: a create is in scope when it
    // explicitly targets the repo, or (with no explicit --repo) the cwd is the repo. An explicit
    // `--repo <target>` is denied regardless of cwd — unless it is PROVEN foreign (managedSlug
    // resolves and differs); when managedSlug is unresolvable we cannot prove foreignness, so a
    // managed context fails closed (in scope). DENY if ANY create segment is in scope — otherwise a
    // leading out-of-scope create (`gh pr create --repo other/repo`) would short-circuit and shield
    // a later in-scope raw create (`&& gh pr create --fill`).
    const anyCreateInScope = extractRepoFlagsFromGhPrCreateSegments(command).some((seg) =>
      seg.explicitRepo == null
        ? cwdTargets
        : managedSlug !== null
          ? seg.explicitRepo.toLowerCase() === managedSlug
          : inManagedContext,
    );
    if (anyCreateInScope) {
      return {
        ruleId: "OPS-DRAFT-FIRST-PR",
        reason:
          "gh pr create blocked: open PRs via the canonical wrapper `node scripts/github/create-pr.mjs` " +
          "(a.k.a. `dev-loops-run cli/index.mjs pr create`), which always creates a draft and self-assigns. Raw `gh pr create` " +
          "defaults to ready-for-review and bypasses the draft-first contract (workflow.requireDraftFirst).",
      };
    }
    // The create is out of scope. Only allow outright when there is no ready/merge segment to
    // evaluate — otherwise fall through so a gated `gh pr ready`/`gh pr merge` in the same
    // compound command (e.g. `gh pr create --repo other/repo && gh pr merge 5`) is still gated
    // below rather than short-circuited.
    if (!isReady && !isMerge) {
      return null;
    }
  }
  // When both verbs appear in a compound command, the unconditional raw-merge refusal wins.
  const verb = isMerge ? "gh pr merge" : "gh pr ready";
  // Pass through only when EVERY gated verb segment is PROVEN foreign (explicit repo, managed slug
  // resolves, and demonstrably differs). A segment with no explicit repo, or an unresolvable managed
  // slug, is NOT proven foreign — fail closed (preserves the fail-closed default). Mirrors the
  // per-segment `.some()` scoping on the create/external-write paths: a proven-foreign FIRST segment
  // must not shield a later managed segment (`gh pr merge --repo other/x 1 && gh pr merge 2`).
  const gatedVerbSegments = [
    ...(isMerge ? extractRepoFlagsFromGhPrMergeSegments(command) : []),
    ...(isReady ? extractRepoFlagsFromGhPrReadySegments(command) : []),
  ];
  const allSegmentsProvenForeign =
    gatedVerbSegments.length > 0 &&
    gatedVerbSegments.every(
      (seg) =>
        seg.explicitRepo != null &&
        managedSlug !== null &&
        seg.explicitRepo.toLowerCase() !== managedSlug,
    );
  if (allSegmentsProvenForeign) {
    return null;
  }
  // Only gate within the managed repo.
  if (!inManagedRepo) {
    return null;
  }

  const prNumber = isMerge
    ? extractPrNumberFromGhPrMergeAnywhere(command)
    : extractPrNumberFromGhPrReadyAnywhere(command);
  if (prNumber === null) {
    // The verb's own rule owns this deny: the command names no PR number, so no rule more specific than the triggering verb can be attributed.
    return {
      ruleId: isMerge ? "RAW-GH-PR-MERGE-BYPASS" : "GATE-COMMENT-DRAFT-REQUIREMENTS",
      reason: `${verb} blocked: could not determine the PR number from the command. Include the PR number explicitly.`,
    };
  }

  // Raw `gh pr merge` is FORBIDDEN outright (RAW-GH-PR-MERGE-BYPASS): the only
  // sanctioned merge path is the wrapper, which enforces the mandatory approver,
  // merge class, and fresh-approval checks a bare evidence gate cannot. A
  // gate-passed raw merge would bypass all of those, so this denies
  // unconditionally (not only when evidence is missing) and points to the wrapper.
  // The wrapper's own internal `gh pr merge` is a child_process spawn, never a
  // Bash tool call, so it is never seen here.
  if (isMerge) {
    // This hook evaluates PreToolUse — BEFORE the Bash tool call runs. A compound command that
    // writes gate evidence (findings-log ledger, checkpoint verdict) and merges in the same call
    // is blocked here with the write never having executed. Hint the split when the command
    // carries an evidence-writing invocation alongside the merge.
    const alsoWritesEvidence = commandContainsEvidenceWrite(command);
    return {
      ruleId: "RAW-GH-PR-MERGE-BYPASS",
      reason:
        `gh pr merge is forbidden: route the merge through the sanctioned wrapper \`node scripts/github/merge-pr.mjs --repo <owner/name> --pr ${prNumber} --human-approved-by <login>\`, which runs the full precondition set fail-closed (mandatory approver, merge class, fresh approval) — a raw \`gh pr merge\` bypasses those (RAW-GH-PR-MERGE-BYPASS).` +
        (gateError ? ` (pre-merge gate evidence check also failed: ${gateError})` : "") +
        (alsoWritesEvidence
          ? " This command also writes gate evidence, but hooks evaluate before the command runs — never chain an evidence write with the merge."
          : ""),
    };
  }

  // `gh pr ready` keeps its gate-conditional behavior.
  if (gateError) {
    return {
      ruleId: "GATE-COMMENT-DRAFT-REQUIREMENTS",
      reason: `${verb} blocked: draft-gate evidence check failed (${gateError}).`,
    };
  }
  if (!gatePassed) {
    return {
      ruleId: "GATE-COMMENT-DRAFT-REQUIREMENTS",
      reason: `gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #${prNumber}.`,
    };
  }

  return null;
}
