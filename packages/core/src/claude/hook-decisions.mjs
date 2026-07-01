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

import { resolveRunId } from "../loop/run-context.mjs";
import {
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  extractPrNumberFromGhPrReadyAnywhere,
  extractRepoFlagFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  extractRepoFlagFromGhPrMergeAnywhere,
  extractRepoFlagFromGhPrCreateAnywhere,
  TARGET_REPO_SLUG,
} from "../loop/bash-command-classify.mjs";

/**
 * @typedef {Object} HookDecision
 * @property {"allow"|"deny"} decision
 * @property {string} [reason] - Human-readable reason (shown to Claude on deny).
 */

const ALLOW = Object.freeze({ decision: "allow" });

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
 *
 * The hook computes `gatePassed`/`gateError` from the gate script appropriate to the command kind.
 *
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null} [params.repoSlug] - Resolved owner/name of the cwd repo (null if unknown).
 * @param {boolean} [params.gatePassed] - Whether the relevant gate evidence exists for the PR.
 * @param {string|null} [params.gateError] - Error detail when the gate guard could not run.
 * @returns {HookDecision}
 */
export function decideBashGate({ command, repoSlug = null, gatePassed = false, gateError = null }) {
  if (typeof command !== "string") {
    return ALLOW;
  }
  // Scan ALL shell segments — the PreToolUse gate blocks pre-emptively, so a gated verb in any
  // segment (even after `&&` or `;`) must be caught. This differs from the Pi extension's
  // post-execute `isGhPrReadyCommand`/`isGhPrMergeCommand` which scan only the first segment
  // (correct there: `false && gh pr ready 42` short-circuits so ready never ran).
  const isReady = commandContainsGhPrReady(command);
  const isMerge = commandContainsGhPrMerge(command);
  const isCreate = commandContainsGhPrCreate(command);
  if (!isReady && !isMerge && !isCreate) {
    return ALLOW;
  }

  // Raw `gh pr create` is blocked outright on the target repo (no PR number / gate evidence
  // exists yet): PR creation must flow through the canonical wrapper, which always drafts and
  // self-assigns. This closes the draft-first hole where raw `gh pr create` opens a ready PR.
  if (isCreate) {
    const explicitRepo = extractRepoFlagFromGhPrCreateAnywhere(command);
    const explicitTargets =
      explicitRepo != null && explicitRepo.toLowerCase() === TARGET_REPO_SLUG.toLowerCase();
    const explicitOther = explicitRepo != null && !explicitTargets;
    const cwdTargets = (repoSlug ?? "").toLowerCase() === TARGET_REPO_SLUG.toLowerCase();
    if (explicitOther) {
      return ALLOW; // creating a PR on a different repo — not our concern
    }
    // An explicit `--repo` pointing AT the target must be denied regardless of cwd: raw
    // `gh pr create --repo <target>` from outside the repo still opens a ready PR, bypassing
    // the draft-first wrapper (#1047). Without an explicit target, only gate when cwd is the repo.
    if (!explicitTargets && !cwdTargets) {
      return ALLOW;
    }
    return {
      decision: "deny",
      reason:
        "gh pr create blocked: open PRs via the canonical wrapper `node scripts/github/create-pr.mjs` " +
        "(a.k.a. `dev-loops pr create`), which always creates a draft and self-assigns. Raw `gh pr create` " +
        "defaults to ready-for-review and bypasses the draft-first contract (workflow.requireDraftFirst).",
    };
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
    return {
      decision: "deny",
      reason: isMerge
        ? `gh pr merge blocked: missing pre-merge gate evidence for PR #${prNumber} (need clean current-head draft_gate + pre_approval_gate; inline verdicts are not accepted). Run the dev-loop gates instead of merging directly.`
        : `gh pr ready blocked: no visible clean draft_gate checkpoint verdict comment found for PR #${prNumber}.`,
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
