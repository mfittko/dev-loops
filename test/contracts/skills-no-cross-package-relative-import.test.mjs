import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #890 packaging boundary. The root `dev-loops` npm package ships `skills/` but NOT
// `packages/core/` in its `files` allowlist. Any file under `skills/` that imports core
// via a cross-package RELATIVE path (e.g. `../../../packages/core/src/...`) is broken on
// disk for npm consumers. Core must be reached through the `@dev-loops/core` package
// specifier and its `exports` map instead.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCAN_DIR = "skills";

// Detect a real ESM import (static, side-effect, or dynamic) whose specifier is a relative
// path reaching into `packages/core`. The leading relative segment and the `from`/`import`
// keyword keep prose mentions of the path in comments/strings from being false positives.
// The optional `(?:\.\/)+` prefix also catches `./..`-style equivalents (e.g.
// `"./../../packages/core/..."`) that are still relative paths but would otherwise bypass a
// detector anchored solely on a leading `..`.
const RELATIVE_CORE_STATIC_OR_SIDE_EFFECT_RE =
  /\b(?:from|import)\s+['"](?:\.\/)*\.\.[^'"]*packages\/core[^'"]*['"]/;
const RELATIVE_CORE_DYNAMIC_RE = /\bimport\(\s*['"](?:\.\/)*\.\.[^'"]*packages\/core/;

function importsCoreViaRelativePath(content) {
  return (
    RELATIVE_CORE_STATIC_OR_SIDE_EFFECT_RE.test(content) ||
    RELATIVE_CORE_DYNAMIC_RE.test(content)
  );
}

async function collectSourceFiles(dir) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(rel)));
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("no file under skills/ imports @dev-loops/core via a cross-package relative path", async () => {
  const files = await collectSourceFiles(SCAN_DIR);
  assert.ok(files.length > 0, "expected to scan some source files under skills/");

  const offenders = [];
  for (const rel of files) {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    if (importsCoreViaRelativePath(content)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These skills files import packages/core via a relative path; use the "@dev-loops/core" specifier instead: ${offenders.join(", ")}`,
  );
});

test("importsCoreViaRelativePath detects static, side-effect, and dynamic relative core imports without prose false positives", () => {
  assert.equal(
    importsCoreViaRelativePath('import { x } from "../../../packages/core/src/bash-exit-one.mjs";'),
    true,
  );
  assert.equal(
    importsCoreViaRelativePath("export { y } from '../../packages/core/src/loop/phase-files.mjs';"),
    true,
  );
  assert.equal(
    importsCoreViaRelativePath('import "../../../packages/core/src/foo.mjs";'),
    true,
    "side-effect import must be caught",
  );
  assert.equal(
    importsCoreViaRelativePath("await import('../../../packages/core/src/foo.mjs');"),
    true,
    "dynamic import must be caught",
  );
  // A leading `./` (or repeated `./`) before `..` is still an equivalent relative path and
  // must be caught so it cannot be used to bypass the guard.
  assert.equal(
    importsCoreViaRelativePath('import { x } from "./../../packages/core/src/x.mjs";'),
    true,
    "./..-prefixed static import must be caught",
  );
  assert.equal(
    importsCoreViaRelativePath('import "././../../packages/core/src/x.mjs";'),
    true,
    "repeated ./ prefix before .. must be caught",
  );
  assert.equal(
    importsCoreViaRelativePath("await import('./../../packages/core/src/x.mjs');"),
    true,
    "./..-prefixed dynamic import must be caught",
  );
  // The package specifier is the sanctioned form and must NOT trip the detector.
  assert.equal(
    importsCoreViaRelativePath('import { x } from "@dev-loops/core/loop/phase-files";'),
    false,
  );
  assert.equal(
    importsCoreViaRelativePath('import { x } from "@dev-loops/core/bash-exit-one";'),
    false,
  );
  // Prose mentions of the path must NOT trip the detector.
  assert.equal(
    importsCoreViaRelativePath("// see ../../../packages/core/src/loop/phase-files.mjs"),
    false,
  );
  assert.equal(
    importsCoreViaRelativePath("a doc string referencing packages/core/src in passing"),
    false,
  );
});
