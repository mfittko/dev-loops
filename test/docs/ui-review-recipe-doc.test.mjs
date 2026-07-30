import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { DevLoopConfigSchema } from "@dev-loops/core/config";

// Docs-accuracy guard for skills/docs/ui-review-recipe-contract.md: every
// uiReview.*/worktree.* config key the recipe-contract doc names must exist in
// the shipped zod schema, and every schema leaf must be documented. This fails
// CI on doc drift in EITHER direction — a bogus documented key, or a schema key
// the doc forgot.

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DOC_PATH = path.join(REPO_ROOT, "skills", "docs", "ui-review-recipe-contract.md");

// zod v4 wrappers that carry an innerType we peel through to the core type.
const WRAPPERS = new Set(["optional", "default", "nullable", "nonoptional", "readonly", "catch"]);

/**
 * Peel optional/default/etc. (and pipes) down to the core zod type so the walk
 * reaches the inner object/array. In zod v4 `z.preprocess`/`.transform` both
 * become a `pipe`: preprocess parks the real schema on `.out` (its `.in` is the
 * transform), while `.transform` parks it on `.in` (its `.out` is the transform).
 * `.refine`/`.superRefine` leave `.shape` intact (no wrapper), so they need no
 * peeling. Picking the non-transform side keeps a wrapped nested object from being
 * mistaken for a leaf and silently dropping its keys.
 */
function coreType(schema) {
  let cur = schema;
  for (let i = 0; i < 30 && cur?._def; i += 1) {
    const def = cur._def;
    if (WRAPPERS.has(def.type)) {
      cur = def.innerType;
      continue;
    }
    if (def.type === "pipe") {
      cur = def.out?._def?.type === "transform" ? def.in : (def.out ?? def.in);
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

  // Anchor the count so a wrapped-then-dropped key (see below) can't pass by
  // matching a doc that dropped the same key.
  assert.equal(schema.size, 35, "expected 35 uiReview/worktree schema leaves");
});

test("collectKeys descends through effects/preprocess wrappers at nested levels", () => {
  // Wrap a nested object in preprocess (zod v4 pipe) and the whole thing in a
  // transform (pipe the other way). A walk that treated a pipe as a leaf would
  // miss inner.x/inner.y entirely.
  const schema = z
    .object({
      inner: z.preprocess((v) => v, z.object({ x: z.string(), y: z.number() })),
      flat: z.string(),
    })
    .transform((v) => v);
  const out = new Set();
  collectKeys(schema, "root", out);
  assert.deepEqual(
    [...out].sort(),
    ["root.flat", "root.inner.x", "root.inner.y"],
    "walk must descend through pipe/transform wrappers to reach nested keys",
  );
});

test("prerequisites snippet matches the runtime PLAYWRIGHT_MISSING_MESSAGE install pair", async () => {
  const { PLAYWRIGHT_MISSING_MESSAGE } = await import("../../scripts/loop/ui-review-capture.mjs");
  const doc = await readFile(DOC_PATH, "utf8");
  // The runtime stop reason names the exact default install pair; the doc's
  // default snippet must carry both commands verbatim so they cannot drift.
  for (const cmd of ["npm install --save-dev @playwright/test", "npx playwright install webkit"]) {
    assert.ok(PLAYWRIGHT_MISSING_MESSAGE.includes(cmd), `runtime message must cite: ${cmd}`);
    assert.ok(doc.includes(cmd), `doc must cite: ${cmd}`);
  }
  // Axe must NOT be part of the default pair in either surface. The doc check
  // pins the exact default line (anchored to end-of-line), so re-merging
  // "@playwright/test @axe-core/playwright" into one command fails here — a
  // bare substring check would pass on the pre-split combined command.
  assert.ok(!PLAYWRIGHT_MISSING_MESSAGE.includes("@axe-core/playwright"));
  assert.match(
    doc,
    /^npm install --save-dev @playwright\/test$/m,
    "the doc's default install line must be @playwright/test alone (axe is a separate opt-in)",
  );
});
