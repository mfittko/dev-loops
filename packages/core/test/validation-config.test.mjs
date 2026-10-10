import test from "node:test";
import assert from "node:assert/strict";
import { FileConfigSchema, resolveValidationConfig } from "../src/config/config.mjs";
import { resolveTargetedValidation } from "../src/loop/validation-classify.mjs";

const parse = (validation) => FileConfigSchema.safeParse({ version: 1, validation });
const rails = [{ match: "spec/models/**", surface: "models", commands: ["bundle exec rspec {path}"] }];

test("schema accepts modes, a non-Node full command and a path map", () => {
  assert.ok(parse({ mode: "local", fullCommand: "cargo test", paths: rails }).success);
  assert.ok(parse({ mode: "ci-only" }).success);
});

test("schema rejects a malformed map, a malformed command and unknown keys", () => {
  for (const bad of [
    { mode: "never" },
    { fullCommand: "" },
    { fullCommand: "cargo test\nrm -rf /" },
    { fullCommand: 42 },
    { paths: "spec/**" },
    { paths: [{ match: "spec/**", surface: "x" }] },
    { paths: [{ match: "/abs/**", surface: "x", commands: [] }] },
    { paths: [{ match: "spec/**", surface: "x", commands: ["ok\nbad"] }] },
    { paths: [{ match: "spec/**", surface: "x", commands: [], extra: true }] },
    { command: "cargo test" },
  ]) assert.equal(parse(bad).success, false, JSON.stringify(bad));
});

test("validation resolves to ci-only when unset", () => {
  assert.deepEqual(resolveValidationConfig({ version: 1 }), { mode: "ci-only", fullCommand: null, paths: [] });
  assert.equal(resolveValidationConfig({ version: 1, validation: { mode: "local", fullCommand: "cargo test" } }).fullCommand, "cargo test");
});

test("a consumer map selects its command; unmapped, mixed and unsafe paths need full validation", () => {
  assert.deepEqual(resolveTargetedValidation(["spec/models/user_spec.rb"], rails), { profile: "targeted", commands: ["bundle exec rspec spec/models/user_spec.rb"], gateSuites: [] });
  const full = { profile: "full-repository", commands: [], gateSuites: [] };
  assert.deepEqual(resolveTargetedValidation(["app/models/user.rb"], rails), full);
  assert.deepEqual(resolveTargetedValidation(["spec/models/user_spec.rb", "app/x.rb"], rails), full);
  assert.deepEqual(resolveTargetedValidation(["spec/models/a;touch pwn_spec.rb"], rails), full);
  assert.deepEqual(resolveTargetedValidation(["spec/models/user_spec.rb"], []), full);
});
