/**
 * Generate Claude Code assets (.claude/agents/*.md, .claude/skills/<name>/SKILL.md) from the
 * canonical Pi sources (agents/*.agent.md, skills/**\/SKILL.md), which remain the single
 * source of truth. These are pure transforms (no file IO) so they are deterministic and
 * unit-testable; the orchestration/IO lives in scripts/claude/generate-claude-assets.mjs.
 *
 * Pi→Claude tool-name mapping (confirmed against Claude Code docs):
 *   read→Read, search→Grep+Glob, execute→Bash, bash→Bash, edit→Edit, write→Write,
 *   agent→Agent, subagent→Agent, todo→TodoWrite, review_loop→Agent (the review subagent).
 * Frontmatter *tool lists* are rewritten, and bodies are copied through `stripPiOnlyBlocks`
 * (#817): `<!-- pi-only -->`…`<!-- /pi-only -->` sections are removed for the Claude output so
 * Pi-runtime-specific prose (e.g. `tools: [subagent]`/`maxSubagentDepth` assertions, the
 * `contact_supervisor`/`pi-intercom` bug guidance) doesn't contradict the Claude assets. The
 * source stays Pi-complete; general `subagent` prose is preserved (Claude has subagents too).
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
 * Strip Pi-runtime-only prose blocks from a body for the Claude output (#817).
 *
 * The canonical sources stay Pi-complete; sections that are Pi-runtime-specific and misleading
 * under Claude (e.g. `tools: [subagent]`/`maxSubagentDepth` assertions that contradict the
 * mapped Claude frontmatter, or the `contact_supervisor`/`pi-intercom` Pi-bug guidance) are
 * wrapped in the source with `<!-- pi-only -->` … `<!-- /pi-only -->` and removed here. Resulting
 * blank-line runs are collapsed so the stripped body stays clean. `subagent` prose in general is
 * NOT stripped — Claude has subagents too.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripPiOnlyBlocks(body) {
  const s = String(body);
  // True no-op when there are no markers — must NOT touch blank-line runs in marker-free
  // bodies (they may carry intentional spacing; collapsing them would drift the committed tree).
  if (!s.includes("<!-- pi-only -->")) {
    return s;
  }
  // Markers must not nest; pairs are matched non-greedily. After removing the block(s), collapse
  // any run of 3+ newlines in this (marker-bearing) body to a single blank line — this tidies the
  // gaps left by removal; marker-free bodies are returned untouched above, so their intentional
  // blank runs are never affected.
  return s
    .replace(/[ \t]*<!-- pi-only -->[\s\S]*?<!-- \/pi-only -->[ \t]*\n?/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Rewrite the Pi package-local CLI invocation into the Claude version-pinned `npx` form (#801,
 * #833). The Pi runtime sources invoke the CLI as `node <dev-loops-package-root>/cli/index.mjs`
 * (resolves unambiguously from the installed package). The Claude plugin does NOT bundle `cli/`,
 * so for the generated tree those tokens become `npx dev-loops@<version>` — pinning the version
 * keeps the CLI from drifting against the published plugin version (#833). The Pi-only
 * package-root resolution note is removed separately by `stripPiOnlyBlocks`.
 *
 * @param {string} body
 * @param {string} version dev-loops package version to pin (e.g. "0.2.6").
 * @returns {string}
 */
export function rewriteCliInvocation(body, version) {
  return String(body).split("node <dev-loops-package-root>/cli/index.mjs").join(`npx dev-loops@${version}`);
}

/**
 * Rewrite repo-root `../docs/…` *inline* markdown links `](../docs/…)` in a generated *command* or
 * *agent* body so they resolve from the generated file's deeper location. Only the inline `](…)`
 * link form is rewritten (reference-style `[label]: …` and HTML `<a href>` links are left as-is) —
 * command/agent bodies only use inline links, so that is the sole form that occurs. Source
 * commands/agents live at `commands/<name>.command.md` / `agents/<name>.agent.md`, so `../docs/x`
 * resolves to repo-root `docs/x`; the generated wrapper lives one level deeper at
 * `.claude/commands/<name>.md` / `.claude/agents/<name>.md`, where `../docs/x` would wrongly resolve
 * to `.claude/docs/x` (there is no such dir). Repo-root `docs/` is NOT mirrored into `.claude/`, so
 * the link must gain one `../` to reach repo-root: `../docs/x` → `../../docs/x`. Both trees sit one
 * level under `.claude/`, so the same single-level shift applies to each.
 *
 * Scoped to `../docs/` on purpose. Other `../…` links point at subtrees the generator mirrors under
 * `.claude/` (e.g. `../skills/docs/x` → the bundled `.claude/skills/docs/x`), whose relative depth
 * is preserved verbatim — shifting those would break them. Skills need no rewrite at all for the
 * same reason (their `../docs/x` targets the bundled `.claude/skills/docs/x`).
 *
 * @param {string} body
 * @returns {string}
 */
export function rewriteGeneratedRepoDocLinks(body) {
  return String(body).replace(/(\]\(<?)(\.\.\/docs\/)/g, "$1../$2");
}

// Back-compat alias for the pre-generalization name. This module is a public
// `@dev-loops/core/claude/asset-generation` export, so the old export name keeps
// forwarding to avoid breaking any downstream importer.
export const rewriteCommandRepoLinks = rewriteGeneratedRepoDocLinks;

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
 * @param {{ source: string, raw: string, version?: string }} input
 * @returns {string} Full generated file content.
 */
export function transformAgent({ source, raw, version = "latest" }) {
  const { frontmatter, body: rawBody } = splitFrontmatter(raw, source);
  const body = rewriteGeneratedRepoDocLinks(rewriteCliInvocation(stripPiOnlyBlocks(rawBody), version));
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
 * Transform a canonical `commands/<name>.command.md` into a Claude `.claude/commands/<name>.md`
 * slash command (#972). Commands are thin wrappers over the public dev-loop contract: the body
 * is a prompt (with `$ARGUMENTS`) that invokes the existing entrypoint, so there is NO routing
 * logic here. Frontmatter keeps Claude's command fields (`description`, `argument-hint`); the body
 * is passed through `stripPiOnlyBlocks` + `rewriteCliInvocation` like agents/skills.
 * @param {{ source: string, raw: string, version?: string }} input
 * @returns {string} Full generated file content.
 */
export function transformCommand({ source, raw, version = "latest" }) {
  const { frontmatter, body: rawBody } = splitFrontmatter(raw, source);
  const body = rewriteGeneratedRepoDocLinks(rewriteCliInvocation(stripPiOnlyBlocks(rawBody), version));

  const lines = ["---"];
  if (frontmatter.description != null) {
    lines.push(`description: ${JSON.stringify(String(frontmatter.description))}`);
  }
  if (frontmatter["argument-hint"] != null) {
    lines.push(`argument-hint: ${JSON.stringify(String(frontmatter["argument-hint"]))}`);
  }
  lines.push("---");
  lines.push(GENERATED_NOTE(source));
  lines.push("");
  return `${lines.join("\n")}\n${body}`;
}

/**
 * Transform a canonical `skills/<name>/SKILL.md` into a Claude `.claude/skills/<name>/SKILL.md`.
 * @param {{ source: string, raw: string, version?: string }} input
 * @returns {string} Full generated file content.
 */
export function transformSkill({ source, raw, version = "latest" }) {
  const { frontmatter, body: rawBody } = splitFrontmatter(raw, source);
  const body = rewriteCliInvocation(stripPiOnlyBlocks(rawBody), version);
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
