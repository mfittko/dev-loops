import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import extension from "../extension/index.ts";
import {
  REQUIRED_CHILD_EXTENSION_ID,
  candidatePiSubagentsRoots,
  createChildRoleGateRegistrar,
  loadRegisterRequiredChildExtensions,
  registerDevLoopsRequiredChildExtension,
} from "../extension/required-child-extensions.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const extensionEntry = path.join(repoRoot, "extension", "index.ts");

// #2582: the Pi read-only role gate is a `tool_call` handler, so it only fires when the
// dev-loops extension is loaded in the *calling* session. pi-subagents never loads ambient
// extensions into a foreground (`async: false`) child — the shipped gate fan-out shape — so
// the extension registers itself as a required child extension. Without that registration a
// real dispatched judge child ran `cat README.md` unrestricted (live smoke, PR #2634).

test("candidate roots cover the extension ancestors, the Pi npm dir, NODE_PATH and the global npm prefix", () => {
  const roots = candidatePiSubagentsRoots({
    extensionDir: path.join(repoRoot, "extension"),
    home: "/home/u",
    nodePath: `/a/node_modules${path.delimiter}/b/node_modules`,
    execPath: "/opt/node/bin/node",
  });
  assert.equal(roots[0], path.join(repoRoot, "extension", "node_modules"));
  assert.ok(roots.includes(path.join(repoRoot, "node_modules")));
  assert.ok(roots.includes(path.join("/home/u", ".pi", "agent", "npm", "node_modules")));
  assert.ok(roots.includes("/a/node_modules"));
  assert.ok(roots.includes("/b/node_modules"));
  assert.ok(roots.includes(path.join("/opt", "node", "lib", "node_modules")));
  assert.equal(new Set(roots).size, roots.length, "deduped");
  // Bounded: the walk-up stops at the filesystem root instead of scanning the tree.
  assert.ok(roots.every((root) => path.isAbsolute(root)));
});

