import test from "node:test";
import assert from "node:assert/strict";

import { createPiExtensionAdapter, toHarnessContext } from "../extension/pi-extension-adapter.ts";

function createPiDouble() {
  const events = new Map();
  const commands = new Map();
  const execCalls = [];
  return {
    async exec(tool, args, opts) {
      execCalls.push({ tool, args, opts });
      return { code: 0, stdout: "out", stderr: "", killed: false };
    },
    on(event, handler) {
      events.set(event, handler);
    },
    registerCommand(name, config) {
      commands.set(name, config);
    },
    events,
    commands,
    execCalls,
  };
}

test("pi adapter exec maps a command string to pi.exec('bash', ['-lc', cmd], opts)", async () => {
  const pi = createPiDouble();
  const adapter = createPiExtensionAdapter(pi);
  const result = await adapter.exec("echo hi", { cwd: "/w", timeout: 1234 });

  assert.deepEqual(result, { code: 0, stdout: "out", stderr: "", killed: false });
  assert.deepEqual(pi.execCalls[0], {
    tool: "bash",
    args: ["-lc", "echo hi"],
    opts: { cwd: "/w", timeout: 1234 },
  });
});

test("pi adapter on(...) forwards to pi.on and maps ctx to a HarnessContext", async () => {
  const pi = createPiDouble();
  const adapter = createPiExtensionAdapter(pi);

  let seen = null;
  adapter.on("session_start", (event, ctx) => {
    seen = { event, ctx };
    ctx.ui.setStatus("dev-loops", undefined);
  });

  const statuses = [];
  const piCtx = { cwd: "/repo", hasUI: true, ui: { setStatus: (k, t) => statuses.push({ k, t }) } };
  await pi.events.get("session_start")({ kind: "session_start" }, piCtx);

  assert.deepEqual(seen.event, { kind: "session_start" });
  assert.equal(seen.ctx.cwd, "/repo");
  assert.equal(seen.ctx.hasUI, true);
  assert.deepEqual(statuses, [{ k: "dev-loops", t: undefined }]);
});

test("pi adapter user_bash handler return value propagates back through pi.on", async () => {
  const pi = createPiDouble();
  const adapter = createPiExtensionAdapter(pi);

  adapter.on("user_bash", async () => ({ result: { output: "blocked", exitCode: 1 } }));

  const piCtx = { cwd: "/repo", hasUI: false, ui: {} };
  const returned = await pi.events.get("user_bash")({ command: "gh pr ready", cwd: "/repo" }, piCtx);
  assert.deepEqual(returned, { result: { output: "blocked", exitCode: 1 } });
});

test("pi adapter registerCommand forwards name/description and wraps the handler", async () => {
  const pi = createPiDouble();
  const adapter = createPiExtensionAdapter(pi);

  let received = null;
  adapter.registerCommand("dev-loops", {
    description: "desc",
    handler: (args, ctx) => {
      received = { args, hasUI: ctx.hasUI };
      ctx.ui.notify("hello", "info");
    },
  });

  const registered = pi.commands.get("dev-loops");
  assert.equal(registered.description, "desc");

  const notes = [];
  await registered.handler("status", { cwd: "/r", hasUI: true, ui: { notify: (m, l) => notes.push({ m, l }) } });
  assert.deepEqual(received, { args: "status", hasUI: true });
  assert.deepEqual(notes, [{ m: "hello", l: "info" }]);
});

test("toHarnessContext tolerates a missing ui/cwd and never throws", () => {
  const ctx = toHarnessContext(undefined);
  assert.equal(typeof ctx.cwd, "string");
  assert.equal(ctx.hasUI, false);
  // No UI present — calls must be safe no-ops.
  ctx.ui.notify("x");
  ctx.ui.setWidget("k", ["l"]);
  ctx.ui.setStatus("k", "t");
});
