// Node-loadable Pi agent render: no TypeScript syntax, so provisioning runs under plain Node
// from an installed package. extension/sync-packaged-agents.ts re-exports these.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGED_AGENTS_ROOT = new URL("../agents/", import.meta.url);

/**
 * The project-local agents directory, relative to the session's project root.
 * Pi resolves project role agents from here with precedence over the global
 * `~/.agents/`. A `.pi/agents` symlink to the package source is a legacy
 * layout: the dispatch would read the raw neutral templates and Pi strict-rejects
 * `search`, so the sync still replaces such a symlink with a real directory of
 * Pi-valid copies. `.pi/agents` is now untracked and rendered at worktree
 * provision time.
 */
export const PROJECT_AGENTS_SUBPATH = path.join(".pi", "agents");

/**
 * Pi tool-name map — mirrors the Claude `TOOL_NAME_MAP`
 * (`packages/core/src/claude/asset-generation.mjs`) but maps the harness-neutral
 * agent tool vocabulary to Pi builtins. Applied at session-start sync time so
 * `~/.agents/*.agent.md` lists only valid Pi builtin tool names (#1583).
 *
 *   read→read, search→grep+find+ls, execute→bash, bash→bash, edit→edit, write→write,
 *   agent→subagent, subagent→subagent, todo→(drop), review_loop→review_loop
 *
 * `todo` has no Pi builtin (Claude keeps `TodoWrite`); the dev-loop acceptance
 * checklist falls back to prose/bash under Pi — documented in
 * `agents/dev-loop.agent.md`. This is a #1086 cross-harness regression fix: the
 * Pi path had no equivalent map, so Pi rejected `search`/`execute`/`agent`/`todo`
 * as unavailable child tools and ended runs with a `failed` status.
 */
export const TOOL_NAME_MAP_PI = Object.freeze({
  read: "read",
  search: ["grep", "find", "ls"], // shell-free builtins: a search-only role keeps no unrestricted shell (#2582)
  execute: "bash",
  bash: "bash",
  edit: "edit",
  write: "write",
  agent: "subagent",
  subagent: "subagent",
  todo: null, // dropped — no Pi todo builtin
  review_loop: "review_loop",
});

/** Map a list of harness-neutral tool names to deduped Pi builtin names (first-seen order). */
export function mapAgentToolsForPi(tools) {
  const out = [];
  for (const tool of tools ?? []) {
    const mapped = TOOL_NAME_MAP_PI[String(tool).trim()];
    for (const name of [mapped ?? []].flat()) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Parse a comma- or whitespace-separated `tools:` value into a name list. */
export function parseToolList(value) {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const FRONTMATTER_RE = /^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/;
export const TOOLS_LINE_RE = /^tools:\s*(.*)$/m;

/**
 * Render a canonical `agents/*.agent.md` into a Pi-valid `~/.agents/*.agent.md` by
 * rewriting the `tools:` frontmatter to the Pi-mapped set (dropping `todo`). The
 * body is preserved verbatim — Pi consumes `<!-- pi-only -->` blocks (#817); only
 * the strict `tools:` allowlist needs remapping. When `resolveModel(name)` returns a
 * non-null id, the frontmatter `model:` line is set to it (replacing any existing
 * one) so the child never inherits the conductor. A source with no frontmatter or
 * no `tools:` line is returned unchanged (defensive — all canonical agents have
 * both).
 */
export function renderPiAgent(raw, resolveModel) {
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
  let newFrontmatter;
  if (mapped.length === 0) {
    // All declared tools dropped (e.g. a source with only `todo`) — remove the
    // `tools:` line entirely so no forbidden name leaks into the rendered
    // allowlist (#1583). Returning raw would leave the unmapped names in place.
    newFrontmatter = frontmatter.replace(/^[ \t]*tools:[^\n]*\n?/m, "");
  } else {
    newFrontmatter = frontmatter.replace(TOOLS_LINE_RE, `tools: ${mapped.join(", ")}`);
  }
  const name = newFrontmatter.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
  const model = name && resolveModel ? resolveModel(name) : null;
  if (model) {
    newFrontmatter = /^model:/m.test(newFrontmatter)
      ? newFrontmatter.replace(/^model:.*$/m, () => `model: ${JSON.stringify(model)}`)
      : `${newFrontmatter}\nmodel: ${JSON.stringify(model)}`;
  }
  return `${open}${newFrontmatter}${close}${body}`;
}

/**
 * Write Pi-valid rendered copies of every packaged `agents/*.agent.md` into
 * `destDir` (created if missing). Shared by the global `~/.agents/` sync and the
 * project-local `.pi/agents/` sync (#1606) so both targets get identical Pi-valid
 * rewrites from the same neutral source.
 */
export function writeSyncedAgents(sourceRoot, destDir, resolveModel) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
      continue;
    }
    const raw = fs.readFileSync(path.join(sourceRoot, entry.name), "utf8");
    fs.writeFileSync(path.join(destDir, entry.name), renderPiAgent(raw, resolveModel));
  }
}

