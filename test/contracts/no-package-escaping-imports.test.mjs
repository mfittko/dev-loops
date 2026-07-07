// Every packages/*/src file is shipped standalone (per that package's "files"
// field) — it never ships with the monorepo's sibling packages/ or scripts/
// dirs alongside it. A relative import that climbs four levels up from
// src/<dir>/ always escapes the package root (two levels up from
// src/<dir>/ is the package root itself), so any such import resolves fine in
// the monorepo checkout but ERR_MODULE_NOT_FOUNDs the instant the package is
// packed, published, and installed standalone.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const PACKAGE_ESCAPE_PATTERN = /\.\.\/\.\.\/\.\.\/\.\.\//;

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

test("packages/*/src files never contain a four-level relative import escape", async () => {
  const offenders = [];
  const packagesRoot = new URL("../../packages/", import.meta.url);

  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcUrl = new URL(`${entry.name}/src/`, packagesRoot);
    try {
      for await (const fileUrl of walk(srcUrl)) {
        const relativePath = path.relative(process.cwd(), fileUrl.pathname);
        if (!/\.(mjs|js|ts)$/.test(relativePath)) continue;

        const contents = await readFile(fileUrl, "utf8");
        if (PACKAGE_ESCAPE_PATTERN.test(contents)) {
          offenders.push(relativePath);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // no src/ dir in this package is fine
    }
  }

  assert.deepEqual(offenders, []);
});
