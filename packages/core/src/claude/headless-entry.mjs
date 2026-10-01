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

import fs from "node:fs";
import path from "node:path";

import { resolveRoleExtraTools, EXTRA_TOOLS_ROLES } from "../config/config.mjs";
import { runContextEnv } from "../loop/run-context.mjs";
import { splitFrontmatter, transformAgent } from "./asset-generation.mjs";

/** Default Claude CLI binary name. */
export const DEFAULT_CLAUDE_BIN = "claude";

/**
 * Render the session-scoped `claude --agents` overrides for roles with `extraTools`.
 * Each override is the shipped role (via `transformAgent`) with the configured entries
 * appended, deduplicated, after the mapped built-in tools. Roles without entries are absent.
 *
 * @param {object} config - Loaded dev-loops config.
 * @param {string} repoRoot - Root that holds `agents/<role>.agent.md`.
 * @returns {Record<string, { description: string, prompt: string, tools: string[], model?: string }>}
 */
export function buildAgentOverrides(config, repoRoot) {
  const overrides = {};
  for (const role of EXTRA_TOOLS_ROLES) {
    const extra = resolveRoleExtraTools(config, role);
    if (extra.length === 0) continue;
    const source = `agents/${role}.agent.md`;
    const raw = fs.readFileSync(path.join(repoRoot, source), "utf8");
    const { frontmatter, body } = splitFrontmatter(transformAgent({ source, raw, config }), source);
    const builtIn = String(frontmatter.tools ?? "").split(/[\s,]+/).filter(Boolean);
    overrides[role] = {
      description: String(frontmatter.description ?? ""),
      prompt: body.trim(),
      tools: [...new Set([...builtIn, ...extra])],
      ...(frontmatter.model ? { model: String(frontmatter.model) } : {}),
    };
  }
  return overrides;
}

/**
 * Claude args and env that deliver `extraTools`; empty when no role has entries.
 * `--allowedTools` is one comma-joined value so a following positional is never swallowed.
 *
 * @param {object} config
 * @param {string} repoRoot
 * @returns {{ args: string[], env: Record<string,string> }}
 */
export function buildExtraToolsLaunch(config, repoRoot) {
  const overrides = buildAgentOverrides(config, repoRoot);
  const roles = Object.keys(overrides);
  if (roles.length === 0) return { args: [], env: {} };
  const entries = [...new Set(roles.flatMap((role) => overrides[role].tools.filter((tool) => tool.startsWith("mcp__"))))];
  return {
    args: ["--agents", JSON.stringify(overrides), "--allowedTools", entries.join(",")],
    env: { DEVLOOPS_AGENT_OVERRIDES: roles.join(",") },
  };
}

/**
 * Build the headless dev-loop prompt for a target.
 *
 * @param {Object} [params]
 * @param {number|string} [params.issue]
 * @param {number|string} [params.pr]
 * @returns {string}
 */
export function buildDevLoopPrompt({ issue, pr } = {}) {
  if (issue != null && `${issue}`.trim() && pr != null && `${pr}`.trim()) {
    throw new TypeError("buildDevLoopPrompt: provide at most one target (issue or pr), not both");
  }
  if (issue != null && `${issue}`.trim()) {
    return `Run the dev-loop for issue #${issue}. Use the /dev-loop skill; routing resolves the rest.`;
  }
  if (pr != null && `${pr}`.trim()) {
    return `Run the dev-loop for PR #${pr}. Use the /dev-loop skill; routing resolves the rest.`;
  }
  return "Run the dev-loop. Use the /dev-loop skill; routing resolves the current state.";
}

// A stale value inherited from a parent session must not outlive a launch that renders no roles.
function withoutAgentOverrides(baseEnv) {
  const { DEVLOOPS_AGENT_OVERRIDES: _stale, ...rest } = baseEnv;
  return rest;
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
 * @param {{ config: object, repoRoot: string }} [params.extraTools] - When set, adds the `extraTools` --agents/--allowedTools args and env.
 * @returns {{ command: string, args: string[], env: Record<string,string|undefined> }}
 */
export function buildHeadlessClaudeInvocation({ prompt, runId, claudeBin = DEFAULT_CLAUDE_BIN, extraArgs = [], baseEnv = process.env, extraTools }) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError("buildHeadlessClaudeInvocation: prompt must be a non-empty string");
  }
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new TypeError("buildHeadlessClaudeInvocation: runId must be a non-empty string");
  }
  if (typeof claudeBin !== "string" || claudeBin.trim().length === 0) {
    throw new TypeError("buildHeadlessClaudeInvocation: claudeBin must be a non-empty string");
  }
  if (!Array.isArray(extraArgs)) {
    throw new TypeError("buildHeadlessClaudeInvocation: extraArgs must be an array");
  }
  const launch = extraTools ? buildExtraToolsLaunch(extraTools.config, extraTools.repoRoot) : { args: [], env: {} };
  return {
    command: claudeBin,
    args: ["-p", prompt, ...launch.args, ...extraArgs],
    env: { ...withoutAgentOverrides(baseEnv), ...runContextEnv(runId), ...launch.env },
  };
}

/**
 * Build the interactive `claude` invocation for `dev-loops loop claude-launch`.
 * With no `extraTools` entry the argv is the passthrough args only and no env is added.
 *
 * @param {Object} params
 * @param {object} params.config
 * @param {string} params.repoRoot - Root that holds `agents/<role>.agent.md`.
 * @param {string[]} [params.passthroughArgs]
 * @param {string} [params.claudeBin]
 * @param {Record<string,string|undefined>} [params.baseEnv]
 * @returns {{ command: string, args: string[], env: Record<string,string|undefined> }}
 */
export function buildClaudeLaunch({ config, repoRoot, passthroughArgs = [], claudeBin = DEFAULT_CLAUDE_BIN, baseEnv = process.env }) {
  const launch = buildExtraToolsLaunch(config, repoRoot);
  return { command: claudeBin, args: [...launch.args, ...passthroughArgs], env: { ...withoutAgentOverrides(baseEnv), ...launch.env } };
}
