import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveHumanHandoffConfig,
  FileConfigSchema,
  BUILT_IN_DEFAULTS,
} from "../src/config/config.mjs";

test("resolveHumanHandoffConfig: defaults to disabled no-op when absent", () => {
  const expected = { enabled: false, candidatesFrom: [], assignees: [] };
  assert.deepEqual(resolveHumanHandoffConfig({}), expected);
  assert.deepEqual(resolveHumanHandoffConfig(null), expected);
  assert.deepEqual(resolveHumanHandoffConfig(undefined), expected);
});

test("resolveHumanHandoffConfig: disabled => sources/assignees forced empty even if present", () => {
  const out = resolveHumanHandoffConfig({
    approval: { enabled: false, candidatesFrom: ["codeowners"], assignees: ["alice"] },
  });
  assert.deepEqual(out, { enabled: false, candidatesFrom: [], assignees: [] });
});

test("resolveHumanHandoffConfig: enabled parses sources + assignees", () => {
  const out = resolveHumanHandoffConfig({
    approval: { enabled: true, candidatesFrom: ["codeowners", "recent-committers"], assignees: [" alice ", "@bob", ""] },
  });
  assert.deepEqual(out, {
    enabled: true,
    candidatesFrom: ["codeowners", "recent-committers"],
    assignees: ["alice", "bob"],
  });
});

test("resolveHumanHandoffConfig: normalizes assignees — strips @, trims, drops empties", () => {
  const out = resolveHumanHandoffConfig({
    approval: { enabled: true, assignees: ["@", "", "alice", " @bob ", "@ "] },
  });
  assert.deepEqual(out.assignees, ["alice", "bob"]);
});

test("resolveHumanHandoffConfig: enabled with no sources/assignees => empty arrays", () => {
  const out = resolveHumanHandoffConfig({ approval: { enabled: true } });
  assert.deepEqual(out, { enabled: true, candidatesFrom: [], assignees: [] });
});

test("BUILT_IN_DEFAULTS: approval is disabled", () => {
  assert.equal(BUILT_IN_DEFAULTS.approval.enabled, false);
});

test("FileConfigSchema: approval section parses", () => {
  const result = FileConfigSchema.safeParse({
    version: 1,
    approval: { enabled: true, candidatesFrom: ["codeowners"], assignees: ["alice"] },
  });
  assert.equal(result.success, true);
});

test("FileConfigSchema: rejects unknown candidatesFrom source", () => {
  const result = FileConfigSchema.safeParse({
    version: 1,
    approval: { candidatesFrom: ["bogus"] },
  });
  assert.equal(result.success, false);
});
