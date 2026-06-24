/**
 * Headless dev-loop entry helpers for Claude Code (#775).
 *
 * Builds a non-interactive `claude -p` invocation that runs the dev-loop, with the CA2 run id
 * propagated into the spawned process's environment via `runContextEnv`. That propagation is
 * what lets the #773 PreToolUse write-guard recognize the headless session as the dev-loop
 * subagent context (completing the CA2→CA4 wiring for the headless path). The repo's
 * `.claude/settings.json` hooks apply automatically to the spawned session.
 *
 * Pure: builds the command/args/env; the actual spawn lives in the entry script
 * (scripts/claude/headless-dev-loop.mjs), which is the only part that needs `claude` on PATH.
 */

import { runContextEnv } from "../loop/run-context.mjs";

/** Default Claude CLI binary name. */
export const DEFAULT_CLAUDE_BIN = "claude";

/**
 * Build the headless dev-loop prompt for a target.
 *
 * @param {Object} [params]
 * @param {number|string} [params.issue]
 * @param {number|string} [params.pr]
 * @returns {string}
 */
export function buildDevLoopPrompt({ issue, pr } = {}) {
  if (issue != null && `${issue}`.trim()) {
    return `Run the dev-loop for issue #${issue}. Use the /dev-loop skill; routing resolves the rest.`;
  }
  if (pr != null && `${pr}`.trim()) {
    return `Run the dev-loop for PR #${pr}. Use the /dev-loop skill; routing resolves the rest.`;
  }
  return "Run the dev-loop. Use the /dev-loop skill; routing resolves the current state.";
}

/**
 * Build a non-interactive `claude -p` invocation for the dev-loop.
 *
 * @param {Object} params
 * @param {string} params.prompt - The headless prompt (see buildDevLoopPrompt).
 * @param {string} params.runId - The dev-loop run id to propagate (see ensureRunId).
 * @param {string} [params.claudeBin] - Claude CLI binary (default "claude").
 * @param {string[]} [params.extraArgs] - Extra args appended after `-p <prompt>`.
 * @param {Record<string,string|undefined>} [params.baseEnv] - Base env (default process.env).
 * @returns {{ command: string, args: string[], env: Record<string,string|undefined> }}
 */
export function buildHeadlessClaudeInvocation({ prompt, runId, claudeBin = DEFAULT_CLAUDE_BIN, extraArgs = [], baseEnv = process.env }) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("buildHeadlessClaudeInvocation: prompt must be a non-empty string");
  }
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new TypeError("buildHeadlessClaudeInvocation: runId must be a non-empty string");
  }
  return {
    command: claudeBin,
    args: ["-p", prompt, ...extraArgs],
    env: { ...baseEnv, ...runContextEnv(runId) },
  };
}
