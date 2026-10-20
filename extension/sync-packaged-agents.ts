import fs from "node:fs";
import os from "node:os";
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
const PROJECT_AGENTS_SUBPATH = path.join(".pi", "agents");

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
export const TOOL_NAME_MAP_PI: Readonly<Record<string, string | readonly string[] | null>> = Object.freeze({
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
export function mapAgentToolsForPi(tools: string[]): string[] {
  const out: string[] = [];
  for (const tool of tools ?? []) {
    const mapped = TOOL_NAME_MAP_PI[String(tool).trim()];
    for (const name of [mapped ?? []].flat()) {
      if (!out.includes(name)) out.push(name);
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
 * Provision-time render: ensure `<projectRoot>/.pi/agents` is a REAL
 * directory of Pi-valid rendered copies, creating it when absent. Unlike
 * `syncProjectAgentsDir` (absent => no-op, for the consumer session_start path),
 * worktree provisioning calls this so every checkout gets the set.
 */
export function renderProjectAgents(
  projectRoot: string,
  sourceRoot: string = fileURLToPath(PACKAGED_AGENTS_ROOT),
) {
  const dir = path.join(projectRoot, PROJECT_AGENTS_SUBPATH);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) {
    syncProjectAgentsDir(projectRoot, sourceRoot);
  } else {
    writeSyncedAgents(sourceRoot, dir);
  }
}

/**
 * Sync the canonical packaged agents into `~/.agents/`, rewriting the `tools:`
 * frontmatter to Pi-valid builtin names (#1583). The source `agents/*.agent.md`
 * files stay harness-neutral (role agents retain mapped `search` and use `bash`
 * for execution; the dev-loop
 * entrypoint drops `agent`/`todo` per #1604); only the rendered copies are
 * remapped. Best-effort: callers swallow errors so a sync failure never breaks
 * session start.
 *
 * #1606: when `projectRoot` is supplied (the session's project cwd), the sync
 * ALSO targets the project-local `.pi/agents/` directory with symlink-safety:
 * the legacy `.pi/agents -> ../agents` symlink is replaced with a real directory of Pi-valid
 * copies so project-local agent resolution no longer reads the raw source. This
 * fixes the dev-loops repo's own dispatch (the project symlink bypassed the global
 * sync). Consumer repos without a `.pi/agents` entry are unaffected (no-op).
 */
export function syncPackagedAgents({
  sourceRoot = fileURLToPath(PACKAGED_AGENTS_ROOT),
  targetRoot = path.join(process.env.HOME || os.homedir(), ".agents"),
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

/** Neutral source tokens that are not Pi tool names. */
const NON_PI_TOOLS = ["search", "execute"];

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Bounded global directories where Pi may discover dev-loops agent definitions, in Pi load
 * precedence order: user roots first, then the installed package roots. The package roots hold the
 * raw neutral sources by design (decision record 0173), so a role is checked there only when no
 * higher-precedence copy exists.
 */
function globalAgentRoots(home: string): string[] {
  const piAgent = path.join(home, ".pi", "agent");
  const gitRoots = subdirs(path.join(piAgent, "git"))
    .flatMap(subdirs)
    .map((d) => path.join(d, "dev-loops", "agents"));
  return [
    path.join(home, ".agents"),
    path.join(piAgent, "agents"),
    path.join(piAgent, "npm", "node_modules", "dev-loops", "agents"),
    ...gitRoots,
  ];
}

/**
 * The project root Pi resolves for a cwd: the nearest ancestor (cwd included) holding a `.pi` or
 * `.agents` directory, else the cwd itself. `.git` does not stop the walk.
 */
export function findProjectRoot(cwd: string): string {
  const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (isDir(path.join(dir, ".pi")) || isDir(path.join(dir, ".agents"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
}

/**
 * Preflight: inspect the loaded project agent set (`.pi/agents` of the project root that contains
 * `cwd`, real directory or symlink) and return a typed `agent_set_not_rendered` reason when any
 * `*.agent.md` still declares a raw `search`/`execute` tool, else null. An absent directory is
 * allowed (consumer repos resolve from the rendered `~/.agents/`). For each requested role without a
 * project copy, only the definition Pi would load (first of the global roots holding the role) is
 * checked, so a raw package copy shadowed by a rendered higher-precedence copy is allowed.
 */
export function checkAgentSetRendered(
  cwd: string,
  { roles = [], home = process.env.HOME || os.homedir() }: { roles?: readonly string[]; home?: string | null } = {},
): string | null {
  const projectOffenders: string[] = [];
  const globalOffenders: string[] = [];
  const check = (file: string, into: string[]) => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return false;
    }
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(TOOLS_LINE_RE);
    const bad = parseToolList(match?.[1] ?? "").filter((tool) => NON_PI_TOOLS.includes(tool));
    if (bad.length > 0) into.push(`${file} (${bad.join(", ")})`);
    return true;
  };
  const dir = path.join(findProjectRoot(cwd), PROJECT_AGENTS_SUBPATH);
  let projectFiles: string[] = [];
  try {
    projectFiles = fs.readdirSync(dir).filter((n) => n.endsWith(".agent.md")).sort();
  } catch {
    // Absent project directory is allowed.
  }
  for (const name of projectFiles) check(path.join(dir, name), projectOffenders);
  // Pi also discovers global copies that load when the project has no copy of the role (decision record 0173).
  if (home) {
    const roots = globalAgentRoots(home);
    for (const role of roles) {
      if (projectFiles.includes(`${role}.agent.md`)) continue;
      for (const root of roots) {
        if (check(path.join(root, `${role}.agent.md`), globalOffenders)) break;
      }
    }
  }
  if (projectOffenders.length + globalOffenders.length === 0) return null;
  const remedies = [
    projectOffenders.length > 0 &&
      "Render the project set: in a worktree run `dev-loops-run scripts/loop/provision-worktree.mjs --worktree-path <worktree> --repo-root <main-checkout>`; in the main checkout restart the Pi session so the session-start sync re-renders it. Never restore a `.pi/agents` symlink to the raw agent sources.",
    globalOffenders.length > 0 &&
      "Remove or reinstall the named global copy (re-run the packaged-agent sync for `~/.agents`), or launch with `options.agentScope: \"project\"` to skip the global check.",
  ].filter(Boolean);
  return (
    `agent_set_not_rendered: the loaded agent set carries non-Pi tool names: ${[...projectOffenders, ...globalOffenders].join("; ")}. ` +
    remedies.join(" ")
  );
}
