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

// The same hazard one level up: the ROOT package ships only the dirs named in
// its "files" field, so a shipped file importing something outside that set
// (the classic case being a script reaching into test/) resolves fine in the
// checkout and ERR_MODULE_NOT_FOUNDs from the tarball. Asserting against the
// live "files" list rather than a hardcoded set means a future import into an
// unshipped dir is caught by this same check.
test("root package relative imports never resolve outside the shipped files set", async () => {
  const repoRootUrl = new URL("../../", import.meta.url);
  const repoRootPath = fileURLToPath(repoRootUrl);
  const { files } = JSON.parse(await readFile(new URL("package.json", repoRootUrl), "utf8"));

  // "files" entries are dirs ("scripts/") or single files ("README.md"); a
  // resolved import counts as shipped when it sits under one of the dir entries.
  const shippedDirs = files.filter((entry) => entry.endsWith("/")).map((entry) => entry.replace(/\/$/, ""));
  const isShipped = (resolvedPath) => {
    const relative = path.relative(repoRootPath, resolvedPath);
    return shippedDirs.some((dir) => relative === dir || relative.startsWith(`${dir}${path.sep}`));
  };

  const offenders = [];
  for (const dir of shippedDirs) {
    try {
      for await (const fileUrl of walk(new URL(`${dir}/`, repoRootUrl))) {
        const filePath = fileURLToPath(fileUrl);
        if (!/\.(mjs|js|ts)$/.test(filePath)) continue;
        // node_modules is not part of the published tree and its contents are
        // resolved by npm, not by this repo's relative specifiers.
        if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;

        const contents = await readFile(fileUrl, "utf8");
        for (const match of contents.matchAll(RELATIVE_SPECIFIER_RE)) {
          const specifier = match[1];
          if (!isShipped(fileURLToPath(new URL(specifier, fileUrl)))) {
            offenders.push(`${path.relative(repoRootPath, filePath)} -> ${specifier}`);
          }
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // a "files" dir that isn't present is fine
    }
  }

  assert.deepEqual(offenders, []);
});
