import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGED_AGENTS_ROOT = new URL("../agents/", import.meta.url);

/**
 * Pi tool-name map — mirrors the Claude `TOOL_NAME_MAP`
 * (`packages/core/src/claude/asset-generation.mjs`) but maps the harness-neutral
 * agent tool vocabulary to Pi builtins. Applied at session-start sync time so
 * `~/.agents/*.agent.md` lists only valid Pi builtin tool names (#1583).
 *
 *   read→read, search→bash, execute→bash, bash→bash, edit→edit, write→write,
 *   agent→subagent, subagent→subagent, todo→(drop), review_loop→review_loop
 *
 * `todo` has no Pi builtin (Claude keeps `TodoWrite`); the dev-loop acceptance
 * checklist falls back to prose/bash under Pi — documented in
 * `agents/dev-loop.agent.md`. This is a #1086 cross-harness regression fix: the
 * Pi path had no equivalent map, so Pi rejected `search`/`execute`/`agent`/`todo`
 * as unavailable child tools and ended runs with a `failed` status.
 */
export const TOOL_NAME_MAP_PI: Readonly<Record<string, string | null>> = Object.freeze({
  read: "read",
  search: "bash",
  execute: "bash",
  bash: "bash",
  edit: "edit",
  write: "write",
  agent: "subagent",
  subagent: "subagent",
  todo: null, // dropped — no Pi todo builtin
  review_loop: "review_loop",
});

/** Valid Pi builtin tool names (the mapped value set, minus dropped entries). */
const BUILTIN_TOOL_SET = new Set(
  Object.values(TOOL_NAME_MAP_PI).filter((v): v is string => v != null),
);

/** Map a list of harness-neutral tool names to deduped Pi builtin names (first-seen order). */
export function mapAgentToolsForPi(tools: string[]): string[] {
  const out: string[] = [];
  for (const tool of tools ?? []) {
    const mapped = TOOL_NAME_MAP_PI[String(tool).trim()];
    if (mapped != null && !out.includes(mapped)) {
      out.push(mapped);
    }
  }
  return out;
}

/** Parse a comma- or whitespace-separated `tools:` value into a name list. */
function parseToolList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const FRONTMATTER_RE = /^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/;
const TOOLS_LINE_RE = /^tools:\s*(.*)$/m;

/**
 * Render a canonical `agents/*.agent.md` into a Pi-valid `~/.agents/*.agent.md` by
 * rewriting the `tools:` frontmatter to the Pi-mapped set (dropping `todo`). The
 * body is preserved verbatim — Pi consumes `<!-- pi-only -->` blocks (#817); only
 * the strict `tools:` allowlist needs remapping. A source with no frontmatter or
 * no `tools:` line is returned unchanged (defensive — all canonical agents have
 * both).
 */
export function renderPiAgent(raw: string): string {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return raw;
  }
  const [, open, frontmatter, close, body] = match;
  const toolsLineMatch = frontmatter.match(TOOLS_LINE_RE);
  if (!toolsLineMatch) {
    return raw;
  }
  const mapped = mapAgentToolsForPi(parseToolList(toolsLineMatch[1]));
  if (mapped.length === 0) {
    return raw;
  }
  const newFrontmatter = frontmatter.replace(
    TOOLS_LINE_RE,
    `tools: ${mapped.join(", ")}`,
  );
  return `${open}${newFrontmatter}${close}${body}`;
}

/**
 * Sync the canonical packaged agents into `~/.agents/`, rewriting the `tools:`
 * frontmatter to Pi-valid builtin names (#1583). The source `agents/*.agent.md`
 * files stay unchanged (harness-neutral vocabulary); only the rendered copies are
 * remapped. Best-effort: callers swallow errors so a sync failure never breaks
 * session start.
 */
export function syncPackagedAgents({
  sourceRoot = fileURLToPath(PACKAGED_AGENTS_ROOT),
  targetRoot = path.join(os.homedir(), ".agents"),
} = {}) {
  if (!fs.existsSync(sourceRoot)) {
    return;
  }

  fs.mkdirSync(targetRoot, { recursive: true });

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
      continue;
    }

    const raw = fs.readFileSync(path.join(sourceRoot, entry.name), "utf8");
    fs.writeFileSync(path.join(targetRoot, entry.name), renderPiAgent(raw));
  }
}

export { BUILTIN_TOOL_SET };
