// schemas/dev-loop-config.schema.json is a derived artifact extracted from the
// authoritative zod validator (FileConfigSchema in @dev-loops/core/config) by
// scripts/generate-config-schema.mjs. These contracts keep it from drifting:
// the checked-in file must match a fresh extraction, its top-level surface must
// mirror the zod schema's shape exactly, and the config layers shipped in this
// repo must actually parse under the validator the schema was extracted from.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { FileConfigSchema } from "@dev-loops/core/config";
import { generateConfigJsonSchema, renderConfigJsonSchema } from "../../scripts/generate-config-schema.mjs";

const schemaFileUrl = new URL("../../schemas/dev-loop-config.schema.json", import.meta.url);

test("checked-in JSON schema matches a fresh extraction from the zod validator", async () => {
  const checkedIn = await readFile(schemaFileUrl, "utf8");
  assert.equal(
    checkedIn,
    renderConfigJsonSchema(),
    "schemas/dev-loop-config.schema.json is stale — regenerate with `node scripts/generate-config-schema.mjs`"
  );
});

test("JSON schema top-level surface mirrors FileConfigSchema exactly", async () => {
  const jsonSchema = JSON.parse(await readFile(schemaFileUrl, "utf8"));
  assert.deepEqual(
    Object.keys(jsonSchema.properties).sort(),
    Object.keys(FileConfigSchema.shape).sort()
  );
  assert.equal(jsonSchema.additionalProperties, false);
  assert.deepEqual(jsonSchema.required, ["version"]);
  // Pin the semantic core, not the exact object — annotations like
  // description may accrete without changing what validates.
  assert.equal(jsonSchema.properties.version.type, "number");
  assert.equal(jsonSchema.properties.version.const, 1);
});

test("JS safe-integer sentinels are stripped from the generated schema", () => {
  // zod stamps ±MAX_SAFE_INTEGER bounds on every .int() field; the generator
  // strips exactly those. The drift test can't catch this regressing (both
  // sides come from the same code), so pin it against the generator directly.
  const rendered = JSON.stringify(generateConfigJsonSchema());
  assert.ok(
    !rendered.includes(String(Number.MAX_SAFE_INTEGER)),
    "generated schema leaks MAX_SAFE_INTEGER bounds"
  );
  // Real hand-authored bounds must survive the strip (refinement.fanOut max 10).
  const schema = generateConfigJsonSchema();
  assert.equal(schema.properties.refinement.properties.fanOut.maximum, 10);
});

test("shipped config layers parse under the validator the schema is extracted from", async () => {
  const layers = [
    new URL("../../packages/core/src/config/extension-defaults.yaml", import.meta.url),
    new URL("../../.devloops", import.meta.url),
  ];
  for (const url of layers) {
    const parsed = parseYaml(await readFile(url, "utf8"));
    const result = FileConfigSchema.safeParse(parsed);
    assert.ok(
      result.success,
      `${url.pathname} failed FileConfigSchema: ${result.error?.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }
});
