// The judge work order resolves cited rules from the installed package, so every `docs/` file that owns a
// registered rule the findings can cite must be in the published `files` list (issue 3092).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "bun:test";
import { ruleOwnerIndex } from "../../scripts/docs/validate-rule-ownership.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);
const files = JSON.parse(fs.readFileSync(new URL("package.json", REPO_ROOT), "utf8")).files;
const registered = new Set(JSON.parse(fs.readFileSync(new URL("skills/docs/required-rules.json", REPO_ROOT), "utf8")).requiredRules.map((r) => r.id));

test("every docs/ file that owns a registered rule is published", async () => {
  const owned = new Map();
  for (const [id, { doc }] of await ruleOwnerIndex(REPO_ROOT.pathname)) {
    if (!doc.startsWith("docs/") || !registered.has(id)) continue;
    owned.set(doc, [...(owned.get(doc) ?? []), id]);
  }
  for (const [doc, ids] of owned) assert.ok(files.includes(doc), `${doc} owns ${ids.join(", ")} and must be in package.json files`);
  assert.ok(owned.size >= 3, "the scan finds the known owner docs");
});
