// Every packages/*/src file is shipped standalone (per that package's "files"
// field) — it never ships with the monorepo's sibling packages/ or scripts/
// dirs alongside it. Any relative import that resolves OUTSIDE the package
// root works in the monorepo checkout but ERR_MODULE_NOT_FOUNDs the instant
// the package is packed, published, and installed standalone. This check is
// depth-independent: each relative specifier is resolved against its importing
// file and asserted to stay within that package's directory.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// Resolve a "files" entry to a directory name, by what it IS on disk rather than
// by a trailing slash — npm treats "scripts" and "scripts/" identically, so a
// suffix heuristic would silently drop a dir from the scan (and misreport
// imports into it), in the very check whose point is to track the live list.
async function resolveShippedDirs(files, repoRootUrl) {
  const dirs = [];
  for (const entry of files) {
    const name = entry.replace(/\/$/, "");
    if (entry.endsWith("/")) {
      dirs.push(name);
      continue;
    }
    try {
      if ((await stat(new URL(name, repoRootUrl))).isDirectory()) dirs.push(name);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // absent entry ships nothing to scan
    }
  }
  return dirs;
}

/**
 * Pure detector: every specifier in the shipped tree that would not resolve from
 * the published tarball. Returned sorted so a failure diff is reproducible
 * across filesystems (readdir order is not stable across APFS/ext4/fresh clones).
 *
 * Exported shape is `<file> -> <specifier>` strings.
 */
export async function findEscapingImports({ repoRootUrl, shippedDirs }) {
  const repoRootPath = fileURLToPath(repoRootUrl);
  const isShipped = (resolvedPath) => {
    const relative = path.relative(repoRootPath, resolvedPath);
    return shippedDirs.some((dir) => relative === dir || relative.startsWith(`${dir}${path.sep}`));
  };

  const offenders = [];
  for (const dir of shippedDirs) {
    const dirUrl = new URL(`${dir}/`, repoRootUrl);
    try {
      await stat(dirUrl);
    } catch (err) {
      if (err.code === "ENOENT") continue; // a "files" dir that isn't present is fine
      throw err;
    }
    // Deliberately NOT wrapped in an ENOENT-tolerant catch: past the dir-exists
    // check above, an ENOENT means a dangling symlink or a concurrent delete,
    // and swallowing it would silently truncate the rest of this dir's scan and
    // still pass green — fail-open in a guard whose whole job is to fire.
    for await (const fileUrl of walk(dirUrl)) {
      const filePath = fileURLToPath(fileUrl);
      if (!/\.(mjs|js|ts)$/.test(filePath)) continue;
      // node_modules is not part of the published tree and its contents are
      // resolved by npm, not by this repo's relative specifiers.
      if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;

      const contents = await readFile(fileUrl, "utf8");
      const relativeFile = path.relative(repoRootPath, filePath);
      for (const match of contents.matchAll(RELATIVE_SPECIFIER_RE)) {
        const specifier = match[1];
        if (!isShipped(fileURLToPath(new URL(specifier, fileUrl)))) {
          offenders.push(`${relativeFile} -> ${specifier}`);
        }
      }
    }
  }
  return offenders.sort();
}

// ponytail: relative specifiers only. Bare-specifier escapes (a shipped script
// importing a devDependency) are the sibling defect class, but a regex over
// source text cannot tell an import statement from the same words inside a
// string or a minified vendor bundle — catching them needs real parsing, so
// they are tracked separately rather than bolted on here.
async function rootPackageOffenders() {
  const repoRootUrl = new URL("../../", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", repoRootUrl), "utf8"));
  const shippedDirs = await resolveShippedDirs(pkg.files, repoRootUrl);
  return findEscapingImports({ repoRootUrl, shippedDirs });
}

test("root package relative imports never resolve outside the shipped files set", async () => {
  assert.deepEqual(await rootPackageOffenders(), []);
});

// The assert-empty test above cannot distinguish "nothing escapes" from "the
// detector stopped detecting" — a scan that silently degrades passes green
// forever. This pins the detector's positive behavior against a synthetic tree
// so the guard is self-validating rather than vacuous.
test("findEscapingImports flags an import leaving the shipped set and passes the legal ones", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "escaping-imports-"));
  try {
    const repoRootUrl = pathToFileURL(`${fixture}/`);
    await mkdir(path.join(fixture, "shipped", "nested"), { recursive: true });
    await mkdir(path.join(fixture, "unshipped"), { recursive: true });
    await writeFile(path.join(fixture, "unshipped", "helper.mjs"), "export const x = 1;\n");
    await writeFile(path.join(fixture, "shipped", "legal.mjs"), "export const y = 2;\n");
    await writeFile(
      path.join(fixture, "shipped", "nested", "entry.mjs"),
      [
        'import { y } from "../legal.mjs";',               // legal: stays inside shipped/
        'import path from "node:path";',                    // legal: builtin, not relative
        'import { x } from "../../unshipped/helper.mjs";',  // offender: leaves the shipped set
        'const lazy = await import("../../unshipped/helper.mjs");', // offender: dynamic form too
      ].join("\n"),
    );

    const offenders = await findEscapingImports({ repoRootUrl, shippedDirs: ["shipped"] });

    assert.deepEqual(offenders, [
      "shipped/nested/entry.mjs -> ../../unshipped/helper.mjs",
      "shipped/nested/entry.mjs -> ../../unshipped/helper.mjs",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// A shipped dir named without npm's optional trailing slash must still be
// scanned — the suffix heuristic this replaced would have silently skipped it.
test("resolveShippedDirs classifies a files entry by what it is on disk, not by a trailing slash", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "shipped-dirs-"));
  try {
    const repoRootUrl = pathToFileURL(`${fixture}/`);
    await mkdir(path.join(fixture, "withslash"), { recursive: true });
    await mkdir(path.join(fixture, "noslash"), { recursive: true });
    await writeFile(path.join(fixture, "README.md"), "# not a dir\n");

    assert.deepEqual(
      await resolveShippedDirs(["withslash/", "noslash", "README.md", "absent/"], repoRootUrl),
      ["withslash", "noslash", "absent"],
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
