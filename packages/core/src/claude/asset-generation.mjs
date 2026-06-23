/**
 * Generate Claude Code assets (.claude/agents/*.md, .claude/skills/<name>/SKILL.md) from the
 * canonical Pi sources (agents/*.agent.md, skills/**\/SKILL.md), which remain the single
 * source of truth. These are pure transforms (no file IO) so they are deterministic and
 * unit-testable; the orchestration/IO lives in scripts/claude/generate-claude-assets.mjs.
 *
 * Pi→Claude tool-name mapping (confirmed against Claude Code docs):
 *   read→Read, search→Grep+Glob, execute→Bash, bash→Bash, edit→Edit, write→Write,
 *   agent→Agent, subagent→Agent, todo→TodoWrite, review_loop→Agent (the review subagent).
 * `subagent`/`review_loop` appear only in frontmatter (never invoked by name in bodies),
 * so no body rewriting is required.
 *
 * Frontmatter handling:
 * - Agents keep name/description/tools (comma-separated, per Claude's agent format) and drop
 *   Pi-only fields that have no faithful Claude agent equivalent: argument-hint,
 *   systemPromptMode, inheritProjectContext, inheritSkills, maxSubagentDepth, user-invocable.
 *   (Subagents are never user-invocable in Claude; maxSubagentDepth/inherit* are Pi
 *   async-dispatch concerns. The user entrypoint under Claude is the dev-loop *skill*.)
 * - Skills keep name/description/allowed-tools (space-separated) and preserve `user-invocable`
 *   (Claude honors it 1:1 — `user-invocable: false` hides the skill from the `/` menu). The
 *   Pi-specific `compatibility` text is dropped (no Claude field).
 */

import { parse as parseYaml } from "yaml";

/** Pi→Claude tool-name map. A Pi name may expand to multiple Claude tools (search→Grep,Glob). */
export const TOOL_NAME_MAP = Object.freeze({
  read: ["Read"],
  search: ["Grep", "Glob"],
  execute: ["Bash"],
  bash: ["Bash"],
  edit: ["Edit"],
  write: ["Write"],
  agent: ["Agent"],
  subagent: ["Agent"],
  todo: ["TodoWrite"],
  review_loop: ["Agent"],
});

const GENERATED_NOTE = (source) =>
  `<!-- GENERATED from ${source} by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->`;

/**
 * Map a single Pi tool name to its Claude tool name(s).
 * @param {string} name
 * @returns {string[]} Claude tool names (empty if unknown).
 */
export function mapTool(name) {
  return TOOL_NAME_MAP[String(name).trim()] ?? [];
}

/**
 * Map a list of Pi tool names to deduped Claude tool names, preserving first-seen order.
 * @param {string[]} tools
 * @returns {string[]}
 */
export function mapTools(tools) {
  const out = [];
  for (const tool of tools ?? []) {
    for (const mapped of mapTool(tool)) {
      if (!out.includes(mapped)) {
        out.push(mapped);
      }
    }
  }
  return out;
}

/**
 * Split a source markdown file into its parsed frontmatter and verbatim body.
 * @param {string} raw
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
export function splitFrontmatter(raw, source) {
  const where = source ? ` (${source})` : "";
  const match = String(raw).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`source file is missing a leading YAML frontmatter block${where}`);
  }
  let frontmatter;
  try {
    frontmatter = parseYaml(match[1]) ?? {};
  } catch (error) {
    throw new Error(`failed to parse YAML frontmatter${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { frontmatter, body: match[2] };
}

/** Normalize a Pi `tools` value (YAML list) into a string[] of names. */
function normalizeToolList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Transform a canonical `agents/*.agent.md` into a Claude `.claude/agents/*.md` document.
 * @param {{ source: string, raw: string }} input
 * @returns {string} Full generated file content.
 */
export function transformAgent({ source, raw }) {
  const { frontmatter, body } = splitFrontmatter(raw, source);
  const tools = mapTools(normalizeToolList(frontmatter.tools));

  const lines = ["---"];
  lines.push(`name: ${JSON.stringify(String(frontmatter.name ?? ""))}`);
  if (frontmatter.description != null) {
    lines.push(`description: ${JSON.stringify(String(frontmatter.description))}`);
  }
  if (tools.length > 0) {
    lines.push(`tools: ${tools.join(", ")}`);
  }
  lines.push("---");
  lines.push(GENERATED_NOTE(source));
  lines.push("");
  return `${lines.join("\n")}\n${body}`;
}

/**
 * Transform a canonical `skills/<name>/SKILL.md` into a Claude `.claude/skills/<name>/SKILL.md`.
 * @param {{ source: string, raw: string }} input
 * @returns {string} Full generated file content.
 */
export function transformSkill({ source, raw }) {
  const { frontmatter, body } = splitFrontmatter(raw, source);
  const tools = mapTools(normalizeToolList(frontmatter["allowed-tools"]));

  const lines = ["---"];
  lines.push(`name: ${JSON.stringify(String(frontmatter.name ?? ""))}`);
  if (frontmatter.description != null) {
    lines.push(`description: ${JSON.stringify(String(frontmatter.description))}`);
  }
  if (tools.length > 0) {
    lines.push(`allowed-tools: ${tools.join(" ")}`);
  }
  // user-invocable maps 1:1 — Claude honors `user-invocable: false` (hides from the / menu).
  if (typeof frontmatter["user-invocable"] === "boolean") {
    lines.push(`user-invocable: ${frontmatter["user-invocable"]}`);
  }
  lines.push("---");
  lines.push(GENERATED_NOTE(source));
  lines.push("");
  return `${lines.join("\n")}\n${body}`;
}
