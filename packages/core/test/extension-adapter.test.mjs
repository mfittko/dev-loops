import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarnessAdapter,
  isExtensionHarnessAdapter,
  createClaudeExtensionAdapter,
} from "../src/harness/index.mjs";

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

test("isExtensionHarnessAdapter recognizes complete adapters", () => {
  const adapter = createClaudeExtensionAdapter();
  assert.equal(isExtensionHarnessAdapter(adapter), true);
  assert.equal(isExtensionHarnessAdapter({ exec: () => {} }), false);
  assert.equal(isExtensionHarnessAdapter(null), false);
  assert.equal(isExtensionHarnessAdapter("adapter"), false);
});

test("claude adapter exec runs a real command and normalizes success", async () => {
  const adapter = createClaudeExtensionAdapter();
  const result = await adapter.exec("printf hello");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hello");
  assert.equal(result.killed, false);
});

test("claude adapter exec normalizes a non-zero exit without throwing", async () => {
  const adapter = createClaudeExtensionAdapter();
  const result = await adapter.exec("exit 3");
  assert.equal(result.code, 3);
  assert.equal(result.killed, false);
});

test("claude adapter exec honors cwd", async () => {
  const adapter = createClaudeExtensionAdapter();
  const result = await adapter.exec("pwd", { cwd: "/tmp" });
  assert.equal(result.code, 0);
  // macOS reports /tmp as /private/tmp via pwd -P; accept either.
  assert.match(result.stdout.trim(), /\/tmp$/);
});

test("claude adapter stores lifecycle and command registrations", () => {
  const adapter = createClaudeExtensionAdapter();
  const handler = () => {};
  adapter.on("session_start", handler);
  adapter.registerCommand("dev-loops", { description: "d", handler });

  assert.equal(adapter.listeners.get("session_start"), handler);
  assert.equal(adapter.commands.get("dev-loops").handler, handler);
});

test("claude adapter context reports no UI and routes notify to a sink", () => {
  const notes = [];
  const adapter = createClaudeExtensionAdapter({ cwd: "/work", onNotify: (m, l) => notes.push([m, l]) });
  const ctx = adapter.makeContext();

  assert.equal(ctx.cwd, "/work");
  assert.equal(ctx.hasUI, false);
  ctx.ui.notify("hi", "warning");
  ctx.ui.setWidget("k", ["line"]); // no-op, should not throw
  ctx.ui.setStatus("k", "t"); // no-op, should not throw
  assert.deepEqual(notes, [["hi", "warning"]]);

  assert.equal(adapter.makeContext({ cwd: "/other" }).cwd, "/other");
});
