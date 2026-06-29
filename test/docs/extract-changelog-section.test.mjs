import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractChangelogSection } from "../../scripts/release/extract-changelog-section.mjs";

const scriptPath = path.resolve("scripts/release/extract-changelog-section.mjs");

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 0.5.0 - 2026-06-28

### Added

- A 0.5.0 thing.

### Fixed

- A 0.5.0 fix.

## 0.4.0 - 2026-06-20

### Added

- A 0.4.0 thing.
`;

test("extracts the section for a present version, stopping at the next heading", () => {
  const section = extractChangelogSection(CHANGELOG, "0.5.0");
  assert.match(section, /### Added/);
  assert.match(section, /A 0\.5\.0 thing\./);
  assert.match(section, /A 0\.5\.0 fix\./);
  // Stops before the next "## " heading.
  assert.doesNotMatch(section, /0\.4\.0/);
  assert.doesNotMatch(section, /^##\s/m);
});

test("handles the Unreleased-above-latest layout (does not bleed Unreleased into the version)", () => {
  const section = extractChangelogSection(CHANGELOG, "0.5.0");
  assert.doesNotMatch(section, /Unreleased/);
});

test("extracts the Unreleased section itself bounded by the next heading", () => {
  // Unreleased is empty here, so the section body is empty (but matched).
  const section = extractChangelogSection(CHANGELOG, "Unreleased");
  assert.equal(section, "");
});

test("matches a version regardless of a leading v in the heading", () => {
  const cl = "## v1.2.3 - 2026-01-01\n\n- thing\n";
  assert.match(extractChangelogSection(cl, "1.2.3"), /thing/);
});

test("does not match a version that is a prefix of another version", () => {
  const cl = "## 0.5.10 - 2026-01-01\n\n- ten\n\n## 0.5.1 - 2025-01-01\n\n- one\n";
  const section = extractChangelogSection(cl, "0.5.1");
  assert.match(section, /one/);
  assert.doesNotMatch(section, /ten/);
});

test("returns null (fail closed) for an absent version", () => {
  assert.equal(extractChangelogSection(CHANGELOG, "9.9.9"), null);
});

test("CLI prints the section and exits 0 for a present version", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "extract-changelog-"));
  try {
    const clPath = path.join(dir, "CHANGELOG.md");
    await writeFile(clPath, CHANGELOG, "utf8");
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--version", "v0.5.0", "--changelog", clPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /A 0\.5\.0 thing\./);
    assert.doesNotMatch(result.stdout, /0\.4\.0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI exits 1 (fail closed) for an absent version", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "extract-changelog-"));
  try {
    const clPath = path.join(dir, "CHANGELOG.md");
    await writeFile(clPath, CHANGELOG, "utf8");
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--version", "9.9.9", "--changelog", clPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no section found for version 9\.9\.9 in/);
    assert.match(result.stderr, new RegExp(clPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI exits 2 when --version is missing", () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--version is required/);
});

test("CLI exits 2 when a flag is missing its value", () => {
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--version", "0.5.0", "--changelog"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--changelog requires a value/);
});

test("imports only node: builtins (must run dependency-free in release.yml — #1016)", async () => {
  // release.yml runs this script with no `npm ci`, so any workspace/3rd-party
  // import (e.g. @dev-loops/core via _core-helpers.mjs) ERR_MODULE_NOT_FOUNDs
  // and the GitHub Release is never created. Guard against reintroduction.
  const source = await readFile(scriptPath, "utf8");
  // Match every module-specifier form a dependency could sneak in through:
  // `import ... from "x"`, bare `import "x"`, `export ... from "x"`, and
  // dynamic `import("x")` — not just the static `import ... from` Copilot noted.
  const importRe = /^\s*import\b[^"'\n;]*["']([^"']+)["']/gm;
  const exportFromRe = /^\s*export\b[^"'\n;]*\bfrom\s*["']([^"']+)["']/gm;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']/g;
  const specifiers = [
    ...[...source.matchAll(importRe)].map((m) => m[1]),
    ...[...source.matchAll(exportFromRe)].map((m) => m[1]),
    ...[...source.matchAll(dynamicRe)].map((m) => m[1]),
  ];
  assert.notEqual(specifiers.length, 0, "expected at least one import");
  for (const spec of specifiers) {
    assert.ok(
      spec.startsWith("node:"),
      `non-node: import "${spec}" would break the deps-free release.yml runner`,
    );
  }
});
