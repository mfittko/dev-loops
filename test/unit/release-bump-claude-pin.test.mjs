// #2123: the Claude plugin's `.claude/package.json` dependency pin and the two first-party
// entries in the committed `.claude/package-lock.json` must stay in lockstep with the released
// `dev-loops` package version, or a plugin-only install's native auto-install resolves the wrong
// (or an unpublished) toolchain. `writeClaudePluginPin` is pure JSON surgery (no network — bump
// runs pre-publish, before the target version's tarball exists on the registry); `inspectSurfaces`
// re-asserts the lockstep and fails closed on drift.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { inspectSurfaces, writeClaudePluginPin } from "../../scripts/release/bump-version.mjs";

const CORE_DEP = "@dev-loops/core";

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function lockfile(version) {
  return `{\n  "workspaces": {\n    "": { "dependencies": { "${CORE_DEP}": "^${version}" } },\n    "packages/core": { "name": "${CORE_DEP}", "version": "${version}" }\n  }\n}\n`;
}

// A fixture carrying every surface `inspectSurfaces` reads, so `writeClaudePluginPin` can be
// exercised in isolation while `inspectSurfaces` still resolves cleanly around it.
function makeFixture(from) {
  const dir = mkdtempSync(path.join(tmpdir(), "bump-claude-pin-fixture-"));
  mkdirSync(path.join(dir, "packages/core"), { recursive: true });
  mkdirSync(path.join(dir, ".claude/.claude-plugin"), { recursive: true });
  mkdirSync(path.join(dir, ".claude/agents"), { recursive: true });
  writeJson(path.join(dir, "package.json"), { name: "dev-loops", version: from, dependencies: { [CORE_DEP]: `^${from}` } });
  writeJson(path.join(dir, "packages/core/package.json"), { name: CORE_DEP, version: from });
  writeJson(path.join(dir, ".claude/.claude-plugin/plugin.json"), { name: "dev-loops", version: from });
  writeFileSync(path.join(dir, ".claude/agents/x.md"), `Run \`npx dev-loops@${from} loop startup\`.\n`);
  writeFileSync(path.join(dir, "bun.lock"), lockfile(from));

  writeJson(path.join(dir, ".claude/package.json"), { name: "dev-loops-plugin", private: true, dependencies: { "dev-loops": from } });
  writeJson(path.join(dir, ".claude/package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { name: "dev-loops-plugin", dependencies: { "dev-loops": from } },
      "node_modules/dev-loops": {
        version: from,
        resolved: `https://registry.npmjs.org/dev-loops/-/dev-loops-${from}.tgz`,
        integrity: "sha512-stale-should-be-removed-on-bump==",
        dependencies: { "@dev-loops/core": `^${from}`, yaml: "^2.9.0" },
      },
      "node_modules/@dev-loops/core": {
        version: from,
        resolved: `https://registry.npmjs.org/@dev-loops/core/-/core-${from}.tgz`,
        integrity: "sha512-stale-should-be-removed-on-bump==",
      },
      "node_modules/yaml": {
        version: "2.9.0",
        resolved: "https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz",
        integrity: "sha512-real-third-party-hash==",
      },
    },
  });
  return dir;
}

test("writeClaudePluginPin patches the manifest pin and both first-party lock entries", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    const touched = writeClaudePluginPin(dir, "9.9.9");
    assert.deepEqual(touched, [path.join(dir, ".claude/package.json"), path.join(dir, ".claude/package-lock.json")]);

    const manifest = readJson(path.join(dir, ".claude/package.json"));
    assert.equal(manifest.dependencies["dev-loops"], "9.9.9");

    const lock = readJson(path.join(dir, ".claude/package-lock.json"));
    assert.equal(lock.packages[""].dependencies["dev-loops"], "9.9.9");

    const dl = lock.packages["node_modules/dev-loops"];
    assert.equal(dl.version, "9.9.9");
    assert.equal(dl.resolved, "https://registry.npmjs.org/dev-loops/-/dev-loops-9.9.9.tgz");
    assert.equal("integrity" in dl, false);
    assert.equal(dl.dependencies["@dev-loops/core"], "^9.9.9");

    const core = lock.packages["node_modules/@dev-loops/core"];
    assert.equal(core.version, "9.9.9");
    assert.equal(core.resolved, "https://registry.npmjs.org/@dev-loops/core/-/core-9.9.9.tgz");
    assert.equal("integrity" in core, false);

    // The rest of the transitive tree is left byte-stable.
    const yaml = lock.packages["node_modules/yaml"];
    assert.equal(yaml.version, "2.9.0");
    assert.equal(yaml.integrity, "sha512-real-third-party-hash==");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudePluginPin is idempotent on a re-run at the same target", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeClaudePluginPin(dir, "9.9.9");
    const once = readFileSync(path.join(dir, ".claude/package-lock.json"), "utf8");
    writeClaudePluginPin(dir, "9.9.9");
    const twice = readFileSync(path.join(dir, ".claude/package-lock.json"), "utf8");
    assert.equal(twice, once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudePluginPin fails closed when the manifest has no dev-loops dependency", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeJson(path.join(dir, ".claude/package.json"), { name: "dev-loops-plugin", private: true, dependencies: {} });
    assert.throws(() => writeClaudePluginPin(dir, "9.9.9"), /dev-loops dependency/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeClaudePluginPin fails closed when the lock is missing a first-party entry", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    const lock = readJson(path.join(dir, ".claude/package-lock.json"));
    delete lock.packages["node_modules/@dev-loops/core"];
    writeJson(path.join(dir, ".claude/package-lock.json"), lock);
    assert.throws(() => writeClaudePluginPin(dir, "9.9.9"), /node_modules\/@dev-loops\/core/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectSurfaces reports the three new rows ok:true after a lockstep bump", () => {
  const dir = makeFixture("1.0.0-pre.0");
  try {
    writeClaudePluginPin(dir, "9.9.9"); // exercises the real write path, not a hand-tuned fixture
    const surfaces = inspectSurfaces(dir, "9.9.9");
    const byName = Object.fromEntries(surfaces.map((s) => [s.name, s]));
    assert.equal(byName[".claude plugin dev-loops pin"].ok, true);
    assert.equal(byName[".claude lockfile dev-loops"].ok, true);
    assert.equal(byName[".claude lockfile @dev-loops/core"].ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectSurfaces flags drift when the plugin pin is stale (the target version's own bump wasn't applied)", () => {
  const dir = makeFixture("1.0.0-pre.0"); // pin left at the OLD version; inspect against the NEW target
  try {
    const surfaces = inspectSurfaces(dir, "9.9.9");
    const drifted = surfaces.filter((s) => !s.ok).map((s) => s.name);
    assert.ok(drifted.includes(".claude plugin dev-loops pin"), JSON.stringify(drifted));
    assert.ok(drifted.includes(".claude lockfile dev-loops"), JSON.stringify(drifted));
    assert.ok(drifted.includes(".claude lockfile @dev-loops/core"), JSON.stringify(drifted));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
