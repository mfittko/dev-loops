// The judge work order resolves cited rules from the installed package, so every `docs/` file that owns a
// registered rule the findings can cite must be in the published `files` list (issue 3092).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const REPO_ROOT = new URL("../../", import.meta.url);
const files = JSON.parse(fs.readFileSync(new URL("package.json", REPO_ROOT), "utf8")).files;
const registered = new Set(JSON.parse(fs.readFileSync(new URL("skills/docs/required-rules.json", REPO_ROOT), "utf8")).requiredRules.map((r) => r.id));
const MARKER_RE = /<!--\s*rule:\s*([A-Z][A-Z0-9-]*)\s*-->/g;

const markdownUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? markdownUnder(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []));

test("every docs/ file that owns a registered rule is published", () => {
  const docsRoot = new URL("docs/", REPO_ROOT).pathname;
  const repoRoot = REPO_ROOT.pathname;
  let owners = 0;
  for (const file of markdownUnder(docsRoot)) {
    const ids = [...fs.readFileSync(file, "utf8").matchAll(MARKER_RE)].map((m) => m[1]).filter((id) => registered.has(id));
    if (ids.length === 0) continue;
    owners += 1;
    const rel = path.relative(repoRoot, file);
    assert.ok(files.includes(rel), `${rel} owns ${ids.join(", ")} and must be in package.json files`);
  }
  assert.ok(owners >= 3, "the scan finds the known owner docs");
});
