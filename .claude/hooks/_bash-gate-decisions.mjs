// GENERATED from packages/core/src/loop/bash-gate-decisions.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Harness-neutral Bash-gate deny decisions (decision record 0206).
 *
 * The Claude Code PreToolUse Bash gate (`packages/core/src/claude/hook-decisions.mjs`,
 * `decideBashGate`) and the Pi `tool_call` handler (`extension/readonly-role-gate.ts`) both call
 * `decideBashGateDeny`, so a deny rule can no longer hold on one harness and fail open on the
 * other (`skills/docs/cross-harness-regression-contract.md`). The rule bodies moved here verbatim
 * from the Claude seam: same evaluation order, same reason texts — existing tests pin those strings.
 *
 * Each adapter gathers its own facts and injects them, so this module stays pure. Every one of those
 * facts is REQUIRED and an omitted or mistyped one is refused (fail closed) instead of defaulted: a
 * permissive default switches off the deny it backs, which is the omission both entry points were
 * already hardened against. `readyGate` alone stays nullable — `null` is its meaningful "not
 * probed" input, which still gates a ready verb:
 *   - `role` — the Claude `agent_type` or the Pi role resolved from the calling session's
 *     `active_agent` tag. `null` is the unrestricted main agent / operator on BOTH harnesses; any
 *     other string (including Pi's fail-closed unresolved `""`) is a subagent context.
 *   - `inManagedContext` / `managedRepoSlug` / `repoSlug` — the resolved repo identity. A managed
 *     context whose identity cannot be resolved still gates (fail closed).
 *   - `humanMergeOnly` — the repo's effective `autonomy.humanMergeOnly` invariant.
 *   - `enforceCoordinator` — `DEVLOOPS_COORDINATOR_READONLY=1`, the flag that also gates the
 *     coordinator write boundary.
 *   - `readyGate` — the `gh pr ready` draft-gate evidence probe (`{ passed, error }`). `null`
 *     means "not probed", which gates `gh pr ready` and still denies a raw merge.
 *
 * The Claude-only extras (the judge command restriction and the fixer pull-line / grant binding)
 * stay at the Claude edge: they key on Claude role machinery with no Pi equivalent.
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
/** Callers that hold the coordinator write and verify boundaries: the gate coordinator never loosens them. */
export const COORDINATOR_AGENT_TYPES = new Set([DEV_LOOP_AGENT_TYPE, GATE_COORDINATOR_AGENT_TYPE]);

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
 * The explicit list of Bash-gate deny rules that carry a registered rule ID (a
 * `required-rules.json` entry defined in an owning contract doc), in evaluation order, each with the
 * decision for whether the Pi `tool_call` handler enforces it (`pi`: `enforced` |
 * `read-only-role-gate` | `claude-only`). Every listed rule is `enforced` on both harnesses today
 * because the Pi adapter injects the same facts; a rule that cannot be must say so here, and state
 * why in skills/docs/cross-harness-regression-contract.md. `test/contracts/bash-gate-pi-parity.test.mjs`
 * pins this list against the contract matrix, so a new deny rule cannot be added without deciding
 * its Pi verdict.
 *
 * Two denies below are inline denials with no registered rule ID — the `timeout`-wrapped sanctioned
 * command deny and the subagent ad-hoc external-write deny — so they return `ruleId: null` and stay
 * out of this list: listing them would mint rule IDs the rule registry does not own.
 */
export const BASH_GATE_RULES = Object.freeze([
  Object.freeze({ id: "COORDINATOR-VERIFY-BOUNDARY", pi: "enforced" }),
  Object.freeze({ id: "OPS-NO-INLINE-INTERPRETER", pi: "enforced" }),
  Object.freeze({ id: "COPILOT-FOLLOWUP-WAIT-TOOLS", pi: "enforced" }),
  Object.freeze({ id: "SUBISSUE-NO-ADHOC-BYPASS", pi: "enforced" }),
  Object.freeze({ id: "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER", pi: "enforced" }),
  Object.freeze({ id: "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY", pi: "enforced" }),
  Object.freeze({ id: "ADR-TRIPWIRE-STANDING-WAIVER", pi: "enforced" }),
  Object.freeze({ id: "WORKTREE-NO-STASH", pi: "enforced" }),
  Object.freeze({ id: "STOP-HUMAN-MERGE-001", pi: "enforced" }),
  Object.freeze({ id: "OPS-DRAFT-FIRST-PR", pi: "enforced" }),
  Object.freeze({ id: "RAW-GH-PR-MERGE-BYPASS", pi: "enforced" }),
  Object.freeze({ id: "GATE-COMMENT-DRAFT-REQUIREMENTS", pi: "enforced" }),
]);

/**
 * True when EVERY one of `segments` is PROVEN foreign: it carries an explicit repo, the managed
 * slug resolves, and the explicit repo demonstrably differs. A segment with no explicit repo, or
 * an unresolvable managed slug, is NOT proven foreign (fail closed).
 *
 * Shared with the Pi fact adapter, which must reach the same verdict BEFORE it runs the `gh pr
 * ready` draft-gate probe: the probe's result is never consulted for a command this escape allows,
 * so a second, unlinked copy of the comparison in the adapter would let the two drift.
 * @param {Array<{explicitRepo: string|null}>} segments @param {string|null} managedSlug
 */
function segmentsProvenForeign(segments, managedSlug) {
  return (
    segments.length > 0 &&
    segments.every(
      (seg) =>
        seg.explicitRepo != null &&
        managedSlug !== null &&
        seg.explicitRepo.toLowerCase() !== managedSlug,
    )
  );
}

/**
 * The adapter-supplied facts this decision reads, each with the shape it must have. A missing or
 * mistyped entry refuses the decision instead of defaulting: `humanMergeOnly = false` would fail
 * STOP-HUMAN-MERGE-001 open, `inManagedContext = false` would switch every managed-repo rule off,
 * and a silent default made exactly that omission invisible at the call site. A slug is nullable
 * (an unresolvable identity still gates, fail closed); `readyGate` is deliberately absent here
 * because `null` is its meaningful "not probed" value.
 */
const ADAPTER_FACTS = Object.freeze([
  ["role", (value) => value === null || typeof value === "string"],
  ["repoSlug", (value) => value === null || typeof value === "string"],
  ["managedRepoSlug", (value) => value === null || typeof value === "string"],
  ["inManagedContext", (value) => typeof value === "boolean"],
  ["humanMergeOnly", (value) => typeof value === "boolean"],
  ["enforceCoordinator", (value) => typeof value === "boolean"],
]);

/**
 * The `gh pr ready` half of the proven-foreign escape, for an adapter that decides whether to probe
 * at all. `managedSlug` must already be normalized the way this module normalizes it (trimmed,
 * lowercased, `null` when unresolvable) so the adapter and the decision agree.
 * @param {string} command @param {string|null} [managedSlug]
 * @returns {boolean}
 */
export function prReadySegmentsProvenForeign(command, managedSlug = null) {
  return segmentsProvenForeign(extractRepoFlagsFromGhPrReadySegments(command), managedSlug ?? null);
}

/**
 * Decide whether a Bash command must be denied by a dev-loop gate boundary.
 *
 * Gated commands on the managed repo (each rationale sits inline at its check):
 *   - `gh pr create` — blocked outright; PR creation must flow through the canonical wrapper
 *     (`scripts/github/create-pr.mjs` / `dev-loops-run cli/index.mjs pr create`), which always drafts and self-assigns.
 *   - `gh pr ready` — blocked without clean draft_gate evidence.
 *   - `gh pr merge` — blocked outright, and blocked earlier still under `humanMergeOnly`
 *     (STOP-HUMAN-MERGE-001). The sanctioned path is `scripts/github/merge-pr.mjs`; its gate
 *     evidence check requires a clean draft_gate transition record + current-head pre_approval_gate
 *     (GATE-COMMENT-DRAFT-REQUIREMENTS in skills/docs/gate-review-comment-contract.md).
 *   - raw `gh issue create` / `gh issue comment` / `gh issue edit` / `gh pr comment` — blocked ONLY
 *     from a SUBAGENT context (`role` non-null) on the managed repo. Sanctioned external writes
 *     flow through node wrappers; the MAIN AGENT / operator (role null) retains direct access.
 *   - the actor-independent guard rules (inline interpreters, detached wait tools, `timeout`-wrapped
 *     sanctioned tools, ad-hoc sub-issue / thread-reply / Copilot-request writes, raw PR/issue body
 *     writes, `git stash`) and the coordinator verify boundary.
 *
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null} params.role - Calling agent (`agent_type` / Pi `active_agent` role); null
 *   for the main agent / operator, any other string for a subagent context.
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
 *   `ruleId` is null for the two inline denies that carry no registered rule ID and for the
 *   missing-facts deny.
 */
export function decideBashGateDeny(facts = {}) {
  const { command } = facts;
  if (typeof command !== "string") {
    return null;
  }
  const missing = ADAPTER_FACTS.filter(([name, isValid]) => !isValid(facts[name])).map(([name]) => name);
  if (missing.length > 0) {
    return {
      ruleId: null,
      reason:
        `Bash gate blocked: the caller supplied no valid ${missing.join(", ")} fact(s), so the shared deny ` +
        "decision cannot run. Inject every adapter fact (`role`, `repoSlug`, `managedRepoSlug`, " +
        "`inManagedContext`, `humanMergeOnly`, `enforceCoordinator`) instead of omitting one; `readyGate` " +
        "stays explicitly nullable for its 'not probed' value.",
    };
  }
  const { role, repoSlug, managedRepoSlug, inManagedContext, humanMergeOnly, enforceCoordinator, readyGate = null } = facts;
  const gatePassed = readyGate?.passed === true;
  const gateError = readyGate?.error ?? null;

  // COORDINATOR-VERIFY-BOUNDARY: a known code-verification/build entrypoint (bun run
  // verify/test, vitest, npm test/run test/run build, ...) run inline by the dev-loop COORDINATOR
  // itself (agent_type "dev-loop" or "gate-coordinator"). The hook allows WORKER subagents to run targeted checks;
  // full-repository runs still belong to gate resolve-validation. Only the coordinator is scoped
  // out here, mirroring `decideCoordinatorWriteGuard`'s
  // agent_type discriminator. Opt-in via the same `DEVLOOPS_COORDINATOR_READONLY=1` flag as the
  // write-guard boundary; default fail-open. Not scoped to `inManagedRepo` — this is a local
  // command-invocation boundary (which binary ran), not a GitHub-repo-targeting one.
  if (enforceCoordinator && COORDINATOR_AGENT_TYPES.has(normalizeAgentType(role)) && commandContainsCodeVerificationEntrypoint(command)) {
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
        "reply-resolve-review-threads.mjs (multiple threads, --message-map), not raw gh api/graphql.",
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
  const allSegmentsProvenForeign = segmentsProvenForeign(
    [
      ...(isMerge ? extractRepoFlagsFromGhPrMergeSegments(command) : []),
      ...(isReady ? extractRepoFlagsFromGhPrReadySegments(command) : []),
    ],
    managedSlug,
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
