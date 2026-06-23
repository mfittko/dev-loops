import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CA1 (#770) import boundary: only the dedicated Pi adapter module may import
// `@earendil-works/pi-*`. Every other extension / core-harness source must talk to the
// neutral seam. peerDependencies in package.json are not source imports and are exempt.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const SCAN_DIRS = ["extension", "packages/core/src/harness"];
const ALLOWED = new Set([path.join("extension", "pi-extension-adapter.ts")]);
const PI_IMPORT_RE = /from\s+['"]@earendil-works\/pi-[^'"]+['"]|import\(['"]@earendil-works\/pi-/;

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

test("only pi-extension-adapter.ts imports @earendil-works/pi-*", async () => {
  const files = (await Promise.all(SCAN_DIRS.map(collectSourceFiles))).flat();
  assert.ok(files.length > 0, "expected to scan some source files");

  const offenders = [];
  for (const rel of files) {
    if (ALLOWED.has(rel)) continue;
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    if (PI_IMPORT_RE.test(content)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules import @earendil-works/pi-* outside the dedicated Pi adapter: ${offenders.join(", ")}`,
  );
});

test("the dedicated Pi adapter module still owns the Pi import", async () => {
  const content = await readFile(path.join(repoRoot, "extension/pi-extension-adapter.ts"), "utf8");
  assert.match(content, /@earendil-works\/pi-coding-agent/);
});
