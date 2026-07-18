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
  assert.ok(jsonSchema.properties.version, "schema is missing the version property");
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

// Minimal JSON Schema (draft 2020-12) matcher covering exactly the construct
// subset generateConfigJsonSchema emits (type/const/enum/oneOf/properties+
// required/items/additionalProperties/minLength) — not a general-purpose
// validator. No JSON-Schema validation library (e.g. ajv) is installed in
// this repo; this is the few-lines-not-a-dependency version scoped to what
// this generated schema actually uses, so the "does the generated schema
// really accept a real config" question can be answered directly instead of
// only by re-deriving the generator's own output (which can't catch a
// construct z.toJSONSchema itself silently drops, e.g. a preprocess branch).
function matchesSchema(schema, value) {
  if (schema.oneOf) return schema.oneOf.some((s) => matchesSchema(s, value));
  if (schema.anyOf) return schema.anyOf.some((s) => matchesSchema(s, value));
  if ("const" in schema) return value === schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  switch (schema.type) {
    case "string":
      return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "array":
      return Array.isArray(value) && (!schema.items || value.every((v) => matchesSchema(schema.items, v)));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      for (const key of schema.required ?? []) if (!(key in value)) return false;
      for (const [key, v] of Object.entries(value)) {
        const propSchema = schema.properties?.[key];
        if (propSchema) {
          if (!matchesSchema(propSchema, v)) return false;
        } else if (schema.additionalProperties === false) {
          return false;
        }
      }
      return true;
    }
    default:
      return true;
  }
}

test("generated schema accepts a bare-string angle (gates.<gate>.angles[]) — regression guard for the dropped preprocess branch", async () => {
  const schema = JSON.parse(await readFile(schemaFileUrl, "utf8"));
  for (const gate of ["draft", "preApproval", "spike"]) {
    const fixture = { version: 1, gates: { [gate]: { angles: ["scope"] } } };
    assert.ok(
      matchesSchema(schema, fixture),
      `generated schema must accept a bare-string angle for gates.${gate}.angles[] (matches zod's GateAngleEntry preprocess sugar + the shipped .devloops/extension-defaults.yaml, which both use bare strings)`
    );
  }
  // The object form must keep validating too — this guards the fix from
  // overcorrecting into accepting ONLY strings.
  assert.ok(
    matchesSchema(schema, { version: 1, gates: { draft: { angles: [{ name: "scope", mandatory: true }] } } }),
    "generated schema must still accept the full angle-object form"
  );
  // enum enforcement: the matcher must reject an out-of-enum value (guards the
  // helper from silently ignoring `enum`, which would let it false-pass).
  assert.ok(matchesSchema(schema, { version: 1, strategy: "github-first" }), "valid enum value must match");
  assert.ok(!matchesSchema(schema, { version: 1, strategy: "bogus" }), "out-of-enum strategy must NOT match");
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
