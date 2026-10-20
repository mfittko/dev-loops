import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_AGENTS_SUBPATH, TOOLS_LINE_RE, parseToolList, syncProjectAgentsDir, writeSyncedAgents } from "./pi-agent-render.mjs";

export { TOOL_NAME_MAP_PI, mapAgentToolsForPi, renderPiAgent, renderProjectAgents, syncProjectAgentsDir } from "./pi-agent-render.mjs";

const PACKAGED_AGENTS_ROOT = new URL("../agents/", import.meta.url);

/** A dev-loops checkout: `package.json` names `dev-loops` and an `agents/` directory exists (same guard as `provision-worktree.mjs`). */
export function isDevLoopsAgentsCheckout(dir: string): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "dev-loops" && fs.statSync(path.join(dir, "agents")).isDirectory();
  } catch {
    return false;
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

/**
 * The project root Pi resolves for a cwd: the nearest ancestor (cwd included) holding a `.pi` or
 * `.agents` directory, else the cwd itself. `.git` does not stop the walk. The walk stops at the
 * home directory (`~/.pi` and `~/.agents` are user configuration, never an implicit project).
 */
export function findProjectRoot(cwd: string, home: string | null = process.env.HOME || os.homedir()): string {
  const isDir = (p: string) => {
    try {
      return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
    } catch {
      return false;
    }
  };
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const homeReal = home ? real(home) : null;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (homeReal && real(dir) === homeReal) return path.resolve(cwd);
    if (isDir(path.join(dir, ".pi")) || isDir(path.join(dir, ".agents"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
}

/**
 * Preflight: runs only in a dev-loops checkout (any other project returns null and nothing is
 * read). Refuses a launch when a file the dev-loops render writes into `.pi/agents` still
 * declares a raw `search`/`execute` tool. Only the `*.agent.md` names found in the packaged agents
 * source directory are inspected; any other project agent file is never read. Returns the typed
 * `agent_set_not_rendered` reason, else null (an absent rendered file or a rendered set passes; an unreadable source directory or rendered file refuses).
 */
export function checkAgentSetRendered(
  cwd: string,
  sourceRoot: string = fileURLToPath(PACKAGED_AGENTS_ROOT),
): string | null {
  const projectRoot = findProjectRoot(cwd);
  if (!isDevLoopsAgentsCheckout(projectRoot)) return null;
  const dir = path.join(projectRoot, PROJECT_AGENTS_SUBPATH);
  let names: string[];
  try {
    names = fs.readdirSync(sourceRoot).filter((n) => n.endsWith(".agent.md")).sort();
  } catch {
    return `agent_set_not_rendered: the packaged agents source ${sourceRoot} cannot be read, so the rendered set cannot be verified.`;
  }
  const offenders: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // ENOTDIR: a parent path component is a file, so the rendered file is absent.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      offenders.push(`${file} (unreadable)`);
      continue;
    }
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(TOOLS_LINE_RE);
    const bad = parseToolList(match?.[1] ?? "").filter((tool) => NON_PI_TOOLS.includes(tool));
    if (bad.length > 0) offenders.push(`${file} (${bad.join(", ")})`);
  }
  if (offenders.length === 0) return null;
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(dir).isSymbolicLink();
  } catch {
    // absent or unreadable: keep the default remedy
  }
  const remedy = isSymlink
    ? `\`${dir}\` is a symlink to the raw agent sources and provisioning skips it. Rebase or merge the branch onto main first (this untracks \`.pi/agents\`), then run \`dev-loops-run scripts/loop/provision-worktree.mjs --worktree-path <worktree> --repo-root <main-checkout>\`. Never restore a \`.pi/agents\` symlink to the raw agent sources.`
    : `Render the project set: in a worktree run \`dev-loops-run scripts/loop/provision-worktree.mjs --worktree-path <worktree> --repo-root <main-checkout>\`; in the main checkout restart the Pi session (the session-start sync re-renders \`${dir}\`). Never restore a \`.pi/agents\` symlink to the raw agent sources.`;
  return `agent_set_not_rendered: the rendered agent set carries non-Pi tool names or unreadable files: ${offenders.join("; ")}. ${remedy}`;
}
