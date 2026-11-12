// The judge work order resolves cited rules from the installed package, so every `docs/` file that owns a
// registered rule the findings can cite must be in the published `files` list (issue 3092).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "bun:test";

const REPO_ROOT = new URL("../../", import.meta.url);
const files = JSON.parse(fs.readFileSync(new URL("package.json", REPO_ROOT), "utf8")).files;

test("owner docs of GRILL-SUBLOOP-STATE-MACHINE and STEERING-SEQ-MONOTONIC are published", () => {
  for (const [id, doc] of [["GRILL-SUBLOOP-STATE-MACHINE", "docs/refinement-grill-state-graph.md"], ["STEERING-SEQ-MONOTONIC", "docs/steering-contract.md"]]) {
    assert.match(fs.readFileSync(new URL(doc, REPO_ROOT), "utf8"), new RegExp(`<!--\\s*rule:\\s*${id}\\s*-->`), `${doc} owns ${id}`);
    assert.ok(files.includes(doc), `${doc} must be in package.json files`);
  }
});
