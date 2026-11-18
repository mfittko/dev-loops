// The judge work order resolves cited rules from the installed package, so every `docs/` file that owns a
// registered rule the findings can cite must be in the published `files` list (issue 3092).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { collectContractMarkdownFiles, extractRuleDefinitions } from "../../scripts/docs/validate-rule-ownership.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);
const files = JSON.parse(fs.readFileSync(new URL("package.json", REPO_ROOT), "utf8")).files;
const registered = new Set(JSON.parse(fs.readFileSync(new URL("skills/docs/required-rules.json", REPO_ROOT), "utf8")).requiredRules.map((r) => r.id));

test("every docs/ file that owns a registered rule is published", async () => {
  const repoRoot = REPO_ROOT.pathname;
  let owners = 0;
  for (const file of await collectContractMarkdownFiles(repoRoot)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    if (!rel.startsWith("docs/")) continue;
    const ids = extractRuleDefinitions(fs.readFileSync(file, "utf8"), rel).map((def) => def.id).filter((id) => registered.has(id));
    if (ids.length === 0) continue;
    owners += 1;
    assert.ok(files.includes(rel), `${rel} owns ${ids.join(", ")} and must be in package.json files`);
  }
  assert.ok(owners >= 3, "the scan finds the known owner docs");
});
