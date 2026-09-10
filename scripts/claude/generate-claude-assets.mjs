#!/usr/bin/env node
/**
 * Generate the Claude Code asset tree (.claude/agents, .claude/skills, and the plugin
 * manifest version in .claude/.claude-plugin/plugin.json) from the canonical Pi sources
 * (agents/*.agent.md, skills/<name>/SKILL.md) and the root package.json version. The sources
 * remain the single source of truth; the generated tree is committed and kept in sync by
 * `--check` (CI/test).
 *
 * Usage:
 *   node scripts/claude/generate-claude-assets.mjs            Write the .claude tree.
 *   node scripts/claude/generate-claude-assets.mjs --check    Exit non-zero if the committed
 *                                                             tree drifts from the sources.
 *   --repo-root <path>   Override the repo root (default: cwd).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { transformAgent, transformSkill, transformCommand, stripPiOnlyBlocks } from "@dev-loops/core/claude/asset-generation";
import { isDirectCliRun } from "../lib/direct-run.mjs";

/**
 * Collect the generated assets as { target, content } pairs (target is repo-relative).
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ target: string, content: string }[]}
 */
export function collectGeneratedAssets({ repoRoot = process.cwd() } = {}) {
  const assets = [];

  // The dev-loops package version pins the Claude `npx dev-loops@<version>` CLI invocation so the
  // generated plugin tree cannot drift against the published version. Read it once here.
  // Falls back to `latest` when no repo-root package.json is present (e.g. a consumer/fixture tree
  // that mirrors only agents/skills).
  let version = "latest";
  const pkgPath = path.join(repoRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "latest";
  }

  // The plugin manifest's version must equal the package version (locked by the
  // claude-plugin-manifest contract test). Emitting the manifest as a generated asset makes a
  // release bump self-syncing and lets --check catch a stale manifest at asset-check time.
  // Non-version fields stay hand-authored: the committed manifest is the source, only the
  // version field is stamped.
  const manifestRel = ".claude/.claude-plugin/plugin.json";
  const manifestAbs = path.join(repoRoot, manifestRel);
  if (fs.existsSync(manifestAbs) && version !== "latest") {
    const manifest = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
    manifest.version = version;
    assets.push({ target: manifestRel, content: JSON.stringify(manifest, null, 2) + "\n" });
  }

  const agentsDir = path.join(repoRoot, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir).sort()) {
      if (!entry.endsWith(".agent.md")) continue;
      const source = `agents/${entry}`;
      const raw = fs.readFileSync(path.join(repoRoot, source), "utf8");
      const base = entry.slice(0, -".agent.md".length);
      assets.push({ target: `.claude/agents/${base}.md`, content: transformAgent({ source, raw, version }) });
    }
  }

  // Direct slash commands: thin generated wrappers over the public dev-loop contract,
  // one `.claude/commands/<name>.md` per `commands/<name>.command.md` source. No routing logic.
  const commandsDir = path.join(repoRoot, "commands");
  if (fs.existsSync(commandsDir)) {
    for (const entry of fs.readdirSync(commandsDir).sort()) {
      if (!entry.endsWith(".command.md")) continue;
      const source = `commands/${entry}`;
      const raw = fs.readFileSync(path.join(repoRoot, source), "utf8");
      const base = entry.slice(0, -".command.md".length);
      assets.push({ target: `.claude/commands/${base}.md`, content: transformCommand({ source, raw, version }) });
    }
  }

  const skillsDir = path.join(repoRoot, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const source = `skills/${entry.name}/SKILL.md`;
      const abs = path.join(repoRoot, source);
      if (!fs.existsSync(abs)) continue; // e.g. skills/docs/ holds shared docs, not a SKILL.md
      const raw = fs.readFileSync(abs, "utf8");
      assets.push({ target: `.claude/skills/${entry.name}/SKILL.md`, content: transformSkill({ source, raw, version }) });
    }
  }

  // Bundle the shared markdown the generated skills reference via relative links so they resolve
  // inside the .claude/ tree. The skills live at .claude/skills/<name>/, so:
  //   `../docs/<contract>.md`        → .claude/skills/docs/<contract>.md      (skills/docs/*.md)
  //   `../dev-loop/templates/<t>.md` → .claude/skills/dev-loop/templates/<t>.md (skills/dev-loop/templates/*.md)
  // Copied verbatim; the no-drift test keeps them in sync with source. (Repo-root `../../` refs —
  // PLAN.md/AGENTS.md/docs/phases — point at the *consumer project's* files and are out of scope.)
  for (const [srcRel, targetRel] of [
    ["skills/docs", ".claude/skills/docs"],
    ["skills/dev-loop/templates", ".claude/skills/dev-loop/templates"],
  ]) {
    assets.push(...collectBundle(repoRoot, srcRel, targetRel));
  }

  // Self-contained hook bundle. The PreToolUse/PostToolUse hook scripts under
  // .claude/hooks/ ship inside the Claude plugin, which has no node_modules — so they cannot
  // import `@dev-loops/core` (it is unresolvable from the plugin cache and crashes the hook on
  // load). Vendor the pure deciders/classifiers they need as self-contained relative `_*.mjs`
  // modules generated from the canonical core sources, with cross-module imports rewritten to
  // local paths. The no-drift check keeps them in sync with packages/core/src.
  assets.push(...collectHookBundle(repoRoot));

  // Self-contained scripts-root bundle (issue #2123). The Claude plugin ships only agents/
  // commands/hooks/skills — skills/commands/agents invoke 46 script wrappers
  // (`scripts/{github,loop,projects,refine,release,security}/*.mjs`) plus `@dev-loops/core` that
  // a plugin-only install (no source checkout, no global `dev-loops`) cannot otherwise resolve.
  // Bundle scripts/** verbatim, the runtime deps those wrappers import (yaml, zod) verbatim from
  // this repo's own node_modules, `@dev-loops/core` (respecting its package.json `files`, which
  // already excludes packages/core/test), and the self-contained resolver
  // (`resolveScriptsRoot`) that picks between a live checkout and this bundle at runtime — see
  // `packages/core/src/claude/scripts-root-resolver.mjs`.
  assets.push(...collectScriptsBundle(repoRoot));
  assets.push(...collectNodeModulesVendorBundle(repoRoot));
  assets.push(...collectCoreVendorBundle(repoRoot));
  assets.push(...collectScriptsRootResolverAsset(repoRoot));

  return assets;
}

