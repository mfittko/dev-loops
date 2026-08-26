// GENERATED from packages/core/src/claude/hook-decisions.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Pure decision logic for the Claude Code dev-loop hooks (#773).
 *
 * The hook *scripts* are thin: they read the PreToolUse/PostToolUse stdin payload, gather facts
 * (git tracked/ignored status, gate-evidence result), and call these pure deciders. Keeping the
 * decisions here makes the deny/allow boundary fully unit-testable without spawning hooks, and
 * keeps the Claude-specific stdin/stdout IO at the edge.
 *
 * Pure and side-effect free.
 */

import { resolveRunId } from "./_run-context.mjs";
import { isUnderWorktreePath } from "./_worktree-guard.mjs";
import {
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  extractPrNumberFromGhPrReadyAnywhere,
  extractRepoFlagFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  extractRepoFlagFromGhPrMergeAnywhere,
  extractRepoFlagsFromGhPrCreateSegments,
  commandContainsRawExternalWrite,
  extractRepoFlagsFromExternalWriteSegments,
  commandContainsGitStash,
  extractGhApiEndpointSegments,
  commandContainsSubIssueAdHocBypass,
  commandContainsReplyResolveBypass,
  commandContainsGraphqlResolveReviewThread,
  commandContainsCopilotRequestBypass,
  commandContainsCopilotSummonComment,
  commandContainsDetachedWaitTool,
  commandContainsInlineInterpreter,
  TARGET_REPO_SLUG,
} from "./_bash-command-classify.mjs";

/**
 * @typedef {Object} HookDecision
 * @property {"allow"|"deny"|"block"} decision — `block` is the SubagentStop vocabulary
 *   (exit 2 + stderr JSON), used by `decideSubagentStopGuard`; `allow`/`deny` are the PreToolUse
 *   vocabulary used by `decideBashGate`/`decideWriteGuard`.
 * @property {string} [reason] - Human-readable reason (shown to the agent on deny/block).
 */

const ALLOW = Object.freeze({ decision: "allow" });

/**
 * Whether the command string also invokes an evidence-writing script (findings-log ledger or
 * checkpoint-verdict upsert). Used only to enrich the merge-block message (#1172) — a compound
 * command combining an evidence write with `gh pr merge` is blocked pre-execution, so the write
 * never runs; this substring check has no false-negative cost (worst case: the plain message).
 */
function commandContainsEvidenceWrite(command) {
  return command.includes("write-gate-findings-log") || command.includes("upsert-checkpoint-verdict");
}

/**
 * The agent type (Claude `agent_type` / the canonical agent name) that owns repo mutations.
 * Only this subagent — not arbitrary subagents (Explore, Plan, generic Task agents) — may
 * bypass the main-agent read-only boundary.
 */
export const DEV_LOOP_AGENT_TYPE = "dev-loop";

/**
 * Decide whether a PreToolUse Bash command must be blocked by a dev-loop gate boundary.
 *
 * Three gated commands on the target repo:
 *   - `gh pr create` — blocked outright; PR creation must flow through the canonical wrapper
 *     (`scripts/github/create-pr.mjs` / `dev-loops pr create`), which always drafts and
 *     self-assigns. Closes the hole where raw `gh pr create` opens a ready PR, bypassing draft-first.
 *   - `gh pr ready` — blocked without clean draft_gate evidence (`pre-pr-ready-gate`).
 *   - `gh pr merge` — blocked without the full pre-merge gate evidence (`detect-checkpoint-evidence`:
 *     clean current-head draft_gate + pre_approval_gate). The loop runs this check before merging;
 *     gating it here closes the hole where a hand-run `gh pr merge` skips the pre-approval gate
 *     entirely. Everything else passes through.
 *   - raw `gh issue create` / `gh issue comment` / `gh issue edit` / `gh pr comment` — blocked ONLY when the call
 *     originates from a SUBAGENT context (`agentType` is a non-null string) and targets the repo.
 *     Sanctioned external writes flow through node wrappers (gate-verdict comments via
 *     `upsert-checkpoint-verdict.mjs`, review replies via `reply-resolve*.mjs`, board sync,
 *     `comment-issue.mjs`), whose Bash command string is `node scripts/…` and never matches these
 *     raw-`gh` matchers. The MAIN AGENT / operator (agentType null) retains direct `gh issue
 *     create` — that path is authorized (#1051).
 *
 * The hook computes `gatePassed`/`gateError` from the gate script appropriate to the command kind.
 *
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null} [params.repoSlug] - Resolved owner/name of the cwd repo (null if unknown).
 * @param {boolean} [params.gatePassed] - Whether the relevant gate evidence exists for the PR.
 * @param {string|null} [params.gateError] - Error detail when the gate guard could not run.
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload; non-null
 *   string inside a subagent, null in the main agent. Scopes the subagent-only predicates.
 * @param {boolean} [params.humanMergeOnly] - Effective repo `autonomy.humanMergeOnly` invariant
 *   (`resolveHumanMergeOnly`); when true, `gh pr merge` is refused actor-independently
 *   (STOP-HUMAN-MERGE-001), because the main agent is the actor that performs GitHub writes and a
 *   subagent-only deny would enforce nothing.
 * @returns {HookDecision}
 */