test("the pi-subagents API resolves through the package exports map, and no root resolves to null", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-loops-required-ext-"));
  const pkgDir = path.join(root, "node_modules", "pi-subagents");
  fs.mkdirSync(path.join(pkgDir, "src", "api"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "pi-subagents", type: "module", exports: { "./required-child-extensions": "./src/api/required-child-extensions.js" } }),
  );
  fs.writeFileSync(
    path.join(pkgDir, "src", "api", "required-child-extensions.js"),
    "export function registerRequiredChildExtensions() { return { dispose() {}, fromFixtureRoot: true }; }\n",
  );
  try {
    const loaded = await loadRegisterRequiredChildExtensions({ roots: [root] });
    assert.equal(typeof loaded, "function");
    // The distinctive marker proves the subpath resolved from the requested root's exports map.
    assert.equal(loaded({ sessionId: "s", extensions: [{ id: "x", path: extensionEntry }] }).fromFixtureRoot, true);
    assert.equal(await loadRegisterRequiredChildExtensions({ roots: [] }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the registration is mandatory for every runner, and degrades to the older non-mandatory form", () => {
  const calls = [];
  const registration = registerDevLoopsRequiredChildExtension({
    register: (input) => {
      calls.push(input);
      return { dispose() {} };
    },
    sessionId: "sess-1",
    extensionPath: extensionEntry,
  });
  assert.equal(typeof registration.dispose, "function");
  assert.deepEqual(calls, [{
    sessionId: "sess-1",
    extensions: [{ id: REQUIRED_CHILD_EXTENSION_ID, path: extensionEntry }],
    requireForAllRunners: true,
  }]);

  // pi-subagents < 0.75 rejects `requireForAllRunners`; the non-mandatory form still gates
  // every native child.
  const legacy = [];
  const legacyRegistration = registerDevLoopsRequiredChildExtension({
    register: (input) => {
      legacy.push(input);
      if (input.requireForAllRunners) throw new Error("Required child extension registration accepts only sessionId, extensions, and requireForAllRunners.");
      return { dispose() {} };
    },
    sessionId: "sess-2",
    extensionPath: extensionEntry,
  });
  assert.equal(typeof legacyRegistration.dispose, "function");
  assert.deepEqual(legacy.map((input) => input.requireForAllRunners ?? null), [true, null]);

  assert.equal(registerDevLoopsRequiredChildExtension({ register: () => ({ dispose() {} }), sessionId: "", extensionPath: extensionEntry }), null);
  assert.equal(registerDevLoopsRequiredChildExtension({ register: () => ({ dispose() {} }), sessionId: "s", extensionPath: "" }), null);
  assert.equal(
    registerDevLoopsRequiredChildExtension({ register: () => { throw new Error("already registered"); }, sessionId: "s", extensionPath: extensionEntry }),
    null,
  );
});

test("the registrar is keyed per session, replaces a stale registration, and releases everything on dispose", async () => {
  const disposed = [];
  let loads = 0;
  const registrar = createChildRoleGateRegistrar({
    extensionPath: extensionEntry,
    load: async () => {
      loads += 1;
      return (input) => ({ dispose: () => disposed.push(input.sessionId) });
    },
  });

  await registrar.register(undefined);
  assert.deepEqual(registrar.registeredSessionIds(), []);
  assert.equal(loads, 0, "no session id — nothing to key the registration to");

  await registrar.register("sess-a");
  await registrar.register("sess-b");
  assert.deepEqual(registrar.registeredSessionIds(), ["sess-a", "sess-b"]);
  await registrar.register("sess-a");
  assert.deepEqual(disposed, ["sess-a"], "a repeated session_start replaces the prior handle");
  assert.deepEqual(registrar.registeredSessionIds(), ["sess-b", "sess-a"]);

  registrar.disposeAll();
  registrar.disposeAll();
  assert.deepEqual(disposed, ["sess-a", "sess-b", "sess-a"]);
  assert.deepEqual(registrar.registeredSessionIds(), []);

  const inert = createChildRoleGateRegistrar({ extensionPath: extensionEntry, load: async () => null });
  await inert.register("sess-c");
  assert.deepEqual(inert.registeredSessionIds(), [], "no pi-subagents installed — inert, not broken");
});

test("the extension registers the required child extension on session_start and disposes it on session_shutdown", async () => {
  // `session_start` also syncs packaged agents; point HOME and the session cwd at temp dirs
  // so the sync never writes the real `~/.agents` or the repo worktree.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dev-loops-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dev-loops-cwd-"));
  const priorHome = process.env.HOME;
  const calls = [];
  const disposed = [];
  const events = new Map();
  process.env.HOME = home;
  try {
    extension(
      { on: (event, handler) => events.set(event, handler), registerCommand() {}, exec: async () => ({ code: 0 }) },
      {
        loadRegisterRequiredChildExtensions: async () => (input) => {
          calls.push(input);
          return { dispose: () => disposed.push(input.sessionId) };
        },
      },
    );
    assert.ok(events.has("session_shutdown"), "the registrar must be released on session_shutdown");
    const piContext = {
      cwd,
      hasUI: false,
      ui: { notify() {}, setWidget() {}, setStatus() {} },
      sessionManager: { getSessionId: () => "parent-session" },
    };
    await events.get("session_start")({ type: "session_start" }, piContext);
    assert.deepEqual(calls, [{
      sessionId: "parent-session",
      extensions: [{ id: REQUIRED_CHILD_EXTENSION_ID, path: extensionEntry }],
      requireForAllRunners: true,
    }]);
    await events.get("session_shutdown")({ type: "session_shutdown" }, piContext);
    assert.deepEqual(disposed, ["parent-session"]);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("the extension's declared entry is the path children must load", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./extension/index.ts"]);
  assert.ok(fs.existsSync(extensionEntry));
});
