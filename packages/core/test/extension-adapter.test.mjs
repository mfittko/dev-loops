import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionHarnessAdapter } from "../src/harness/index.mjs";

test("createExtensionHarnessAdapter validates required methods", () => {
  assert.throws(
    () => createExtensionHarnessAdapter({ exec: () => {}, on: () => {} }),
    /missing required method "registerCommand"/,
  );
  assert.throws(() => createExtensionHarnessAdapter(null), /impl must be an object/);
  assert.throws(() => createExtensionHarnessAdapter("nope"), /impl must be an object/);
});

test("createExtensionHarnessAdapter freezes the returned adapter", () => {
  const adapter = createExtensionHarnessAdapter({ exec: async () => ({ code: 0 }), on: () => {}, registerCommand: () => {} });
  assert.throws(() => { adapter.exec = () => {}; }, TypeError);
});
