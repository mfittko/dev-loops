import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGED_AGENTS_ROOT = new URL("../agents/", import.meta.url);

/**
 * The project-local agents directory, relative to the session's project root.
 * Pi resolves project role agents from here with precedence over the global
 * `~/.agents/` (#1606): when a repo symlinks `.pi/agents` -> the package source
 * (the dev-loops repo dogfooding convention), the dispatch reads the raw neutral
 * templates and Pi strict-rejects `search`/`execute`. The project-local sync
 * replaces that symlink with a real directory of Pi-valid copies.
 */
const PROJECT_AGENTS_SUBPATH = path.join(".pi", "agents");

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
  let newFrontmatter: string;
  if (mapped.length === 0) {
    // All declared tools dropped (e.g. a source with only `todo`) — remove the
    // `tools:` line entirely so no forbidden name leaks into the rendered
    // allowlist (#1583). Returning raw would leave the unmapped names in place.
    newFrontmatter = frontmatter.replace(/^[ \t]*tools:[^\n]*\n?/m, "");
  } else {
    newFrontmatter = frontmatter.replace(TOOLS_LINE_RE, `tools: ${mapped.join(", ")}`);
  }
  return `${open}${newFrontmatter}${close}${body}`;
}

/**
 * Write Pi-valid rendered copies of every packaged `agents/*.agent.md` into
 * `destDir` (created if missing). Shared by the global `~/.agents/` sync and the
 * project-local `.pi/agents/` sync (#1606) so both targets get identical Pi-valid
 * rewrites from the same neutral source.
 */
function writeSyncedAgents(sourceRoot: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
      continue;
    }
    const raw = fs.readFileSync(path.join(sourceRoot, entry.name), "utf8");
    fs.writeFileSync(path.join(destDir, entry.name), renderPiAgent(raw));
  }
}

/**
 * Sync the project-local `.pi/agents/` directory with Pi-valid copies (#1606).
 *
 * When `.pi/agents` is a **symlink** (the dev-loops repo dev convention:
 * `.pi/agents -> ../agents`, dogfooding the package source), the Pi `subagent`
 * tool resolves project role agents from here with precedence over the global
 * `~/.agents/`, so the dispatch reads the raw neutral templates and Pi
 * strict-rejects `search`/`execute`. The sync replaces the symlink with a REAL
 * directory of Pi-valid rendered copies — it does NOT write through the symlink
 * (writing through would overwrite the neutral source and break Claude asset
 * generation; the source must keep `search`/`execute` per #1086).
 *
 * When `.pi/agents` is already a real directory, its packaged-agent files are
 * refreshed in place (same overwrite semantics as the global `~/.agents/` sync).
 *
 * When `.pi/agents` is **absent**, the sync is a no-op: consumer repos without a
 * project `.pi/agents` entry resolve from the global `~/.agents/` (already
 * Pi-valid after `syncPackagedAgents`) and stay unaffected.
 */
export function syncProjectAgentsDir(projectRoot: string, sourceRoot: string) {
  const projectAgentsDir = path.join(projectRoot, PROJECT_AGENTS_SUBPATH);
  let stat: fs.Stats | undefined;
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
      writeSyncedAgents(sourceRoot, tmpDir);
    } catch (err) {
      fs.rmSync(tmpDir, { force: true, recursive: true });
      throw err;
    }
    fs.rmSync(projectAgentsDir, { force: true });
    fs.renameSync(tmpDir, projectAgentsDir);
  } else {
    // Real directory: refresh packaged-agent files in place (same overwrite
    // semantics as the global ~/.agents/ sync).
    writeSyncedAgents(sourceRoot, projectAgentsDir);
  }
}

/**
 * Sync the canonical packaged agents into `~/.agents/`, rewriting the `tools:`
 * frontmatter to Pi-valid builtin names (#1583). The source `agents/*.agent.md`
 * files stay harness-neutral (role agents keep `search`/`execute`; the dev-loop
 * entrypoint drops `agent`/`todo` per #1604); only the rendered copies are
 * remapped. Best-effort: callers swallow errors so a sync failure never breaks
 * session start.
 *
 * #1606: when `projectRoot` is supplied (the session's project cwd), the sync
 * ALSO targets the project-local `.pi/agents/` directory with symlink-safety —
 * replacing a `.pi/agents -> ../agents` symlink with a real directory of Pi-valid
 * copies so project-local agent resolution no longer reads the raw source. This
 * fixes the dev-loops repo's own dispatch (the project symlink bypassed the global
 * sync). Consumer repos without a `.pi/agents` entry are unaffected (no-op).
 */
export function syncPackagedAgents({
  sourceRoot = fileURLToPath(PACKAGED_AGENTS_ROOT),
  targetRoot = path.join(os.homedir(), ".agents"),
  projectRoot,
}: {
  sourceRoot?: string;
  targetRoot?: string;
  projectRoot?: string;
} = {}) {
  if (!fs.existsSync(sourceRoot)) {
    return;
  }

  writeSyncedAgents(sourceRoot, targetRoot);

  if (projectRoot) {
    // Best-effort project-local sync — never break the (already-completed) global sync.
    try {
      syncProjectAgentsDir(projectRoot, sourceRoot);
    } catch {
      // Swallowed: a project-local sync failure (e.g. permission) must not surface
      // from the session_start best-effort path.
    }
  }
}
