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
    // Probe the dir separately so the ENOENT tolerance covers only "this package
    // has no src/". Wrapping the walk itself would also swallow a dangling
    // symlink or a concurrent delete, silently truncating the scan and still
    // passing green — the fail-open shape the root-package scan below avoids.
    try {
      await stat(srcUrl);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    for await (const fileUrl of walk(srcUrl)) {
      const relativePath = path.relative(process.cwd(), fileURLToPath(fileUrl));
      if (!/\.(c|m)?(js|ts)x?$/.test(relativePath)) continue;

      const contents = await readFile(fileUrl, "utf8");
      for (const match of contents.matchAll(RELATIVE_SPECIFIER_RE)) {
        const specifier = match[1];
        const resolved = fileURLToPath(new URL(specifier, fileUrl));
        if (path.relative(packageRootPath, resolved).startsWith("..")) {
          offenders.push(`${relativePath} -> ${specifier}`);
        }
      }
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
export async function resolveShippedDirs(files, repoRootUrl) {
  const dirs = [];
  for (const entry of files) {
    // npm's "files" also accepts globs and negations. Those would stat as ENOENT
    // and be dropped, silently shrinking BOTH the walk list and the allowlist —
    // the guard would degrade toward scanning nothing and pass vacuously. Fail
    // loudly instead, so adding one is a deliberate decision.
    if (/[*?[\]{}!]/.test(entry)) {
      throw new Error(`package.json "files" entry ${JSON.stringify(entry)} uses glob syntax, which this contract cannot resolve — teach it the pattern or list the directory explicitly`);
    }
    // Normalize "./scripts" and "scripts//" to "scripts" so the entry compares
    // equal to a path.relative() result.
    const name = path.normalize(entry).replace(/[\\/]+$/, "");
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
  // "files" entries are always "/"-separated; path.relative yields "\" on win32.
  // Normalizing to "/" keeps both the membership test and the emitted offender
  // strings platform-invariant (the sort order depends on the separator too).
  const toPosix = (value) => value.split(path.sep).join("/");
  const isShipped = (resolvedPath) => {
    const relative = toPosix(path.relative(repoRootPath, resolvedPath));
    return shippedDirs.some((dir) => {
      const posixDir = toPosix(dir);
      return relative === posixDir || relative.startsWith(`${posixDir}/`);
    });
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
      if (!/\.(c|m)?(js|ts)x?$/.test(filePath)) continue;
      // node_modules is not part of the published tree and its contents are
      // resolved by npm, not by this repo's relative specifiers.
      if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;

      const contents = await readFile(fileUrl, "utf8");
      const relativeFile = toPosix(path.relative(repoRootPath, filePath));
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

// The optional peers must be loaded through a guarded dynamic import: a
// top-level `import ... from "@playwright/test"` resolves fine here (it is a
// devDependency) but breaks the module graph in a consumer install that never
// opted in. The packed-install smoke is the end-to-end proof, but it self-skips
// on registry trouble — so pin the invariant hermetically too. A closed set of
// two names needs no resolver: a static specifier is enough to flag.
const OPTIONAL_PEERS = ["@playwright/test", "@axe-core/playwright"];

// STATIC import statements only, anchored at line start — `await import("...")`
// is exactly the allowed form here, so it must not match.
const STATIC_SPECIFIER_RE = /^[ \t]*import\s+(?:[^'"]*\s+from\s+)?["']([^"']+)["']/gm;

test("shipped files never statically import an optional peer dependency", async () => {
  const repoRootUrl = new URL("../../", import.meta.url);
  const repoRootPath = fileURLToPath(repoRootUrl);
  const pkg = JSON.parse(await readFile(new URL("package.json", repoRootUrl), "utf8"));
  const shippedDirs = await resolveShippedDirs(pkg.files, repoRootUrl);

  const offenders = [];
  for (const dir of shippedDirs) {
    const dirUrl = new URL(`${dir}/`, repoRootUrl);
    try {
      await stat(dirUrl);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    for await (const fileUrl of walk(dirUrl)) {
      const filePath = fileURLToPath(fileUrl);
      if (!/\.(c|m)?(js|ts)x?$/.test(filePath)) continue;
      if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;

      const contents = await readFile(fileUrl, "utf8");
      for (const match of contents.matchAll(STATIC_SPECIFIER_RE)) {
        const specifier = match[1];
        const pkgName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (OPTIONAL_PEERS.includes(pkgName)) {
          offenders.push(`${path.relative(repoRootPath, filePath).split(path.sep).join("/")} -> ${specifier}`);
        }
      }
    }
  }

  assert.deepEqual(offenders.sort(), []);
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
    await writeFile(path.join(fixture, "unshipped", "other.mjs"), "export const o = 3;\n");
    await writeFile(
      path.join(fixture, "shipped", "legal.mjs"),
      // A SECOND file that escapes, so the expected array is not a run of
      // identical strings — that is what actually pins the documented sort
      // against readdir order. It also covers the side-effect import form.
      'import "../unshipped/other.mjs";\nexport const y = 2;\n',
    );
    await writeFile(
      path.join(fixture, "shipped", "nested", "entry.mjs"),
      [
        'import { y } from "../legal.mjs";',               // legal: stays inside shipped/
        'import path from "node:path";',                    // legal: builtin, not relative
        'import { x } from "../../unshipped/helper.mjs";',  // offender: static form
        'const lazy = await import("../../unshipped/deep.mjs");', // offender: dynamic form
      ].join("\n"),
    );

    const offenders = await findEscapingImports({ repoRootUrl, shippedDirs: ["shipped"] });

    // Sorted, and each entry distinct — a regex regression that matched one form
    // twice and the other zero times could not produce this array.
    assert.deepEqual(offenders, [
      "shipped/legal.mjs -> ../unshipped/other.mjs",
      "shipped/nested/entry.mjs -> ../../unshipped/deep.mjs",
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
      // "gone" (no slash, not on disk) reaches the ENOENT branch; "./withslash/"
      // pins the ./-prefix normalization.
      await resolveShippedDirs(["withslash/", "noslash", "README.md", "absent/", "gone", "./withslash/"], repoRootUrl),
      ["withslash", "noslash", "absent", "withslash"],
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("resolveShippedDirs refuses a glob files entry rather than silently scanning nothing", async () => {
  // A dropped glob would shrink the shipped set toward empty and the whole
  // contract would pass vacuously — the failure mode this guard exists to avoid.
  await assert.rejects(
    () => resolveShippedDirs(["scripts/**/*.mjs"], new URL("../../", import.meta.url)),
    /glob syntax/,
  );
});

test("findEscapingImports skips a shipped dir that is absent without aborting the scan", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "escaping-absent-"));
  try {
    const repoRootUrl = pathToFileURL(`${fixture}/`);
    await mkdir(path.join(fixture, "present"), { recursive: true });
    await mkdir(path.join(fixture, "outside"), { recursive: true });
    await writeFile(path.join(fixture, "outside", "helper.mjs"), "export const x = 1;\n");
    await writeFile(path.join(fixture, "present", "entry.mjs"), 'import { x } from "../outside/helper.mjs";\n');

    // "missing" does not exist: it must be skipped, and "present" must still be
    // scanned — an absent dir cannot be allowed to truncate the run.
    assert.deepEqual(
      await findEscapingImports({ repoRootUrl, shippedDirs: ["missing", "present"] }),
      ["present/entry.mjs -> ../outside/helper.mjs"],
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
