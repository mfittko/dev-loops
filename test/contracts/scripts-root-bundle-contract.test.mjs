import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";

// Issue #2123: the Claude plugin ships only agents/commands/hooks/skills/settings.json — no
// scripts/, no packages/core, no node_modules, no dev-loops bin. Skills/commands/agents invoke
// script wrappers as `node <resolved-skill-scripts>/...` (resolved at runtime by the vendored
// `resolve-scripts-root.mjs` to a live checkout OR this bundle). This pins that the generated
// `.claude/` tree actually bundles every wrapper those sources reference, plus the runtime deps
// the wrappers import, plus the resolver itself.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** The wrapper set skills/commands/agents invoke: every `.mjs` file directly under the six
 * `scripts/` subdirectories the issue names (`github`, `loop`, `projects`, `refine`, `release`,
 * `security`). */
const WRAPPER_SUBDIRS = ["github", "loop", "projects", "refine", "release", "security"];

function wrapperScriptPaths() {
  const paths = [];
  for (const sub of WRAPPER_SUBDIRS) {
    const abs = path.join(repoRoot, "scripts", sub);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs")) paths.push(`${sub}/${entry.name}`);
    }
  }
  return paths;
}

test("every scripts/{github,loop,projects,refine,release,security}/*.mjs wrapper is bundled under .claude/scripts/", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const targets = new Set(assets.map((a) => a.target));
  const wrappers = wrapperScriptPaths();
  assert.ok(wrappers.length > 40, `expected a substantial wrapper set, got ${wrappers.length}`);
  const missing = wrappers.filter((rel) => !targets.has(`.claude/scripts/${rel}`));
  assert.deepEqual(missing, [], `every wrapper must be bundled: ${missing.join(", ")}`);
});

test("the generated .claude tree vendors the runtime deps the bundled scripts import (yaml, zod, @dev-loops/core)", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const targets = new Set(assets.map((a) => a.target));
  for (const expected of [
    ".claude/node_modules/yaml/package.json",
    ".claude/node_modules/zod/package.json",
    ".claude/node_modules/@dev-loops/core/package.json",
    ".claude/resolve-scripts-root.mjs",
  ]) {
    assert.ok(targets.has(expected), `expected generated asset ${expected}`);
  }
});

test("the vendored @dev-loops/core bundle excludes packages/core/test (bounded by its package.json files allowlist)", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const testTargets = assets
    .map((a) => a.target)
    .filter((t) => t.startsWith(".claude/node_modules/@dev-loops/core/") && t.includes("/test/"));
  assert.deepEqual(testTargets, []);
});

test("the repo's blanket node_modules/ .gitignore rule does not silently drop .claude/node_modules/ (it must actually ship, unlike a real dependency cache)", () => {
  const result = spawnSync("git", ["check-ignore", "--quiet", ".claude/node_modules/yaml/package.json"], {
    cwd: repoRoot,
  });
  // `git check-ignore --quiet` exits 1 when the path is NOT ignored (the desired outcome here) and
  // 0 when it IS ignored (which would mean the bundle never gets committed).
  assert.equal(result.status, 1, ".claude/node_modules/ must be un-ignored in .gitignore (!.claude/node_modules/)");
});

test("vendored runtime deps are bundled byte-verbatim (the generator never rewrites third-party code)", () => {
  // The bundle is a byte-reproducible mirror of the published packages; the secret scanner excludes
  // `.claude/node_modules/` outright (same posture it holds toward the real node_modules/ this
  // mirrors), so no per-line marker rewrite runs over vendored code. Pin a representative compiled
  // file against its node_modules source to prove verbatim copy (no appended markers, no edits).
  const assets = collectGeneratedAssets({ repoRoot });
  const byTarget = new Map(assets.map((a) => [a.target, a.content]));
  const sample = ".claude/node_modules/zod/v4/core/regexes.js";
  const bundled = byTarget.get(sample);
  assert.ok(bundled, `expected ${sample} to be bundled`);
  assert.equal(
    bundled.includes("secret-scan:allow"),
    false,
    "vendored code must not carry generator-appended secret-scan markers (it is copied verbatim)",
  );
  // Resolve the zod source the same way the generator does (createRequire walks up to the main
  // checkout's node_modules — a nested worktree hoists deps), then byte-compare.
  const require_ = createRequire(path.join(repoRoot, "package.json"));
  const zodRoot = path.dirname(require_.resolve("zod/package.json"));
  const source = fs.readFileSync(path.join(zodRoot, "v4/core/regexes.js"), "utf8");
  assert.equal(bundled, source, `${sample} must be a byte-verbatim copy of its node_modules source`);
});

test("the vendored resolve-scripts-root.mjs is self-contained (no @dev-loops/core import)", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const asset = assets.find((a) => a.target === ".claude/resolve-scripts-root.mjs");
  assert.ok(asset, "expected .claude/resolve-scripts-root.mjs to be generated");
  assert.equal(
    /\bfrom\s+"@dev-loops\/core/.test(asset.content),
    false,
    "the bundled resolver must not import @dev-loops/core",
  );
});
