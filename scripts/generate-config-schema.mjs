#!/usr/bin/env node
// Generate schemas/dev-loop-config.schema.json from the authoritative zod
// validator (FileConfigSchema in @dev-loops/core/config).
//
// The JSON schema file is a derived artifact: every config layer the loader
// reads (shipped extension-defaults, repo .pi/dev-loop/defaults.*, consumer
// .devloops, legacy .pi/dev-loop/settings.*/overrides.*) is validated with
// FileConfigSchema (see applyLayer in packages/core/src/config/config.mjs),
// so the JSON schema is extracted from that schema rather than maintained by
// hand. Cross-field refinements (roleTiers alias checks, per-action step
// requirements, regex validity) are not representable in JSON Schema and are
// enforced only by the zod loader.
//
// Usage:
//   node scripts/generate-config-schema.mjs           # rewrite the schema file
//   node scripts/generate-config-schema.mjs --check   # exit 1 if the file is stale

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { FileConfigSchema } from "@dev-loops/core/config";

const SCHEMA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "dev-loop-config.schema.json"
);

/**
 * zod emits the JS safe-integer range as explicit numeric bounds on every
 * `.int()` field. Those bounds are a JS runtime artifact, not a config
 * constraint an author needs to see — drop exactly them and nothing else.
 * @param {unknown} node
 */
function stripSafeIntegerBounds(node) {
  if (Array.isArray(node)) {
    for (const item of node) stripSafeIntegerBounds(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = /** @type {Record<string, unknown>} */ (node);
  if (obj.maximum === Number.MAX_SAFE_INTEGER) delete obj.maximum;
  if (obj.minimum === -Number.MAX_SAFE_INTEGER) delete obj.minimum;
  for (const value of Object.values(obj)) stripSafeIntegerBounds(value);
}

/**
 * Build the JSON schema document from the zod file-level validator.
 * @returns {Record<string, unknown>}
 */
export function generateConfigJsonSchema() {
  const generated = z.toJSONSchema(FileConfigSchema, {
    target: "draft-2020-12",
    io: "input",
    reused: "defs",
  });
  stripSafeIntegerBounds(generated);

  const { $schema, ...body } = generated;
  return {
    $schema,
    $id: "https://github.com/mfittko/dev-loops/schemas/dev-loop-config.schema.json",
    title: "dev-loops config",
    description:
      "GENERATED FILE — do not edit by hand; regenerate with `node scripts/generate-config-schema.mjs`. " +
      "Extracted from FileConfigSchema in packages/core/src/config/config.mjs, the validator the loader " +
      "applies to every config file layer: the shipped defaults in packages/core/src/config/extension-defaults.yaml, " +
      "the repo-local .pi/dev-loop/defaults.* layer, consumer .devloops (.yaml/.yml/.json), and the legacy " +
      ".pi/dev-loop/settings.*/overrides.* fallbacks. The zod loader remains authoritative: cross-field " +
      "refinements (models.roleTiers alias resolution, uiReview step per-action requirements, regex validity) " +
      "are enforced there and cannot be expressed in JSON Schema.",
    ...body,
  };
}

/** @returns {string} */
export function renderConfigJsonSchema() {
  return `${JSON.stringify(generateConfigJsonSchema(), null, 2)}\n`;
}

async function main() {
  const rendered = renderConfigJsonSchema();
  const relative = path.relative(process.cwd(), SCHEMA_PATH);

  if (process.argv.includes("--check")) {
    let existing = null;
    try {
      existing = await readFile(SCHEMA_PATH, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (existing !== rendered) {
      console.error(
        `${relative} is stale — regenerate with \`node scripts/generate-config-schema.mjs\``
      );
      process.exit(1);
    }
    console.log(`${relative} is up to date`);
    return;
  }

  await writeFile(SCHEMA_PATH, rendered, "utf8");
  console.log(`wrote ${relative}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
