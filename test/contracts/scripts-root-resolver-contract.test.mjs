import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

// Issue #2123: pins the RUNTIME contract of the generated (vendored) resolver artifact —
// `.claude/resolve-scripts-root.mjs` — as an actual subprocess, distinct from the pure-function
// unit tests in `packages/core/test/claude-scripts-root-resolver.test.mjs`. This is what catches a
// bundling/banner regression the pure-function tests can't see (e.g. the vendored copy failing to
// parse, or losing the self-contained property).

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const resolverPath = path.join(repoRoot, ".claude", "resolve-scripts-root.mjs");
const wrapperPath = path.join(repoRoot, ".claude", "scripts", "github", "view-issue.mjs");

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("checkout-still-live: from within the dev-loops source checkout, the resolver returns <repo>/scripts", () => {
  const result = spawnSync(process.execPath, [resolverPath], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), path.join(repoRoot, "scripts"));
});

test("plugin-only-resolves: a tree exposing ONLY the generated .claude runs a representative wrapper (github/view-issue.mjs --help) from the bundle, exit 0", () => {
  // Simulate a plugin-only install: cwd OUTSIDE any dev-loops checkout (so the checkout branch
  // cannot match), CLAUDE_PLUGIN_ROOT pointing at the (real, generated) .claude tree.
  const outsideCwd = mkTmpDir("dl-plugin-only-cwd-");
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(repoRoot, ".claude") };

  const resolved = spawnSync(process.execPath, [resolverPath], { cwd: outsideCwd, env, encoding: "utf8" });
  assert.equal(resolved.status, 0);
  assert.equal(resolved.stdout.trim(), path.join(repoRoot, ".claude", "scripts"));

  const ran = spawnSync(process.execPath, [wrapperPath, "--help"], { cwd: outsideCwd, env, encoding: "utf8" });
  assert.equal(ran.status, 0, `wrapper must run from the bundle: ${ran.stderr}`);
  assert.match(ran.stdout, /view-issue\.mjs/);
});

test("hard-stop: with no checkout and no bundle, the resolver exits non-zero, names the wrapper on stderr, and never falls back to gh", () => {
  const outsideCwd = mkTmpDir("dl-neither-cwd-");
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(outsideCwd, "nonexistent-plugin-root") };

  const result = spawnSync(process.execPath, [resolverPath, "github/view-issue.mjs"], { cwd: outsideCwd, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const stderr = JSON.parse(result.stderr);
  assert.equal(stderr.ok, false);
  assert.match(stderr.error, /github\/view-issue\.mjs/);
  assert.match(stderr.error, /no live dev-loops source checkout/);
  assert.match(stderr.error, /no bundled scripts/);
  // No gh fallback: the resolver has no such branch at all (asserted structurally against the
  // vendored artifact itself, not just the source).
  const source = fs.readFileSync(resolverPath, "utf8");
  assert.equal(/\bgh\s+(issue|pr|api|run)\b/.test(source), false);
});
