#!/usr/bin/env node
/**
 * Generate the Claude Code asset tree (.claude/agents, .claude/skills) from the canonical
 * Pi sources (agents/*.agent.md, skills/<name>/SKILL.md). The sources remain the single
 * source of truth; the generated tree is committed and kept in sync by `--check` (CI/test).
 *
 * Usage:
 *   node scripts/claude/generate-claude-assets.mjs            Write the .claude tree.
 *   node scripts/claude/generate-claude-assets.mjs --check    Exit non-zero if the committed
 *                                                             tree drifts from the sources.
 *   --repo-root <path>   Override the repo root (default: cwd).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transformAgent, transformSkill, stripPiOnlyBlocks } from "@dev-loops/core/claude/asset-generation";

/**
 * Collect the generated assets as { target, content } pairs (target is repo-relative).
 * @param {{ repoRoot?: string }} [options]
 * @returns {{ target: string, content: string }[]}
 */
export function collectGeneratedAssets({ repoRoot = process.cwd() } = {}) {
  const assets = [];

  const agentsDir = path.join(repoRoot, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir).sort()) {
      if (!entry.endsWith(".agent.md")) continue;
      const source = `agents/${entry}`;
      const raw = fs.readFileSync(path.join(repoRoot, source), "utf8");
      const base = entry.slice(0, -".agent.md".length);
      assets.push({ target: `.claude/agents/${base}.md`, content: transformAgent({ source, raw }) });
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
      assets.push({ target: `.claude/skills/${entry.name}/SKILL.md`, content: transformSkill({ source, raw }) });
    }
  }

  // Bundle the shared markdown the generated skills reference via relative links so they resolve
  // inside the .claude/ tree (#816). The skills live at .claude/skills/<name>/, so:
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

  // Self-contained hook bundle (#843). The PreToolUse/PostToolUse hook scripts under
  // .claude/hooks/ ship inside the Claude plugin, which has no node_modules — so they cannot
  // import `@dev-loops/core` (it is unresolvable from the plugin cache and crashes the hook on
  // load). Vendor the pure deciders/classifiers they need as self-contained relative `_*.mjs`
  // modules generated from the canonical core sources, with cross-module imports rewritten to
  // local paths. The no-drift check keeps them in sync with packages/core/src.
  assets.push(...collectHookBundle(repoRoot));

  return assets;
}

/**
 * The core modules vendored into `.claude/hooks/` for the self-contained hook bundle (#843).
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
    ],
  },
];

/** Collect the vendored self-contained hook bundle modules (#843). */
function collectHookBundle(repoRoot) {
  const out = [];
  for (const { source, target, rewrites } of HOOK_BUNDLE) {
    const abs = path.join(repoRoot, source);
    if (!fs.existsSync(abs)) continue; // no-op when core sources are absent (e.g. consumer tree)
    let body = fs.readFileSync(abs, "utf8");
    for (const [from, to] of rewrites) body = body.split(from).join(to);
    const banner = `// GENERATED from ${source} by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.\n`;
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
  return [
    ...listFilesRecursive(repoRoot, ".claude/agents"),
    ...listFilesRecursive(repoRoot, ".claude/skills"),
  ];
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
