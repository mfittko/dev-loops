import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, access } from "node:fs/promises";
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
    "plugin.json version must match package.json version — bump both together",
  );
});

test("the plugin's auto-discovered components exist (generated agents + skills)", async () => {
  // Plugin root is `.claude/`, so agents/skills are discovered at `.claude/agents` + `.claude/skills`.
  const agents = (await readdir(path.join(repoRoot, ".claude", "agents"))).filter((f) => f.endsWith(".md"));
  assert.ok(agents.length >= 7, `expected >=7 plugin agents, got ${agents.length}`);

  const skillDirs = await readdir(path.join(repoRoot, ".claude", "skills"), { withFileTypes: true });
  const skills = skillDirs.filter((d) => d.isDirectory());
  assert.ok(skills.length >= 4, `expected >=4 plugin skills, got ${skills.length}`);
  for (const dir of skills) {
    await access(path.join(repoRoot, ".claude", "skills", dir.name, "SKILL.md"));
  }
});

test("the publish files allowlist ships the plugin (not the project settings.json) and preserves Pi packaging", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  for (const entry of [".claude/.claude-plugin/", ".claude/agents/", ".claude/skills/"]) {
    assert.ok(pkg.files.includes(entry), `files allowlist must include ${entry}`);
  }
  assert.equal(pkg.files.includes(".claude/"), false, "must not ship the whole .claude/ (excludes project settings.json)");
  assert.equal(pkg.files.includes(".claude/settings.json"), false, "must not ship the project settings.json");
  // Pi packaging preserved (dual-harness).
  assert.deepEqual(pkg.pi.extensions, ["./extension/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["skills"]);
});