export function decideBashGate({ command, repoSlug = null, gatePassed = false, gateError = null, agentType = null, humanMergeOnly = false }) {
  if (typeof command !== "string") {
    return ALLOW;
  }
  // Normalize (trim + case-fold) so a divergent slug (surrounding whitespace, casing) does not
  // silently fail OPEN and disable every guard that depends on inTargetRepo (#1622).
  const inTargetRepo = (repoSlug ?? "").trim().toLowerCase() === TARGET_REPO_SLUG.trim().toLowerCase();

  // OPS-NO-INLINE-INTERPRETER (#1622): inline interpreters (`node -e`/`--eval`/`-p`, `python3 -c`,
  // heredocs fed to node/python) are barred actor-independently on the target repo — the rule bars
  // "Coordinator and agent flows"; sanctioned output parsing uses `--jq`/`--silent`, never an
  // inline interpreter.
  if (inTargetRepo && commandContainsInlineInterpreter(command)) {
    return {
      decision: "deny",
      reason:
        "OPS-NO-INLINE-INTERPRETER: inline interpreters (node -e/--eval/-p, python3 -c, heredoc to " +
        "node/python) are barred in the dev-loop flow. Parse tool output via --jq/--silent and mutate " +
        "files via the editor/patch tools or a --jq-composed --body-file, never an inline interpreter.",
    };
  }

  // SUBISSUE-NO-ADHOC-BYPASS (#1622): ad-hoc `gh api` writes to the target repo's sub-issue endpoints.
  // Actor-independent (no reserved direct path). Gated on the target repo: the absolute slug-embedded
  // form identifies the target repo; the bare relative form (`gh api issues/5/sub_issues`) resolves
  // against the cwd repo, so it is in scope only when running in the target repo (mirrors the #1047
  // explicit-`--repo`/cwd-target posture).
  if (inTargetRepo && commandContainsSubIssueAdHocBypass(command)) {
    return {
      decision: "deny",
      reason:
        "SUBISSUE-NO-ADHOC-BYPASS: ad-hoc `gh api` writes to the target repo's sub_issues endpoint are " +
        "blocked. Manage sub-issues via the sanctioned manage-sub-issues wrapper instead.",
    };
  }

  // COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER (#1622): ad-hoc thread-resolution writes — raw `gh api` POST
  // to pulls/<n>/comments/<m>/replies, or a `gh api graphql` resolveReviewThread mutation (the Rest
  // path names the target repo; the graphql form has no path-host repo, so it is scoped to the cwd
  // repo). Actor-independent: reply through reply-resolve-review-thread(s).mjs.
  if (inTargetRepo && (commandContainsReplyResolveBypass(command) || commandContainsGraphqlResolveReviewThread(command))) {
    return {
      decision: "deny",
      reason:
        "COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER: ad-hoc thread-reply mutations are blocked. Resolve review " +
        "threads via scripts/github/reply-resolve-review-thread.mjs (one thread) or " +
        "reply-resolve-review-threads.mjs (multiple threads, --message-map), not raw gh api/graphql.",
    };
  }

  // COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY (#1622): ad-hoc Copilot review requests — raw `gh api` writes
  // to pulls/<n>/requested_reviewers, or a bare `/copilot` / `/copilot re-review` comment summon on the
  // target repo. Actor-independent: request Copilot via scripts/github/request-copilot-review.mjs.
  if (inTargetRepo && (commandContainsCopilotRequestBypass(command) || commandContainsCopilotSummonComment(command))) {
    return {
      decision: "deny",
      reason:
        "COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY: ad-hoc Copilot review requests are blocked. Request Copilot " +
        "via scripts/github/request-copilot-review.mjs — do not write requested_reviewers or post a literal " +
        "/copilot comment.",
    };
  }

  // `git stash` writes to `refs/stash`, one ref shared by every worktree over this repo's single
  // `.git` directory — a stash from one worktree can pop into another's. Block it outright on the
  // target repo; see skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout for the
  // stash-free alternative (git diff / a patch file / a scratch checkout).
  if (commandContainsGitStash(command) && inTargetRepo) {
    return {
      decision: "deny",
      reason:
        "git stash blocked: refs/stash is shared across every worktree over this repo's one .git directory, " +
        "so a stash can pop into a different worktree. Use `git diff` (or `git diff --staged`), save changes " +
        "to a patch file, or use a separate scratch worktree instead of stashing.",
    };
  }
  // Subagent-scoped external-write guard: block ad-hoc `gh issue create`/`gh issue comment`/
  // `gh issue edit`/`gh pr comment` on the target repo from a subagent, so external writes flow through the
  // sanctioned node wrappers. The main-agent/operator path (agentType null) is unaffected (#1051).
  if (typeof agentType === "string" && commandContainsRawExternalWrite(command)) {
    const cwdTargets = (repoSlug ?? "").toLowerCase() === TARGET_REPO_SLUG.toLowerCase();
    // Scope PER segment, mirroring the `gh pr create` block: in scope when no explicit --repo and
    // cwd is the target, or an explicit --repo/-R equals the target. An explicit non-target --repo
    // passes through. DENY if ANY external-write segment is in scope.
    const anyWriteInScope = extractRepoFlagsFromExternalWriteSegments(command).some((seg) =>
      seg.explicitRepo == null
        ? cwdTargets
        : seg.explicitRepo.toLowerCase() === TARGET_REPO_SLUG.toLowerCase(),
    );
    if (anyWriteInScope) {
      return {
        decision: "deny",
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

  // STOP-HUMAN-MERGE-001 (#1622): when the repo resolves `autonomy.humanMergeOnly`, `gh pr merge` is
  // refused actor-independently — the main agent is the actor that performs GitHub writes, so only an
  // actor-independent deny enforces the human-merge invariant (an agent-scoped deny would enforce
  // nothing on the main-agent write path).
  if (humanMergeOnly && isMerge && inTargetRepo) {
    return {
      decision: "deny",
      reason:
        "STOP-HUMAN-MERGE-001: this repo resolves autonomy.humanMergeOnly — the loop must stop at merge " +
        "for a human action; the agent MUST NOT run `gh pr merge`. Leave the PR merge-ready and a human " +
        "merges it.",
    };
  }

  if (!isReady && !isMerge && !isCreate) {
    // COPILOT-FOLLOWUP-WAIT-TOOLS (#1622): banned detached/polling wait wrappers. Subagent-only — the
    // rule is classified `agent` (behavioral guidance for the dev-loop driving agent); the main
    // agent/operator retains manual wait tooling. The main agent's own sanctioned wait path is still
    // the deterministic tools.
    if (typeof agentType === "string" && inTargetRepo && commandContainsDetachedWaitTool(command)) {
      return {
        decision: "deny",
        reason:
          "COPILOT-FOLLOWUP-WAIT-TOOLS: wait only through deterministic tools (scripts/loop/detect-copilot-" +
          "loop-state.mjs one-shot, dev-loops loop watch-cycle persistent, scripts/github/wait-pr-checks.mjs, " +
          "gh run watch) — nohup/disown/tmux/screen detach and while-sleep-poll loops are barred for the " +
          "dev-loop driving agent.",
      };
    }
    return ALLOW;
  }

  // Raw `gh pr create` is blocked outright on the target repo (no PR number / gate evidence
  // exists yet): PR creation must flow through the canonical wrapper, which always drafts and
  // self-assigns. This closes the draft-first hole where raw `gh pr create` opens a ready PR.
  if (isCreate) {
    const cwdTargets = (repoSlug ?? "").toLowerCase() === TARGET_REPO_SLUG.toLowerCase();
    // Evaluate scope PER create segment, not just the first: a create is in scope when it
    // explicitly targets the repo, or (with no explicit --repo) the cwd is the repo. An explicit
    // `--repo <target>` is denied regardless of cwd (#1047). DENY if ANY create segment is in
    // scope — otherwise a leading out-of-scope create (`gh pr create --repo other/repo`) would
    // short-circuit and shield a later in-scope raw create (`&& gh pr create --fill`).
    const anyCreateInScope = extractRepoFlagsFromGhPrCreateSegments(command).some((seg) =>
      seg.explicitRepo == null
        ? cwdTargets
        : seg.explicitRepo.toLowerCase() === TARGET_REPO_SLUG.toLowerCase(),
    );
    if (anyCreateInScope) {
      return {
        decision: "deny",
        reason:
          "gh pr create blocked: open PRs via the canonical wrapper `node scripts/github/create-pr.mjs` " +
          "(a.k.a. `dev-loops pr create`), which always creates a draft and self-assigns. Raw `gh pr create` " +
          "defaults to ready-for-review and bypasses the draft-first contract (workflow.requireDraftFirst).",
      };
    }
    // The create is out of scope. Only allow outright when there is no ready/merge segment to
    // evaluate — otherwise fall through so a gated `gh pr ready`/`gh pr merge` in the same
    // compound command (e.g. `gh pr create --repo other/repo && gh pr merge 5`) is still gated
    // below rather than short-circuited.
    if (!isReady && !isMerge) {
      return ALLOW;
    }
  }
  // When both verbs appear in a compound command, apply the stricter merge gate — if it passes,
  // the draft_gate (a subset of the pre-merge evidence check) is also satisfied.
  const verb = isMerge ? "gh pr merge" : "gh pr ready";
  // An explicit `--repo other/repo` that is not the target → not our concern, pass through.
  const explicitRepo = isMerge
    ? extractRepoFlagFromGhPrMergeAnywhere(command)
    : extractRepoFlagFromGhPrReadyAnywhere(command);
  if (explicitRepo && explicitRepo.toLowerCase() !== TARGET_REPO_SLUG.toLowerCase()) {
    return ALLOW;
  }
  // Only gate within the target repo (case-insensitive — callers may pass an un-lowercased slug).
  if ((repoSlug ?? "").toLowerCase() !== TARGET_REPO_SLUG.toLowerCase()) {
    return ALLOW;
  }

  const prNumber = isMerge
    ? extractPrNumberFromGhPrMergeAnywhere(command)
    : extractPrNumberFromGhPrReadyAnywhere(command);
  if (prNumber === null) {
    return {
      decision: "deny",
      reason: `${verb} blocked: could not determine the PR number from the command. Include the PR number explicitly.`,
    };
  }

  if (gateError) {
    const which = isMerge ? "pre-merge gate" : "draft-gate";
    return {
      decision: "deny",
      reason: `${verb} blocked: ${which} evidence check failed (${gateError}).`,
    };
  }

  if (!gatePassed) {
    if (isMerge) {
      // This hook evaluates PreToolUse — BEFORE the Bash tool call runs. A compound command that
      // writes gate evidence (findings-log ledger, checkpoint verdict) and merges in the same call
      // is blocked here with the write never having executed, which looks like the evidence
      // "vanished" (#1172). Hint the split when the command carries an evidence-writing invocation
      // alongside the merge, so the failure is self-explaining instead of looking like data loss.
      const alsoWritesEvidence = commandContainsEvidenceWrite(command);
      return {
        decision: "deny",
        reason:
          `gh pr merge blocked: missing pre-merge gate evidence for PR #${prNumber} (need clean current-head draft_gate + pre_approval_gate; inline verdicts are not accepted). Run the dev-loop gates instead of merging directly.` +
          (alsoWritesEvidence
            ? " This command also writes gate evidence, but hooks evaluate before the command runs — write the evidence in a separate call, then merge alone."
            : ""),
      };
    }
    return {
      decision: "deny",
      reason: `gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #${prNumber}.`,
    };
  }

  return ALLOW;
}

/**
 * Decide whether a PreToolUse Write/Edit must be blocked by the main-agent read-only boundary.
 *
 * Denies a mutation whose target is inside the repo working tree AND not gitignored, when the
 * call originates from the MAIN agent. Allows it only inside the *dev-loop* subagent context:
 * the CA2 run id (`DEVLOOPS_RUN_ID`) is present, or the Claude `agent_type` is the dev-loop
 * agent. A generic subagent (Explore, Plan, an arbitrary Task agent) is NOT authorized — the
 * contract requires mutations to flow through the dev-loop subagent specifically. Non-repo /
 * gitignored paths are always allowed. Strict enforcement is opt-in via `enforce` (the hook
 * derives it from `DEVLOOPS_MAIN_AGENT_READONLY=1`) so adopting the harness does not
 * retroactively break a repo's own interactive dev; default is fail-open.
 *
 * @param {Object} params
 * @param {string} params.filePath - Target file path.
 * @param {boolean} params.isRepoMutation - True if inside the repo working tree AND not gitignored.
 * @param {boolean} [params.enforce] - Strict mode (DEVLOOPS_MAIN_AGENT_READONLY=1).
 * @param {Record<string,string|undefined>} [params.env] - Environment (for the CA2 run id).
 * @param {string|null} [params.agentType] - Claude `agent_type` from the hook payload, if any.
 * @returns {HookDecision}
 */
export function decideWriteGuard({ filePath, isRepoMutation, enforce = false, env = {}, agentType = null }) {
  if (!enforce) {
    return ALLOW; // strict enforcement not enabled — fail open
  }
  if (!isRepoMutation) {
    return ALLOW; // non-repo or gitignored path (e.g. /tmp, tmp/) — allowed by the contract
  }
  // Authorized only inside the dev-loop subagent context: CA2 run id, or the dev-loop agent
  // type. Any other subagent type is treated like the main agent and denied.
  if (resolveRunId(env) || agentType === DEV_LOOP_AGENT_TYPE) {
    return ALLOW;
  }
  return {
    decision: "deny",
    reason:
      `Main-agent read-only boundary: refusing to mutate repository path "${filePath}". ` +
      "All repository mutations must flow through the dev-loop subagent. " +
      "See skills/docs/main-agent-contract.md.",
  };
}

/**
 * Env var that exempts an interactive session awaiting commit authorization from the
 * SubagentStop uncommitted-work guard (#1619).
 *
 * An opt-in signal set by the operator or the interactive coordination path
 * (`DEVLOOPS_COMMIT_AUTH_PENDING=1`) when intentionally holding uncommitted work pending
 * operator commit authorization — consistent with the operator-set `DEVLOOPS_*` env vars in
 * this repo (`DEVLOOPS_MAIN_AGENT_READONLY`, `DEVLOOPS_ALLOW_MAIN`, `DEVLOOPS_SUBAGENT_AVAILABLE`),
 * which are environment/operator signals rather than values written by a code path. A
 * non-interactive (dispatched) subagent leaves it unset, so its commit-before-exit obligation
 * stays enforced.
 */
export const DEVLOOPS_COMMIT_AUTH_PENDING_VAR = "DEVLOOPS_COMMIT_AUTH_PENDING";

/**
 * Env var that exempts an orchestrator-owned-commit dispatch from the SubagentStop
 * uncommitted-work guard (#1786).
 *
 * A "LOCAL EDITS ONLY: no commit" dispatch (e.g. the `developer`/`quality`/`docs` delegation
 * pattern in `skills/local-implementation/SKILL.md` "Delegation contract") tells the subagent to
 * make local edits and report changed files, leaving commit + push to the dispatching
 * orchestrator once it consolidates results. Without an exemption, that subagent's own
 * SubagentStop event still sees the dirty worktree it was told not to commit and deadlocks. The
 * dispatcher sets `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT=1` for that dispatch to declare it owns the
 * commit — same opt-in `DEVLOOPS_*` signal shape as `DEVLOOPS_COMMIT_AUTH_PENDING`, but distinct:
 * this one exempts a non-interactive delegated dispatch whose commit responsibility sits with its
 * caller, not an interactive session awaiting operator authorization. Left unset, an ordinary
 * dispatch's commit-before-exit obligation stays enforced (fail closed by default).
 */
export const DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT_VAR = "DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT";

/**
 * Decide whether a SubagentStop must be blocked because the subagent's worktree has
 * uncommitted changes (#1619).
 *
 * `scripts/loop/cleanup-worktree.mjs` runs `git worktree remove --force` after a merge, so
 * uncommitted changes in a worktree are destroyed with no warning. `LOCAL-COMMIT-BEFORE-EXIT`
 * existed only as prose. This decider makes it mechanical: refuse the subagent stop when the
 * cwd is under `tmp/worktrees/` and `git status --porcelain` is non-empty, unless the session
 * is an interactive one awaiting commit authorization, or the dispatch is an explicit
 * orchestrator-owned-commit exemption (#1786) (either exempt). A clean worktree, a cwd
 * outside `tmp/worktrees/`, and a git-error/empty-porcelain case all allow the stop.
 *
 * Pure and side-effect free. The hook script gathers `cwd` and the `git status --porcelain`
 * output and calls this; the block decision is surfaced via exit code 2 + stderr JSON by the
 * hook (the SubagentStop contract differs from PreToolUse's `permissionDecision` form).
 *
 * @param {Object} params
 * @param {string|undefined} params.cwd - Current working directory; a non-string value is
 *   treated as out of scope (allow) — the decider is fail-safe.
 * @param {string|undefined} params.porcelain - Raw `git status --porcelain` output; a non-string
 *   or empty value is treated as clean (allow) — the decider is fail-safe.
 * @param {boolean} [params.pendingCommitAuthorization] - True when the interactive session is
 *   awaiting commit authorization (exempt) — derived by the hook script from the
 *   `DEVLOOPS_COMMIT_AUTH_PENDING=1` opt-in env signal.
 * @param {boolean} [params.orchestratorOwnsCommit] - True when this dispatch is an explicit
 *   orchestrator-owned-commit exemption (exempt) — derived by the hook script from the
 *   `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT=1` opt-in env signal.
 * @returns {HookDecision}
 */
export function decideSubagentStopGuard({ cwd, porcelain, pendingCommitAuthorization = false, orchestratorOwnsCommit = false }) {
  if (typeof cwd !== "string" || !isUnderWorktreePath(cwd)) {
    return ALLOW;
  }
  if (pendingCommitAuthorization || orchestratorOwnsCommit) {
    return ALLOW;
  }
  if (typeof porcelain !== "string" || porcelain.trim() === "") {
    return ALLOW;
  }
  const dirty = porcelain
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // The reason is fed back to the stopping subagent as context, so the path
  // enumeration is capped: an unbounded list on a very dirty worktree produces a
  // multi-megabyte reason that consumers truncate or choke on, burying the one
  // actionable line. The "Dirty paths (N):" header below always carries the full
  // dirty count; the trailing "… and X more" line (when present) carries the
  // remaining count past the cap, not the full total.
  const MAX_LISTED_DIRTY_PATHS = 50;
  const listed = dirty.slice(0, MAX_LISTED_DIRTY_PATHS).map((p) => "  " + p);
  if (dirty.length > MAX_LISTED_DIRTY_PATHS) {
    listed.push(`  … and ${dirty.length - MAX_LISTED_DIRTY_PATHS} more (run \`git status --porcelain\` for the full list)`);
  }
  return {
    decision: "block",
    reason:
      "LOCAL-COMMIT-BEFORE-EXIT: the worktree has uncommitted changes — refusing subagent exit " +
      "to prevent silent data loss from post-merge worktree cleanup (cleanup-worktree.mjs runs " +
      "`git worktree remove --force`). Commit your work before stopping. " +
      `Dirty paths (${dirty.length}):\n` +
      listed.join("\n"),
  };
}
