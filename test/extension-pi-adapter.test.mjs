import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("pi adapter is validated and frozen via the shared factory", () => {
  const adapter = createPiExtensionAdapter(createPiDouble());
  assert.equal(typeof adapter.exec, "function");
  assert.equal(typeof adapter.on, "function");
  assert.equal(typeof adapter.registerCommand, "function");
  assert.throws(() => { adapter.exec = () => {}; }, TypeError);
});

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

// ---------------------------------------------------------------------------
// Cross-harness non-regression (#1086, #2965). The Bash-gate deny rules are ONE shared decision
// (`packages/core/src/loop/bash-gate-decisions.mjs`, decision record 0206), so the Pi surface MUST
// reach it — that is what enforces COORDINATOR-VERIFY-BOUNDARY, the merge invariant and the rest of
// the guard set on Pi (the `COORDINATOR-VERIFY-BOUNDARY` row of the cross-harness contract matrix).
//
// What stays Claude-only is the edge AROUND that seam: `decideBashGate`'s Claude extras and
// `decideCoordinatorWriteGuard` in `packages/core/src/claude/hook-decisions.mjs`, which key on
// Claude role machinery with no Pi equivalent. Asserted by SOURCE INSPECTION (not "did not throw"):
// no extension/*.ts file imports that Claude module or references the coordinator WRITE guard, and
// the shared deny seam is reached, not re-implemented per harness.
// ---------------------------------------------------------------------------
test("Pi extension surface (extension/*.ts) reaches the shared Bash-gate seam and not the Claude-only hook seam (#1086, #2082, #2965)", () => {
  const extensionDir = path.resolve(fileURLToPath(new URL("../extension", import.meta.url)));
  const files = fs.readdirSync(extensionDir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "expected at least one extension/*.ts file to inspect");

  const forbiddenPatterns = [
    /claude\/hook-decisions/, // decideBashGate's Claude-only extras and decideCoordinatorWriteGuard live here
    /decideCoordinatorWriteGuard/,
  ];

  const offenders = [];
  const seamReachers = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(extensionDir, file), "utf8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(source)) offenders.push(`${file} matches ${pattern}`);
    }
    if (/@dev-loops\/core\/loop\/bash-gate-decisions/.test(source) && /decideBashGateDeny/.test(source)) seamReachers.push(file);
  }
  assert.deepEqual(offenders, [], `Pi extension surface must not import the Claude-only hook seam or the coordinator write guard:\n${offenders.join("\n")}`);
  assert.ok(
    seamReachers.includes("readonly-role-gate.ts"),
    `the Pi tool_call handler must reach the shared deny seam (decideBashGateDeny) instead of deciding Bash gating per harness, got ${JSON.stringify(seamReachers)}`,
  );
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
