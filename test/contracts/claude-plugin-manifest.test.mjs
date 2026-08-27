import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #818: the repo ships a Claude Code plugin rooted at `.claude/` (manifest at
// `.claude/.claude-plugin/plugin.json`). Empirically, `claude --plugin-dir .claude plugin
// details dev-loops` discovers the 7 generated agents + 4 generated skills and 0 hooks
// (settings.json is NOT pulled as plugin hooks). This locks the manifest + structure.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const manifestPath = path.join(repoRoot, ".claude", ".claude-plugin", "plugin.json");

test("plugin manifest is valid and names the dev-loops plugin", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, "dev-loops");
  assert.ok(typeof manifest.description === "string" && manifest.description.length > 0);
});

test("plugin manifest version is kept in sync with the root package.json version", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    manifest.version,
    pkg.version,
    "plugin.json version must match package.json version — run `node scripts/claude/generate-claude-assets.mjs` and commit the regenerated manifest",
  );
});

test("the plugin exposes exactly the expected agents + skills (locks the surface; catches collisions)", async () => {
  // Plugin root is `.claude/`, so agents/skills are discovered at `.claude/agents` + `.claude/skills`.
  // Assert the EXACT set (not >=) so an unexpected component — e.g. a future Pi/Claude collision
  // leaking extra agents/skills under `.claude/` — fails the test.
  const agents = (await readdir(path.join(repoRoot, ".claude", "agents")))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .sort();
  assert.deepEqual(agents, ["dev-loop", "developer", "docs", "fixer", "judge", "quality", "refiner", "review"]);

  // A skill is a dir containing SKILL.md. `.claude/skills/` also holds bundled shared content
  // (e.g. `docs/` from #816) which is NOT a skill — assert the exact set of SKILL-bearing dirs.
  const skillDirs = (await readdir(path.join(repoRoot, ".claude", "skills"), { withFileTypes: true })).filter((d) => d.isDirectory());
  const skills = [];
  for (const d of skillDirs) {
    if (existsSync(path.join(repoRoot, ".claude", "skills", d.name, "SKILL.md"))) skills.push(d.name);
  }
  skills.sort();
  assert.deepEqual(skills, ["copilot-pr-followup", "dev-loop", "final-approval", "local-implementation", "loop-grill", "review", "ui-review"]);
});

test("the publish files allowlist ships the plugin (not the project settings.json) and preserves Pi packaging", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  for (const entry of [".claude/.claude-plugin/", ".claude/agents/", ".claude/skills/"]) {
    assert.ok(pkg.files.includes(entry), `files allowlist must include ${entry}`);
  }
  assert.equal(pkg.files.includes(".claude/"), false, "must not ship the whole .claude/ (excludes project settings.json)");
  assert.equal(pkg.files.includes(".claude/settings.json"), false, "must not ship the project settings.json");
  // Pi packaging preserved (dual-harness) — assert the full pi.* contract.
  assert.deepEqual(pkg.pi.extensions, ["./extension/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["skills"]);
  assert.deepEqual(pkg.pi.agents, ["agents"]);
});
