import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RULE_RE = /<!--\s*rule:\s*([A-Z][A-Z0-9-]*)\s*-->/g;

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

// ponytail: process-lifetime memo — test process is short-lived and the repo
// tree doesn't change mid-run, so a single walk is safe to reuse everywhere.
// Add cache invalidation if a caller mutates the scanned tree mid-run or reuses
// this across a long-lived/watch process instead of a one-shot test run.
let ruleDefinitionsCache = null;

function collectRuleDefinitions() {
  if (ruleDefinitionsCache) return ruleDefinitionsCache;
  const roots = ["skills", "agents", "commands", "docs"];
  const defs = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "tmp", "site", ".claude"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
        const text = fs.readFileSync(full, "utf8");
        for (const match of text.matchAll(RULE_RE)) {
          if (!defs.has(match[1])) defs.set(match[1], []);
          defs.get(match[1]).push(rel);
        }
      }
    }
  };
  for (const root of roots) walk(path.join(repoRoot, root));
  ruleDefinitionsCache = defs;
  return defs;
}

export function assertRulePresent(id) {
  const defs = collectRuleDefinitions();
  assert.ok(defs.has(id), `expected rule ${id} to be present`);
}

export function assertRuleOwned(id, ownerPath) {
  const defs = collectRuleDefinitions();
  assert.deepEqual(defs.get(id), [ownerPath], `expected ${id} to be owned only by ${ownerPath}`);
}

function ownedTextFrom(line, marker) {
  return line.replace(marker, "").replace(/`[A-Z][A-Z0-9-]*`/g, "").replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
}

// Exported for direct unit testing of the marker-on-its-own-line fallback,
// without needing a real repo fixture file.
export function extractOwnedText(content, id) {
  const marker = new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`);
  const lines = content.split(/\r?\n/);
  const markerLineIndex = lines.findIndex((line) => marker.test(line));
  const ownerLine = markerLineIndex === -1 ? "" : lines[markerLineIndex];
  let ownedText = ownedTextFrom(ownerLine, marker);
  // The marker may sit alone on its own line immediately above the rule
  // prose (an allowed style) — fall back to the next non-empty line so the
  // restatement check doesn't silently no-op on an empty owned text.
  if (!ownedText && markerLineIndex !== -1) {
    const nextLine = lines.slice(markerLineIndex + 1).find((line) => line.trim().length > 0) || "";
    ownedText = ownedTextFrom(nextLine, marker);
  }
  return ownedText;
}

export function assertNotRestated(id, otherDocs) {
  const ownerPath = collectRuleDefinitions().get(id)?.[0];
  assert.ok(ownerPath, `expected ${id} to be present before restatement check`);
  const ownedText = extractOwnedText(readRepo(ownerPath), id);
  if (ownedText.length < 24) return;
  for (const doc of otherDocs) {
    const content = readRepo(doc);
    assert.equal(content.includes(ownedText), false, `${doc} must not restate ${id}`);
  }
}