/**
 * Sync the project-local `.pi/agents/` directory with Pi-valid copies (#1606).
 *
 * When `.pi/agents` is a **symlink** (the legacy layout this sync replaces, decision record 0173:
 * `.pi/agents -> ../agents`, dogfooding the package source), the Pi `subagent`
 * tool resolves project role agents from here with precedence over the global
 * `~/.agents/`, so the dispatch reads the raw neutral templates and Pi
 * strict-rejects `search`. The sync replaces the symlink with a REAL
 * directory of Pi-valid rendered copies — it does NOT write through the symlink
 * (writing through would overwrite the neutral source and break Claude asset
 * generation; the source retains mapped `search` and uses `bash` for execution).
 *
 * When `.pi/agents` is already a real directory, its packaged-agent files are
 * refreshed in place (same overwrite semantics as the global `~/.agents/` sync).
 *
 * When `.pi/agents` is **absent**, the sync is a no-op: consumer repos without a
 * project `.pi/agents` entry resolve from the global `~/.agents/` (already
 * Pi-valid after `syncPackagedAgents`) and stay unaffected.
 */
export function syncProjectAgentsDir(projectRoot, sourceRoot, resolveModel) {
  const projectAgentsDir = path.join(projectRoot, PROJECT_AGENTS_SUBPATH);
  let stat;
  try {
    stat = fs.lstatSync(projectAgentsDir);
  } catch {
    // Absent — consumer repo relies on the global ~/.agents/ (no project shadow).
    return;
  }
  if (stat.isSymbolicLink()) {
    // Render all Pi-valid copies into a TEMP directory FIRST, so a read/render
    // failure never leaves the project without `.pi/agents`. Only once the
    // replacement content is known-good do we unlink the symlink and atomically
    // rename the prepared directory into place (#1607 Copilot review: never
    // remove the symlink before the replacement is prepared). rmSync on a
    // symlink unlinks the link only; the neutral source target stays untouched.
    const tmpDir = path.join(path.dirname(projectAgentsDir), `.pi-agents.tmp-${process.pid}`);
    fs.rmSync(tmpDir, { force: true, recursive: true });
    try {
      writeSyncedAgents(sourceRoot, tmpDir, resolveModel);
    } catch (err) {
      fs.rmSync(tmpDir, { force: true, recursive: true });
      throw err;
    }
    fs.rmSync(projectAgentsDir, { force: true });
    fs.renameSync(tmpDir, projectAgentsDir);
  } else {
    // Real directory: refresh packaged-agent files in place (same overwrite
    // semantics as the global ~/.agents/ sync).
    writeSyncedAgents(sourceRoot, projectAgentsDir, resolveModel);
  }
}

/**
 * Provision-time render: ensure `<projectRoot>/.pi/agents` is a REAL
 * directory of Pi-valid rendered copies, creating it when absent. Unlike
 * `syncProjectAgentsDir` (absent => no-op, for the consumer session_start path),
 * worktree provisioning calls this so every checkout gets the set.
 */
export function renderProjectAgents(
  projectRoot,
  sourceRoot = fileURLToPath(PACKAGED_AGENTS_ROOT),
  resolveModel,
) {
  const dir = path.join(projectRoot, PROJECT_AGENTS_SUBPATH);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
    syncProjectAgentsDir(projectRoot, sourceRoot, resolveModel);
  } else {
    writeSyncedAgents(sourceRoot, dir, resolveModel);
  }
}
