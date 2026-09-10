// GENERATED from packages/core/src/claude/scripts-root-resolver.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Resolve the dev-loops SCRIPTS ROOT the 46 script wrappers (`scripts/{github,loop,projects,
 * refine,release,security}/*.mjs`) invoked by skills/commands/agents should run from.
 *
 * Two runtime modes:
 *  - a live dev-loops source checkout (dogfooding): prefer it so an edit to a live script takes
 *    effect without regenerating the Claude plugin tree;
 *  - a plugin-only install with no source checkout and no global `dev-loops`: fall back to the
 *    self-contained bundle vendored into the Claude plugin tree at generate time
 *    (`scripts/claude/generate-claude-assets.mjs`), addressed via `${CLAUDE_PLUGIN_ROOT}/scripts`.
 *
 * When NEITHER resolves, this hard-stops (`ok:false`) rather than falling back to raw `gh` — a
 * silent degraded path is worse than a loud one (issue #2123).
 *
 * SELF-CONTAINED: this module (and its vendored copy at the generated `.claude/
 * resolve-scripts-root.mjs`, byte-identical modulo the generator's banner) uses ONLY node
 * builtins. It resolves the very tree that would carry `@dev-loops/core`, so it cannot depend on
 * it — the same constraint the `.claude/hooks/` bundle already lives under.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `startDir` to the nearest ancestor (inclusive) whose `package.json` declares
 * `name: "dev-loops"` AND that also has a `scripts/` directory. Returns that ancestor's absolute
 * path, or `null` if no such ancestor exists before the filesystem root.
 * @param {string} startDir
 * @returns {string|null}
 */
function findCheckoutRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg && pkg.name === "dev-loops" && fs.existsSync(path.join(dir, "scripts"))) {
          return dir;
        }
      } catch {
        // Unparsable package.json — keep walking up rather than hard-failing on it.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Resolve the scripts root.
 * @param {{ cwd?: string, pluginRoot?: string, env?: Record<string, string|undefined>, wrapper?: string }} [options]
 *   `cwd` — where to start the checkout walk-up (default `process.cwd()`).
 *   `pluginRoot` — explicit plugin root; falls back to `env.CLAUDE_PLUGIN_ROOT`.
 *   `env` — environment to read `CLAUDE_PLUGIN_ROOT` from (default `process.env`).
 *   `wrapper` — optional wrapper name, named in the hard-stop error message.
 * @returns {{ ok: true, root: string, kind: "checkout"|"bundle" } | { ok: false, error: string }}
 */
export function resolveScriptsRoot({ cwd = process.cwd(), pluginRoot, env = process.env, wrapper } = {}) {
  const checkoutRoot = findCheckoutRoot(cwd);
  if (checkoutRoot) {
    return { ok: true, root: path.join(checkoutRoot, "scripts"), kind: "checkout" };
  }

  const resolvedPluginRoot = pluginRoot ?? env.CLAUDE_PLUGIN_ROOT;
  if (resolvedPluginRoot) {
    const bundleScriptsRoot = path.join(resolvedPluginRoot, "scripts");
    if (fs.existsSync(bundleScriptsRoot)) {
      return { ok: true, root: bundleScriptsRoot, kind: "bundle" };
    }
  }

  const forWrapper = wrapper ? ` for ${wrapper}` : "";
  const bundleHint = resolvedPluginRoot ? path.join(resolvedPluginRoot, "scripts") : "<unset ${CLAUDE_PLUGIN_ROOT}>/scripts";
  return {
    ok: false,
    error:
      `Could not resolve a dev-loops scripts root${forWrapper}: no live dev-loops source checkout ` +
      `found walking up from ${cwd}, and no bundled scripts at ${bundleHint}. Refusing to fall back ` +
      `to raw gh — this is a packaging/installer bug, not a retryable condition.`,
  };
}

// --- Self-contained CLI (no scripts/lib import: this module must stay dependency-free) ---

/** node:-builtins-only direct-run check, duplicated (not imported) to keep this module
 * self-contained when vendored standalone into the Claude plugin bundle. Byte-identical in
 * intent to `scripts/lib/direct-run.mjs`. */
function isDirectCliRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

function main(argv) {
  const wrapper = argv[0];
  const result = resolveScriptsRoot({ wrapper });
  if (!result.ok) {
    process.stderr.write(JSON.stringify({ ok: false, error: result.error }) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.root}\n`);
}

if (isDirectCliRun(import.meta.url)) {
  main(process.argv.slice(2));
}
