import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { resolveScriptsRoot } from "../src/claude/scripts-root-resolver.mjs";

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- (a) live checkout wins ---

test("resolveScriptsRoot prefers a live dev-loops source checkout", () => {
  const checkout = mkTmpDir("dl-checkout-");
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "dev-loops" }));
  fs.mkdirSync(path.join(checkout, "scripts"));
  const cwd = path.join(checkout, "some", "nested", "cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const result = resolveScriptsRoot({ cwd, pluginRoot: "/nonexistent-plugin-root" });
  assert.deepEqual(result, { ok: true, root: path.join(checkout, "scripts"), kind: "checkout" });
});

test("resolveScriptsRoot ignores a package.json that is not dev-loops, or has no scripts/ dir", () => {
  const notDevLoops = mkTmpDir("dl-not-devloops-");
  fs.writeFileSync(path.join(notDevLoops, "package.json"), JSON.stringify({ name: "some-consumer-repo" }));
  fs.mkdirSync(path.join(notDevLoops, "scripts"));

  const noScriptsDir = mkTmpDir("dl-no-scripts-dir-");
  fs.writeFileSync(path.join(noScriptsDir, "package.json"), JSON.stringify({ name: "dev-loops" }));
  // no scripts/ dir under noScriptsDir

  for (const cwd of [notDevLoops, noScriptsDir]) {
    const result = resolveScriptsRoot({ cwd, pluginRoot: "/nonexistent-plugin-root" });
    assert.equal(result.ok, false, `expected no checkout match for ${cwd}`);
  }
});

// --- (b) plugin-only resolves to the bundle when no checkout is found ---

test("resolveScriptsRoot falls back to the bundled ${CLAUDE_PLUGIN_ROOT}/scripts when no checkout is found", () => {
  const pluginRoot = mkTmpDir("dl-plugin-root-");
  fs.mkdirSync(path.join(pluginRoot, "scripts"));
  const cwd = mkTmpDir("dl-plugin-only-cwd-"); // no package.json anywhere above it up to the tmp root

  const result = resolveScriptsRoot({ cwd, pluginRoot });
  assert.deepEqual(result, { ok: true, root: path.join(pluginRoot, "scripts"), kind: "bundle" });
});

test("resolveScriptsRoot reads CLAUDE_PLUGIN_ROOT from env when pluginRoot is not passed explicitly", () => {
  const pluginRoot = mkTmpDir("dl-plugin-root-env-");
  fs.mkdirSync(path.join(pluginRoot, "scripts"));
  const cwd = mkTmpDir("dl-plugin-only-cwd-env-");

  const result = resolveScriptsRoot({ cwd, env: { CLAUDE_PLUGIN_ROOT: pluginRoot } });
  assert.deepEqual(result, { ok: true, root: path.join(pluginRoot, "scripts"), kind: "bundle" });
});

// --- (c) hard-stop: neither resolves ---

test("resolveScriptsRoot hard-stops (ok:false) when neither a checkout nor a bundle resolves, naming the wrapper", () => {
  const cwd = mkTmpDir("dl-neither-cwd-");
  const result = resolveScriptsRoot({ cwd, pluginRoot: "/nonexistent-plugin-root", wrapper: "github/view-issue.mjs" });
  assert.equal(result.ok, false);
  assert.match(result.error, /github\/view-issue\.mjs/);
  assert.match(result.error, /no live dev-loops source checkout/);
  assert.match(result.error, /no bundled scripts/);
});

test("resolveScriptsRoot hard-stops when CLAUDE_PLUGIN_ROOT is unset and no checkout resolves", () => {
  const cwd = mkTmpDir("dl-neither-unset-env-");
  const result = resolveScriptsRoot({ cwd, env: {} });
  assert.equal(result.ok, false);
});

// --- never a raw-gh fallback: the module has no such branch at all ---

test("the resolver module source contains no raw `gh` invocation / fallback branch", () => {
  const fileUrl = new URL("../src/claude/scripts-root-resolver.mjs", import.meta.url);
  const source = fs.readFileSync(fileUrl, "utf8");
  assert.equal(/\bgh\s+(issue|pr|api|run)\b/.test(source), false, "resolver must never shell out to raw gh");
  assert.equal(/execFileSync|execSync|spawnSync/.test(source), false, "resolver must never shell out at all");
});

// --- self-contained: no @dev-loops/core import (this module resolves the tree that would carry it) ---

test("the resolver module imports only node: builtins (self-contained, vendorable standalone)", () => {
  const fileUrl = new URL("../src/claude/scripts-root-resolver.mjs", import.meta.url);
  const source = fs.readFileSync(fileUrl, "utf8");
  const importSpecifiers = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(importSpecifiers.length > 0, "expected at least one import to assert against");
  for (const specifier of importSpecifiers) {
    assert.ok(specifier.startsWith("node:"), `expected a node: builtin import, got "${specifier}"`);
  }
});
