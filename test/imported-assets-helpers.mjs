import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";

const fromRepoRoot = (relativePath) => new URL(`../${relativePath}`, import.meta.url);
const readRepo = (relativePath) => readFile(fromRepoRoot(relativePath), "utf8");

const USER_FACING_AGENT_SURFACE = Object.freeze({
  "dev-loop": { kind: "workflow-entrypoint" },
});

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected frontmatter block");

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) continue;

    const [, key, rawValue] = entry;
    const value = rawValue.trim();
    if (value === "true") {
      frontmatter[key] = true;
      continue;
    }
    if (value === "false") {
      frontmatter[key] = false;
      continue;
    }
    frontmatter[key] = value.replace(/^"([\s\S]*)"$/, "$1");
  }

  return frontmatter;
}

function assertMatchesAll(content, patterns, label = "content") {
  for (const pattern of patterns) {
    assert.match(content, pattern, `${label} should match ${pattern}`);
  }
}

export {
  assert,
  assertMatchesAll,
  fromRepoRoot,
  parseFrontmatter,
  readRepo,
  readdir,
  stat,
  test,
  USER_FACING_AGENT_SURFACE,
};