/**
 * Recursively collect every file under an absolute source directory as verbatim
 * `{ target, content }` bundle assets rooted at `targetRel`. No banner/content mutation — third-
 * party and vendored-verbatim trees must byte-match their source so `--check` is byte-stable.
 */
function collectDirVerbatim(absSourceDir, targetRel) {
  const out = [];
  if (!fs.existsSync(absSourceDir)) return out;
  for (const entry of fs.readdirSync(absSourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childAbs = path.join(absSourceDir, entry.name);
    const childTarget = `${targetRel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectDirVerbatim(childAbs, childTarget));
    } else if (entry.isFile()) {
      out.push({ target: childTarget, content: fs.readFileSync(childAbs, "utf8") });
    }
  }
  return out;
}

/** Verbatim `scripts/**` → `.claude/scripts/**` (the 46 wrappers skills/commands/agents invoke,
 * plus every other file under `scripts/` — a wrapper's data file is never known ahead of time, so
 * the whole tree is bundled rather than tracing each wrapper's own reads). */
function collectScriptsBundle(repoRoot) {
  return collectDirVerbatim(path.join(repoRoot, "scripts"), ".claude/scripts");
}

/** Runtime deps the bundled scripts import at runtime (`yaml`, `zod`) — resolved via Node's own
 * module resolution starting from `repoRoot`'s package.json, so this finds an ancestor
 * `node_modules` (e.g. the main checkout's, when `repoRoot` is a nested worktree that has no
 * `node_modules` of its own) exactly the way the bundled scripts would resolve them at runtime. A
 * repoRoot with neither installed (e.g. a bare fixture tree) is a no-op, matching every other
 * bundle collector here. */
const NODE_MODULES_VENDOR = ["yaml", "zod"];

// A vendored runtime dep is resolved through its package.json `main`/`exports` map, which always
// targets compiled output (`.js`/`.cjs`) — never `src/` (TypeScript source some packages, e.g.
// zod, additionally ship per their OWN `files` allowlist) or a type-declaration file (`.d.ts`/
// `.d.cts`/`.d.mts`, load-bearing only for a type checker, never for `node` at runtime). Skipping
// both keeps the vendored bundle to what actually runs, and — as a side effect — excludes a
// dependency's own bundled test fixtures (zod ships `src/**/*.test.ts`).
//
// The vendored dep tree is copied byte-verbatim. Its already-public, already-audited compiled
// source would trip the pre-commit secret scanner on high-entropy lexer/token constants, so
// `scripts/security/scan-staged-diff.mjs` excludes `.claude/node_modules/` outright — the same
// posture it already holds toward the real `node_modules/` this is a byte-reproducible mirror of.
// The bundle is therefore left unmodified; no per-line marker rewrite runs over vendored code.
function collectRuntimeDepDirVerbatim(absSourceDir, targetRel) {
  const out = [];
  if (!fs.existsSync(absSourceDir)) return out;
  for (const entry of fs.readdirSync(absSourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childAbs = path.join(absSourceDir, entry.name);
    const childTarget = `${targetRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "src") continue; // TS source, not a runtime resolution target
      out.push(...collectRuntimeDepDirVerbatim(childAbs, childTarget));
    } else if (entry.isFile()) {
      if (/\.d\.(ts|cts|mts)$/.test(entry.name)) continue; // type declarations, not read by node
      out.push({ target: childTarget, content: fs.readFileSync(childAbs, "utf8") });
    }
  }
  return out;
}

function collectNodeModulesVendorBundle(repoRoot) {
  const out = [];
  let require_;
  try {
    require_ = createRequire(path.join(repoRoot, "package.json"));
  } catch {
    return out;
  }
  for (const pkgName of NODE_MODULES_VENDOR) {
    let pkgJsonPath;
    try {
      pkgJsonPath = require_.resolve(`${pkgName}/package.json`);
    } catch {
      continue; // not resolvable from repoRoot — no-op
    }
    out.push(...collectRuntimeDepDirVerbatim(path.dirname(pkgJsonPath), `.claude/node_modules/${pkgName}`));
  }
  return out;
}

/** `@dev-loops/core` vendored into the bundle, respecting its OWN package.json `files` allowlist
 * (`src/**\/*.mjs`, `src/**\/*.yaml`, `bin/**\/*.mjs`) plus `package.json` itself (needed so the
 * bundled scripts' `@dev-loops/core/...` imports resolve via its `exports` map). `files` already
 * excludes `packages/core/test/` — respecting it is what bounds the bundle size, no separate
 * prune step needed. */
function collectCoreVendorBundle(repoRoot) {
  const coreDir = path.join(repoRoot, "packages/core");
  const pkgJsonPath = path.join(coreDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return [];
  const out = [
    { target: ".claude/node_modules/@dev-loops/core/package.json", content: fs.readFileSync(pkgJsonPath, "utf8") },
  ];
  const allowedExtBySubdir = { src: [".mjs", ".yaml"], bin: [".mjs"] };
  for (const [sub, allowedExts] of Object.entries(allowedExtBySubdir)) {
    for (const asset of collectDirVerbatim(path.join(coreDir, sub), `.claude/node_modules/@dev-loops/core/${sub}`)) {
      if (allowedExts.some((ext) => asset.target.endsWith(ext))) out.push(asset);
    }
  }
  return out;
}

/** The self-contained resolver vendored to `.claude/resolve-scripts-root.mjs` (addressed at
 * runtime as `${CLAUDE_PLUGIN_ROOT}/resolve-scripts-root.mjs`). Verbatim copy plus the same
 * generated-banner convention as `HOOK_BUNDLE` — this module has no cross-module imports, so no
 * rewrites are needed. */
function collectScriptsRootResolverAsset(repoRoot) {
  const source = "packages/core/src/claude/scripts-root-resolver.mjs";
  const abs = path.join(repoRoot, source);
  if (!fs.existsSync(abs)) return [];
  const banner = `${HOOK_BUNDLE_BANNER_PREFIX}${source} by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.\n`;
  return [{ target: ".claude/resolve-scripts-root.mjs", content: banner + fs.readFileSync(abs, "utf8") }];
}

/**
 * The core modules vendored into `.claude/hooks/` for the self-contained hook bundle.
 * `rewrites` rewrites cross-module import specifiers to the sibling vendored copies; node:
 * builtins are left untouched.
 */
const HOOK_BUNDLE = [
  { source: "packages/core/src/loop/bash-command-classify.mjs", target: ".claude/hooks/_bash-command-classify.mjs", rewrites: [] },
  { source: "packages/core/src/loop/run-context.mjs", target: ".claude/hooks/_run-context.mjs", rewrites: [] },
  {
    source: "packages/core/src/claude/hook-decisions.mjs",
    target: ".claude/hooks/_hook-decisions.mjs",
    rewrites: [
      ['"../loop/run-context.mjs"', '"./_run-context.mjs"'],
      ['"../loop/bash-command-classify.mjs"', '"./_bash-command-classify.mjs"'],
      ['"../loop/worktree-guard.mjs"', '"./_worktree-guard.mjs"'],
    ],
  },
  // main-checkout fast-forward support shared by the Pi and Claude post-merge hooks.
  { source: "packages/core/src/loop/worktree-guard.mjs", target: ".claude/hooks/_worktree-guard.mjs", rewrites: [] },
  { source: "packages/core/src/loop/main-checkout-ff.mjs", target: ".claude/hooks/_main-checkout-ff.mjs", rewrites: [] },
];

/** Marker that identifies a generated hook-bundle module (a JS comment, distinct from the
 * markdown `<!-- GENERATED -->` banner used by generated skills/agents/docs). Used both to
 * stamp generated bundle modules and to scope orphan detection to them within `.claude/hooks/`. */
const HOOK_BUNDLE_BANNER_PREFIX = "// GENERATED from ";

/** Collect the vendored self-contained hook bundle modules. */
function collectHookBundle(repoRoot) {
  const out = [];
  for (const { source, target, rewrites } of HOOK_BUNDLE) {
    const abs = path.join(repoRoot, source);
    if (!fs.existsSync(abs)) continue; // no-op when core sources are absent (e.g. consumer tree)
    let body = fs.readFileSync(abs, "utf8");
    for (const [from, to] of rewrites) body = body.split(from).join(to);
    const banner = `${HOOK_BUNDLE_BANNER_PREFIX}${source} by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.\n`;
    out.push({ target, content: banner + body });
  }
  return out;
}

/**
 * Recursively collect `*.md` files under a source dir as {target, content} bundle assets.
 * Bodies are passed through `stripPiOnlyBlocks` so bundled contract docs can scope Pi-runtime
 * prose out of the Claude copies via `<!-- pi-only -->` markers (a no-op for marker-free docs,
 * so the existing verbatim bundle is unchanged).
 */
function collectBundle(repoRoot, srcRel, targetRel) {
  const out = [];
  const absDir = path.join(repoRoot, srcRel);
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      out.push(...collectBundle(repoRoot, `${srcRel}/${entry.name}`, `${targetRel}/${entry.name}`));
    } else if (entry.name.endsWith(".md")) {
      out.push({
        target: `${targetRel}/${entry.name}`,
        content: stripPiOnlyBlocks(fs.readFileSync(path.join(absDir, entry.name), "utf8")),
      });
    }
  }
  return out;
}

/** Write the generated assets to disk. Returns the list of written targets. */
export function writeAssets(assets, { repoRoot = process.cwd() } = {}) {
  for (const { target, content } of assets) {
    const abs = path.join(repoRoot, target);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return assets.map((a) => a.target);
}

/** Recursively list committed files under a `.claude/` subtree (repo-relative, sorted). */
function listFilesRecursive(repoRoot, rel) {
  const out = [];
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...listFilesRecursive(repoRoot, `${rel}/${entry.name}`));
    else out.push(`${rel}/${entry.name}`);
  }
  return out;
}

/**
 * List committed generated-asset files currently on disk (repo-relative, posix separators).
 * Recurses the whole `.claude/agents` + `.claude/skills` trees so stale orphans — including
 * bundled docs/templates whose source was removed — are detected, not just SKILL.md files.
 */
function listExistingAssetFiles(repoRoot) {
  const files = [
    ...listFilesRecursive(repoRoot, ".claude/agents"),
    ...listFilesRecursive(repoRoot, ".claude/commands"),
    ...listFilesRecursive(repoRoot, ".claude/skills"),
    // `.claude/scripts/` and `.claude/node_modules/` are entirely generated (issue #2123's
    // scripts-root bundle) — nothing hand-authored lives under either, so every file there
    // participates in orphan detection directly (no banner-scoping needed, unlike `.claude/hooks/`
    // below).
    ...listFilesRecursive(repoRoot, ".claude/scripts"),
    ...listFilesRecursive(repoRoot, ".claude/node_modules"),
  ];
  // `.claude/hooks/` mixes hand-authored scripts (hooks.json, _hook-io.mjs, the three hook
  // scripts) with generated bundle modules. Only the generated ones — identified by the
  // generator banner — participate in orphan detection, so a dropped/renamed HOOK_BUNDLE entry
  // is caught without false-flagging the hand-authored files.
  for (const rel of listFilesRecursive(repoRoot, ".claude/hooks")) {
    const abs = path.join(repoRoot, rel);
    try {
      if (fs.readFileSync(abs, "utf8").startsWith(HOOK_BUNDLE_BANNER_PREFIX)) files.push(rel);
    } catch {
      // unreadable — skip
    }
  }
  // The vendored scripts-root resolver sits directly under `.claude/` (addressed at runtime as
  // `${CLAUDE_PLUGIN_ROOT}/resolve-scripts-root.mjs`), alongside hand-authored `settings.json` —
  // track it by its fixed path, same as the plugin manifest above.
  const resolverPath = ".claude/resolve-scripts-root.mjs";
  if (fs.existsSync(path.join(repoRoot, resolverPath))) files.push(resolverPath);
  return files;
}

/**
 * Compare generated assets against the committed tree. Returns drifted targets, covering both
 * missing/out-of-date generated files AND orphaned committed files no longer produced by a
 * source (e.g. after a source agent/skill is renamed or removed).
 */
export function checkAssets(assets, { repoRoot = process.cwd() } = {}) {
  const drifted = [];
  const expected = new Set(assets.map((a) => a.target));
  for (const { target, content } of assets) {
    const abs = path.join(repoRoot, target);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (current !== content) {
      drifted.push({ target, reason: current === null ? "missing" : "out-of-date" });
    }
  }
  for (const existing of listExistingAssetFiles(repoRoot)) {
    if (!expected.has(existing)) {
      drifted.push({ target: existing, reason: "orphaned" });
    }
  }
  return drifted;
}

function main(argv) {
  const check = argv.includes("--check");
  const rootIdx = argv.indexOf("--repo-root");
  let repoRoot = process.cwd();
  if (rootIdx !== -1) {
    const value = argv[rootIdx + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      process.stderr.write(JSON.stringify({ ok: false, error: "--repo-root requires a path value" }) + "\n");
      process.exit(1);
    }
    repoRoot = value;
  }

  const assets = collectGeneratedAssets({ repoRoot });

  if (check) {
    const drifted = checkAssets(assets, { repoRoot });
    if (drifted.length > 0) {
      process.stderr.write(
        JSON.stringify({ ok: false, error: "generated .claude assets are out of date", drifted }, null, 2) + "\n",
      );
      process.stderr.write("Run `node scripts/claude/generate-claude-assets.mjs` and commit the result.\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ ok: true, checked: assets.length }) + "\n");
    return;
  }

  const written = writeAssets(assets, { repoRoot });
  process.stdout.write(JSON.stringify({ ok: true, written }, null, 2) + "\n");
}

if (isDirectCliRun(import.meta.url)) {
  main(process.argv.slice(2));
}
