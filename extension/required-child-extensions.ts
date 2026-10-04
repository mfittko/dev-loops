/**
 * Load the dev-loops extension inside Pi subagent children (#2582).
 *
 * The read-only role gate (`./readonly-role-gate.ts`) is a `tool_call` handler, so it only
 * fires when the dev-loops extension is loaded in the *calling* session. pi-subagents never
 * loads ambient extensions into a foreground (`async: false`) child — the shipped gate
 * fan-out shape — so the gate stayed inert for real judge and reviewer children even though
 * their system prompt carries the `<active_agent name="..."/>` tag.
 *
 * The extension therefore registers itself as a required child extension for its own session
 * (`pi-subagents/required-child-extensions`). A required extension is appended to every
 * child's extension list on both launch hosts, so a foreground child now loads the extension
 * and its `tool_call` handler resolves the tag from its own prompt.
 *
 * Pi-only and optional: `extension/index.ts` is the Pi entry (`pi.extensions`), and Claude
 * Code never loads it. The `pi-subagents` import is guarded, so a session without
 * pi-subagents installed is unaffected.
 */

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Safe host-owned id for the registration (pi-subagents exposes ids, never paths, in evidence). */
export const REQUIRED_CHILD_EXTENSION_ID = "dev-loops-readonly-role-gate";

export type RequiredChildExtensionRegistration = { dispose(): void };

export type RegisterRequiredChildExtensions = (input: {
  sessionId: string;
  extensions: ReadonlyArray<{ id: string; path: string }>;
  requireForAllRunners?: boolean;
}) => RequiredChildExtensionRegistration;

/**
 * Bounded `node_modules` search roots for `pi-subagents`, mirroring the bounded-candidate
 * discipline used to locate the dev-loops CLI (never an unbounded filesystem walk).
 *
 * - every ancestor `node_modules` of the extension directory: covers a checkout that installs
 *   pi-subagents locally and an installed dev-loops package that depends on it
 * - the Pi npm package directory: how Pi installs npm packages (`~/.pi/agent/npm/node_modules`)
 * - `NODE_PATH` entries
 * - the global npm prefix derived from the running Node binary (`<prefix>/lib/node_modules`):
 *   the container installs pi-subagents with `npm install -g`
 */
export function candidatePiSubagentsRoots({
  extensionDir,
  home = os.homedir(),
  nodePath = process.env.NODE_PATH,
  execPath = process.execPath,
}: {
  extensionDir: string;
  home?: string;
  nodePath?: string;
  execPath?: string;
}): string[] {
  const roots: string[] = [];
  let dir = path.resolve(extensionDir);
  for (;;) {
    roots.push(path.join(dir, "node_modules"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  roots.push(path.join(home, ".pi", "agent", "npm", "node_modules"));
  for (const entry of (nodePath ?? "").split(path.delimiter)) {
    if (entry) roots.push(entry);
  }
  roots.push(path.join(path.dirname(path.dirname(execPath)), "lib", "node_modules"));
  return [...new Set(roots)];
}

const SPECIFIER = "pi-subagents/required-child-extensions";

/**
 * Resolve `registerRequiredChildExtensions` from pi-subagents, or null when pi-subagents is
 * not installed in any bounded root (or is too old to export the API). The subpath is
 * resolved through the package's own `exports` map, never a hard-coded internal file path.
 */
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function loadRegisterRequiredChildExtensions({
  roots = candidatePiSubagentsRoots({ extensionDir: EXTENSION_DIR }),
  importer = import.meta.url,
}: {
  roots?: string[];
  importer?: string;
} = {}): Promise<RegisterRequiredChildExtensions | null> {
  const require = createRequire(importer);
  for (const root of roots) {
    try {
      const resolved = require.resolve(SPECIFIER, { paths: [root] });
      const mod = (await import(pathToFileURL(resolved).href)) as { registerRequiredChildExtensions?: unknown };
      if (typeof mod.registerRequiredChildExtensions === "function") {
        return mod.registerRequiredChildExtensions as RegisterRequiredChildExtensions;
      }
    } catch {
      // Not resolvable from this root — try the next bounded candidate.
    }
  }
  return null;
}

/**
 * Register the dev-loops extension as a required child extension for one parent session.
 *
 * `requireForAllRunners` is requested first so a placement that cannot load the extension
 * (an external CLI/job runner or a remote machine) is refused instead of running ungated.
 * pi-subagents < 0.75 has no such flag and rejects the unknown key, so the non-mandatory
 * form is retried; it still gates every native child, which is the only placement dev-loops
 * declares for its role agents.
 */
export function registerDevLoopsRequiredChildExtension({
  register,
  sessionId,
  extensionPath,
}: {
  register: RegisterRequiredChildExtensions;
  sessionId: string;
  extensionPath: string;
}): RequiredChildExtensionRegistration | null {
  if (!sessionId || !extensionPath) return null;
  const extensions = [{ id: REQUIRED_CHILD_EXTENSION_ID, path: extensionPath }];
  try {
    return register({ sessionId, extensions, requireForAllRunners: true });
  } catch {
    // Older pi-subagents: retry without the mandatory-runner flag.
  }
  try {
    return register({ sessionId, extensions });
  } catch {
    return null;
  }
}

export type ChildRoleGateRegistrar = {
  /** Register for one session id; re-registering disposes the prior handle. No-ops without a loader or id. */
  register(sessionId: string | undefined): Promise<void>;
  /** Dispose every live registration (idempotent). */
  disposeAll(): void;
  /** Live session ids, in registration order. */
  registeredSessionIds(): string[];
};

/**
 * Session-scoped owner of the required-child-extension registrations. One registration is
 * allowed per session id, so a repeated `session_start` disposes the prior handle first, and
 * `session_shutdown` releases them all.
 */
export function createChildRoleGateRegistrar({
  extensionPath,
  load = loadRegisterRequiredChildExtensions,
}: {
  extensionPath: string;
  load?: typeof loadRegisterRequiredChildExtensions;
}): ChildRoleGateRegistrar {
  const registrations = new Map<string, RequiredChildExtensionRegistration>();
  return {
    async register(sessionId) {
      if (!sessionId) return;
      registrations.get(sessionId)?.dispose();
      registrations.delete(sessionId);
      const register = await load();
      if (!register) return;
      const registration = registerDevLoopsRequiredChildExtension({ register, sessionId, extensionPath });
      if (registration) registrations.set(sessionId, registration);
    },
    disposeAll() {
      for (const registration of registrations.values()) registration.dispose();
      registrations.clear();
    },
    registeredSessionIds() {
      return [...registrations.keys()];
    },
  };
}
