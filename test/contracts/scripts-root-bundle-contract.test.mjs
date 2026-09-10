import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";
import { scanLineText, ALLOW_MARKER } from "../../packages/core/src/security/secret-scan.mjs";

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

test("known-safe vendored zod lines (StackOverflow citation comments, compiled ZodParsedType checks) are marked secret-scan:allow", () => {
  // The generator's `markKnownSafeVendorLines` neutralizes two REVIEWED false-positive shapes
  // zod's compiled runtime currently produces for the pre-commit secret scanner (see
  // `generate-claude-assets.mjs`'s `KNOWN_SAFE_VENDOR_LINE_PATTERNS` for the full rationale) — this
  // pins that the marking actually ran (not a silent no-op).
  const assets = collectGeneratedAssets({ repoRoot });
  const zodRuntime = assets.filter((a) => a.target.startsWith(".claude/node_modules/zod/") && /\.(js|cjs)$/.test(a.target));
  assert.ok(zodRuntime.length > 0, "expected zod runtime files to be bundled");
  const markedCount = zodRuntime.reduce((n, a) => n + (a.content.match(new RegExp(`// ${ALLOW_MARKER}`, "g")) ?? []).length, 0);
  assert.ok(markedCount >= 10, `expected a substantial number of marked known-safe lines, got ${markedCount}`);
});

test("the specific zod files previously found to trip the secret scanner (v3/types.{cjs,js}, v4/core/regexes.{cjs,js}) are now fully marked (no un-marked hit remains)", () => {
  // The exact file set discovered (and reviewed) during issue #2123: every one of their flagged
  // lines was either a StackOverflow citation comment or a compiled `ZodParsedType.<kind>`
  // property-access check — both covered by `KNOWN_SAFE_VENDOR_LINE_PATTERNS`. Scoped to this
  // specific, already-characterized file set (not the whole yaml/zod tree) because a raw
  // `scanLineText` per-line re-scan does not reproduce the real scanner's diff/copy-detection
  // semantics tree-wide — see the git history of this test for the false alarm that taught us that.
  const assets = collectGeneratedAssets({ repoRoot });
  const byTarget = new Map(assets.map((a) => [a.target, a.content]));
  const previouslyFlagged = [
    ".claude/node_modules/zod/v3/types.cjs",
    ".claude/node_modules/zod/v3/types.js",
    ".claude/node_modules/zod/v4/core/regexes.cjs",
    ".claude/node_modules/zod/v4/core/regexes.js",
  ];
  const offenders = [];
  for (const target of previouslyFlagged) {
    const content = byTarget.get(target);
    assert.ok(content, `expected ${target} to be bundled`);
    for (const [index, line] of content.split("\n").entries()) {
      if (line.includes(ALLOW_MARKER)) continue;
      if (scanLineText(line).length > 0) offenders.push(`${target}:${index + 1}`);
    }
  }
  assert.deepEqual(offenders, [], `un-marked secret-scan hit(s) remain: ${offenders.join(", ")}`);
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
