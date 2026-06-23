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
  isGhPrReadyCommand,
  extractPrNumberFromGhPrReady,
  extractRepoFlagFromGhPrReady,
  TARGET_REPO_SLUG,
} from "../loop/bash-command-classify.mjs";

/**
 * @typedef {Object} HookDecision
 * @property {"allow"|"deny"} decision
 * @property {string} [reason] - Human-readable reason (shown to Claude on deny).
 */

const ALLOW = Object.freeze({ decision: "allow" });

/**
 * Decide whether a PreToolUse Bash command must be blocked by the draft-gate boundary.
 *
 * Mirrors the Pi extension's `onUserBash`: the only blocked case is `gh pr ready` for the
 * target repo without clean draft_gate evidence. Everything else (including merges, which
 * trigger the post-merge step, not a block) is allowed through.
 *
 * @param {Object} params
 * @param {string} params.command - The Bash command string.
 * @param {string|null} [params.repoSlug] - Resolved owner/name of the cwd repo (null if unknown).
 * @param {boolean} [params.gatePassed] - Whether `pre-pr-ready-gate` evidence exists for the PR.
 * @param {string|null} [params.gateError] - Error detail when the gate guard could not run.
 * @returns {HookDecision}
 */
export function decideBashGate({ command, repoSlug = null, gatePassed = false, gateError = null }) {
  if (typeof command !== "string" || !isGhPrReadyCommand(command)) {
    return ALLOW;
  }

  // An explicit `--repo other/repo` that is not the target → not our concern, pass through.
  const explicitRepo = extractRepoFlagFromGhPrReady(command);
  if (explicitRepo && explicitRepo.toLowerCase() !== TARGET_REPO_SLUG.toLowerCase()) {
    return ALLOW;
  }
  // Only gate within the target repo.
  if (repoSlug !== TARGET_REPO_SLUG) {
    return ALLOW;
  }

  const prNumber = extractPrNumberFromGhPrReady(command);
  if (prNumber === null) {
    return {
      decision: "deny",
      reason:
        "gh pr ready blocked: could not determine the PR number from the command. Include the PR number explicitly.",
    };
  }

  if (gateError) {
    return {
      decision: "deny",
      reason: `gh pr ready blocked: draft-gate evidence check failed (${gateError}).`,
    };
  }

  if (!gatePassed) {
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
 * call originates from the MAIN agent (no dev-loop run id and no subagent id). Allows it inside
 * the dev-loop subagent context (CA2 run id present, or a Claude `agent_id` present), and for
 * non-repo / gitignored paths. Strict enforcement is opt-in via `enforce` (the hook derives
 * this from `DEVLOOPS_MAIN_AGENT_READONLY=1`) so adopting the harness does not retroactively
 * break a repo's own interactive dev; default is fail-open.
 *
 * @param {Object} params
 * @param {string} params.filePath - Target file path.
 * @param {boolean} params.isRepoMutation - True if inside the repo working tree AND not gitignored.
 * @param {boolean} [params.enforce] - Strict mode (DEVLOOPS_MAIN_AGENT_READONLY=1).
 * @param {Record<string,string|undefined>} [params.env] - Environment (for the CA2 run id).
 * @param {string|null} [params.agentId] - Claude subagent id from the hook payload, if any.
 * @returns {HookDecision}
 */
export function decideWriteGuard({ filePath, isRepoMutation, enforce = false, env = {}, agentId = null }) {
  if (!enforce) {
    return ALLOW; // strict enforcement not enabled — fail open
  }
  if (!isRepoMutation) {
    return ALLOW; // non-repo or gitignored path (e.g. /tmp, tmp/) — allowed by the contract
  }
  // Delegated (dev-loop subagent) context: CA2 run id or a Claude subagent id present.
  if (resolveRunId(env) || (typeof agentId === "string" && agentId.trim().length > 0)) {
    return ALLOW;
  }
  return {
    decision: "deny",
    reason:
      `Main-agent read-only boundary: refusing to mutate repo-tracked path "${filePath}". ` +
      "All repository mutations must flow through the dev-loop subagent. " +
      "See main-agent-contract.md.",
  };
}
