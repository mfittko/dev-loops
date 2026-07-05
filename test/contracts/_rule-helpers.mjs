import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RULE_RE = /<!--\s*rule:\s*([A-Z][A-Z0-9-]*)\s*-->/g;

function readRepo(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function collectRuleDefinitions() {
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

export function assertNotRestated(id, otherDocs) {
  const ownerPath = collectRuleDefinitions().get(id)?.[0];
  assert.ok(ownerPath, `expected ${id} to be present before restatement check`);
  const owner = readRepo(ownerPath);
  const marker = new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`);
  const ownerLine = owner.split(/\r?\n/).find((line) => marker.test(line)) || "";
  const ownedText = ownerLine.replace(marker, "").replace(/`[A-Z][A-Z0-9-]*`/g, "").replace(/[|]/g, " ").replace(/\s+/g, " ").trim();
  if (ownedText.length < 24) return;
  for (const doc of otherDocs) {
    const content = readRepo(doc);
    assert.equal(content.includes(ownedText), false, `${doc} must not restate ${id}`);
  }
}
