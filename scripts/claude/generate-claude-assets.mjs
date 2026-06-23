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

/** Compare generated assets against the committed tree. Returns drifted targets. */
export function checkAssets(assets, { repoRoot = process.cwd() } = {}) {
  const drifted = [];
  for (const { target, content } of assets) {
    const abs = path.join(repoRoot, target);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (current !== content) {
      drifted.push({ target, reason: current === null ? "missing" : "out-of-date" });
    }
  }
  return drifted;
}

function main(argv) {
  const check = argv.includes("--check");
  const rootIdx = argv.indexOf("--repo-root");
  const repoRoot = rootIdx !== -1 ? argv[rootIdx + 1] : process.cwd();

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
