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

import { transformAgent, transformSkill } from "@dev-loops/core/claude/asset-generation";

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

  return assets;
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

/** List committed generated-asset files currently on disk (repo-relative, posix separators). */
function listExistingAssetFiles(repoRoot) {
  const found = [];
  const agentsDir = path.join(repoRoot, ".claude", "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir)) {
      if (entry.endsWith(".md")) found.push(`.claude/agents/${entry}`);
    }
  }
  const skillsDir = path.join(repoRoot, ".claude", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      if (fs.existsSync(skillFile)) found.push(`.claude/skills/${entry.name}/SKILL.md`);
    }
  }
  return found;
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
