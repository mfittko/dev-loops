import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DevLoopConfigSchema } from "@dev-loops/core/config";

// Docs-accuracy guard for docs/ui-review-recipe-contract.md (#1122): every
// uiReview.*/worktree.* config key the recipe-contract doc names must exist in
// the shipped zod schema, and every schema leaf must be documented. This fails
// CI on doc drift in EITHER direction — a bogus documented key, or a schema key
// the doc forgot.

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DOC_PATH = path.join(REPO_ROOT, "docs", "ui-review-recipe-contract.md");

// zod v4 wrappers that carry an innerType we peel through to the core type.
const WRAPPERS = new Set(["optional", "default", "nullable", "nonoptional", "readonly", "catch"]);

/** Peel optional/default/etc. (and pipes) down to the core zod type. */
function coreType(schema) {
  let cur = schema;
  for (let i = 0; i < 30 && cur?._def; i += 1) {
    const def = cur._def;
    if (WRAPPERS.has(def.type)) {
      cur = def.innerType;
      continue;
    }
    if (def.type === "pipe") {
      cur = def.out ?? def.in;
      continue;
    }
    break;
  }
  return cur;
}

/**
 * Collect the dotted leaf-key paths under a schema. Object arrays keep an `[]`
 * marker (structural); array-of-scalar leaves drop the trailing `[]` so a key
 * reads as a plain path (`worktree.copyOnInit`, not `worktree.copyOnInit[]`).
 */
function collectKeys(schema, prefix, out) {
  const core = coreType(schema);
  const def = core?._def;
  if (!def) {
    out.add(prefix.replace(/\[\]$/, ""));
    return;
  }
  if (def.type === "object") {
    const shape = core.shape;
    for (const key of Object.keys(shape)) {
      collectKeys(shape[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (def.type === "array") {
    collectKeys(def.element, `${prefix}[]`, out);
    return;
  }
  out.add(prefix.replace(/\[\]$/, ""));
}

function schemaKeys() {
  const out = new Set();
  collectKeys(DevLoopConfigSchema.shape.uiReview, "uiReview", out);
  collectKeys(DevLoopConfigSchema.shape.worktree, "worktree", out);
  return out;
}

/** Extract the documented keys from the marked config-key-reference block. */
function documentedKeys(docText) {
  const block = docText.match(
    /<!--\s*ui-review-config-keys:start\s*-->([\s\S]*?)<!--\s*ui-review-config-keys:end\s*-->/,
  );
  assert.ok(block, "recipe doc is missing the ui-review-config-keys marker block");
  const keys = new Set();
  for (const m of block[1].matchAll(/`([A-Za-z0-9_.[\]]+)`/g)) {
    keys.add(m[1].replace(/\[\]$/, ""));
  }
  assert.ok(keys.size > 0, "recipe doc config-key block extracted no keys");
  return keys;
}

test("recipe doc config keys match the shipped uiReview/worktree schema", async () => {
  const docText = await readFile(DOC_PATH, "utf8");
  const documented = documentedKeys(docText);
  const schema = schemaKeys();

  const bogus = [...documented].filter((k) => !schema.has(k)).sort();
  const undocumented = [...schema].filter((k) => !documented.has(k)).sort();

  assert.deepEqual(
    bogus,
    [],
    `recipe doc references config keys absent from the schema: ${bogus.join(", ")}`,
  );
  assert.deepEqual(
    undocumented,
    [],
    `schema has config keys the recipe doc does not document: ${undocumented.join(", ")}`,
  );
});
