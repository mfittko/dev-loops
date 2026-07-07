// Every packages/*/src file is shipped standalone (per that package's "files"
// field) — it never ships with the monorepo's sibling packages/ or scripts/
// dirs alongside it. Any relative import that resolves OUTSIDE the package
// root works in the monorepo checkout but ERR_MODULE_NOT_FOUNDs the instant
// the package is packed, published, and installed standalone. This check is
// depth-independent: each relative specifier is resolved against its importing
// file and asserted to stay within that package's directory.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Static import/export-from, dynamic import(), and side-effect import relative specifiers.
const RELATIVE_SPECIFIER_RE = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.\.?\/[^"']+)["']/g;

async function* walk(dirUrl) {
  for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
    const childUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      yield* walk(childUrl);
      continue;
    }
    yield childUrl;
  }
}

test("packages/*/src relative imports never resolve outside their package root", async () => {
  const offenders = [];
  const packagesRoot = new URL("../../packages/", import.meta.url);

  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRootPath = fileURLToPath(new URL(`${entry.name}/`, packagesRoot));
    const srcUrl = new URL(`${entry.name}/src/`, packagesRoot);
    try {
      for await (const fileUrl of walk(srcUrl)) {
        const relativePath = path.relative(process.cwd(), fileURLToPath(fileUrl));
        if (!/\.(mjs|js|ts)$/.test(relativePath)) continue;

        const contents = await readFile(fileUrl, "utf8");
        for (const match of contents.matchAll(RELATIVE_SPECIFIER_RE)) {
          const specifier = match[1];
          const resolved = fileURLToPath(new URL(specifier, fileUrl));
          if (path.relative(packageRootPath, resolved).startsWith("..")) {
            offenders.push(`${relativePath} -> ${specifier}`);
          }
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // no src/ dir in this package is fine
    }
  }

  assert.deepEqual(offenders, []);
});
