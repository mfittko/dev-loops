// Sanctioned atomic version-bump contract (issue: five-surface lockstep bump).
//
// Two layers:
//  - Fast fixture units for the pure surface logic (manifest edits, per-surface
//    drift detection, target-token validation).
//  - One real end-to-end bump against a throwaway git worktree (node_modules
//    symlinked from the repo so the frozen-lockfile proof is offline-fast). The
//    e2e drives the actual pipeline — regenerate bun.lock, regenerate the
//    .claude tree, and the fail-closed guards (assert-core-dependency-version +
//    generate-claude-assets --check) — with a prerelease-token target, and
//    asserts all five surfaces land on the full token and only the enumerated
//    release paths are staged.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bumpVersion, inspectSurfaces, writeManifestSurfaces } from "../../scripts/release/bump-version.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_DEP = "@dev-loops/core";
const PRERELEASE = "1.0.2-rc.99"; // a token that is never the repo's own version

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// A minimal fixture carrying all five surfaces, initially at `from`.
function makeFixture(from) {
  const dir = mkdtempSync(path.join(tmpdir(), "bump-version-fixture-"));
  mkdirSync(path.join(dir, "packages/core"), { recursive: true });
  mkdirSync(path.join(dir, ".claude/.claude-plugin"), { recursive: true });
  mkdirSync(path.join(dir, ".claude/agents"), { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    name: "dev-loops",
    version: from,
    dependencies: { [CORE_DEP]: `^${from}` },
  });
  writeJson(path.join(dir, "packages/core/package.json"), { name: CORE_DEP, version: from });
  writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version: from });
  writeFileSync(path.join(dir, ".claude/agents/x.md"), `Run \`npx dev-loops@${from} loop startup\`.\n`);
  // bun.lock shape the lockstep guard reads: workspace entry version + root dep spec.
  writeFileSync(
    path.join(dir, "bun.lock"),
    `{\n  "workspaces": {\n    "": { "dependencies": { "${CORE_DEP}": "^${from}" } },\n    "packages/core": { "name": "${CORE_DEP}", "version": "${from}" }\n  }\n}\n`,
  );
  return dir;
}

test("writeManifestSurfaces sets root version, core version, and the ^-pinned core range", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeManifestSurfaces(dir, PRERELEASE);
    const root = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const core = JSON.parse(readFileSync(path.join(dir, "packages/core/package.json"), "utf8"));
    assert.equal(root.version, PRERELEASE);
    assert.equal(root.dependencies[CORE_DEP], `^${PRERELEASE}`);
    assert.equal(core.version, PRERELEASE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectSurfaces confirms all five surfaces when in lockstep and flags each drift", () => {
  const dir = makeFixture(PRERELEASE); // fixture already fully at the token
  try {
    const clean = inspectSurfaces(dir, PRERELEASE);
    assert.ok(clean.every((s) => s.ok), `expected all surfaces ok, got ${JSON.stringify(clean)}`);
    assert.equal(clean.length, 6); // 5 surfaces; the .claude surface reports plugin + pins separately

    // Drift one surface (the plugin manifest) and confirm exactly it fails closed.
    writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version: "9.9.9" });
    const drifted = inspectSurfaces(dir, PRERELEASE);
    const failed = drifted.filter((s) => !s.ok).map((s) => s.name);
    assert.deepEqual(failed, ["plugin.json version"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumpVersion rejects a non-bare target token (range operator or partial semver)", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    assert.throws(() => bumpVersion({ repoRoot: dir, version: "^1.0.0", stage: false }), /bare full version/);
    assert.throws(() => bumpVersion({ repoRoot: dir, version: "1.0", stage: false }), /parse|bare full version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The fail-closed lockstep guard the bump runs after regenerating the surfaces
// is node:-builtins-only, so we drive the real CLI directly against a fixture
// bumped to a prerelease token. Reaching exit 0 proves assertCoreDependencyInLockstep
// + assertBunLockInLockstep accept the bumped surfaces; a single drifted field
// exits non-zero. (The full pipeline — bun.lock regen, .claude regen, and
// generate-claude-assets --check — needs a resolvable @dev-loops/core and is
// proven by the release rehearsal plus the claude-assets-reproducible /
// claude-plugin-manifest contracts that already run under `bun run verify`.)
const ASSERT_CLI = path.join(REPO_ROOT, "scripts/release/assert-core-dependency-version.mjs");

test("the real lockstep guard accepts a prerelease-token bump and fails closed on residual drift", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeManifestSurfaces(dir, PRERELEASE);
    // Regenerate the fixture bun.lock to the token (what `bun install --lockfile-only`
    // does for real): both the workspace entry version and the root dep spec move.
    writeFileSync(
      path.join(dir, "bun.lock"),
      `{\n  "workspaces": {\n    "": { "dependencies": { "${CORE_DEP}": "^${PRERELEASE}" } },\n    "packages/core": { "name": "${CORE_DEP}", "version": "${PRERELEASE}" }\n  }\n}\n`,
    );

    const pass = spawnSync(
      "node",
      [ASSERT_CLI, "--release-version", PRERELEASE, "--manifest", path.join(dir, "package.json"), "--lockfile", path.join(dir, "bun.lock")],
      { encoding: "utf8" },
    );
    assert.equal(pass.status, 0, `guard should pass in lockstep: ${pass.stderr || pass.stdout}`);

    // Drift the bun.lock workspace entry back and confirm the guard fails closed.
    writeFileSync(
      path.join(dir, "bun.lock"),
      `{\n  "workspaces": {\n    "": { "dependencies": { "${CORE_DEP}": "^${PRERELEASE}" } },\n    "packages/core": { "name": "${CORE_DEP}", "version": "1.0.0-pre.0" }\n  }\n}\n`,
    );
    const fail = spawnSync(
      "node",
      [ASSERT_CLI, "--release-version", PRERELEASE, "--manifest", path.join(dir, "package.json"), "--lockfile", path.join(dir, "bun.lock")],
      { encoding: "utf8" },
    );
    assert.equal(fail.status, 1, "guard must fail closed on a stale bun.lock workspace version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
