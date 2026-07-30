// Every packages/*/src file is shipped standalone (per that package's "files"
// field) — it never ships with the monorepo's sibling packages/ or scripts/
// dirs alongside it. Any relative import that resolves OUTSIDE the package
// root works in the monorepo checkout but ERR_MODULE_NOT_FOUNDs the instant
// the package is packed, published, and installed standalone. This check is
// depth-independent: each relative specifier is resolved against its importing
// file and asserted to stay within that package's directory.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  const packagesRoot = new URL("../../packages/", import.meta.url);
  const packageDirs = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Same scanner as the root-package check below: a package root is just another
  // "shipped set", so `findEscapingImports` answers both questions and there is
  // one implementation to keep correct rather than two that must be edited in
  // lockstep.
  const offenders = (
    await Promise.all(
      // Walk each package's src/, but allow anything inside that package root —
      // a package ships standalone, so leaving its ROOT is the defect.
      packageDirs.map((dir) =>
        findEscapingImports({ repoRootUrl: packagesRoot, shippedDirs: [`${dir}/src`], allowDirs: [dir] }),
      ),
    )
  ).flat();

  assert.deepEqual(offenders.sort(), []);
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
  // A Set: "scripts/" and "./scripts" normalize to the same dir, and walking it
  // twice would double-report every offender it finds.
  const dirs = new Set();
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
    // Stat even a trailing-slash entry: npm treats "scripts" and "scripts/" as
    // the same declaration, but a trailing slash on an entry that is actually a
    // FILE on disk is an author error — surface it here as a clear failure
    // rather than letting it walk() as a bogus dir later. An ENOENT trailing-
    // slash entry still passes through as an absent dir (unbuilt output, say) —
    // findEscapingImports already tolerates a shipped dir that isn't there yet.
    // stat inside the try, classification below it: the catch is strictly an
    // errno filter for stat, so the deliberate author-error throw can never be
    // coupled to (or later swallowed by) a widened errno filter.
    let stats = null;
    try {
      stats = await stat(new URL(name, repoRootUrl));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (stats === null) {
      if (entry.endsWith("/")) dirs.add(name); // absent dir: trust the declared trailing slash
      continue;
    }
    if (stats.isDirectory()) {
      dirs.add(name);
    } else if (entry.endsWith("/")) {
      throw new Error(`package.json "files" entry ${JSON.stringify(entry)} has a trailing slash but is a file on disk, not a directory — drop the slash to ship it as a file, or point the entry at the intended directory`);
    } // a plain (non-slash) entry that is a file ships a single file, not a dir to scan
  }
  return [...dirs];
}

/**
 * Pure detector: every specifier in the shipped tree that would not resolve from
 * the published tarball. Returned sorted so a failure diff is reproducible
 * across filesystems (readdir order is not stable across APFS/ext4/fresh clones).
 *
 * Exported shape is `<file> -> <specifier>` strings.
 */
export async function findEscapingImports({ repoRootUrl, shippedDirs, allowDirs = shippedDirs }) {
  const repoRootPath = fileURLToPath(repoRootUrl);
  // "files" entries are always "/"-separated; path.relative yields "\" on win32.
  // Normalizing to "/" keeps both the membership test and the emitted offender
  // strings platform-invariant (the sort order depends on the separator too).
  const toPosix = (value) => value.split(path.sep).join("/");
  // `shippedDirs` is what gets WALKED; `allowDirs` is where a resolved import may
  // legally land. They are the same set for the root package, and differ for a
  // workspace package, whose src/ is scanned but whose whole root is fair game.
  const isShipped = (resolvedPath) => {
    const relative = toPosix(path.relative(repoRootPath, resolvedPath));
    return allowDirs.some((dir) => {
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
// importing an undeclared package) are the sibling defect class, and the
// difference is what the answer has to be good for. A regex is adequate for a
// CLOSED membership question — "does this file import one of these two names?",
// which STATIC_SPECIFIER_RE below answers — because a miss is bounded and a
// false hit is inspectable. It is not adequate for the EXHAUSTIVE question "is
// every bare specifier here a declared dependency?", where a false hit on the
// same words inside a string or a minified vendor bundle makes the check
// unusable. That one needs real parsing, so it is tracked separately.
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
// Derived from the manifest, not hardcoded: a third optional peer added later
// is then guarded by this same check, which is the property the escaping-import
// contract above is built on.
async function readRootPackage() {
  return JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
}

function optionalPeersOf(pkg) {
  return Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name);
}

// STATIC import/re-export statements only, anchored at line start —
// `await import("...")` is exactly the allowed form here, so it must not match.
// The `export … from` branch keeps `from` MANDATORY (an optional group would
// false-positive on `export default "…"`), and it matters because this repo's
// convention is re-export shims: `export { webkit } from "@playwright/test"`
// breaks a consumer module graph identically to a top-level import.
// `import\s*` (not `\s+`) so the minified no-whitespace form
// `import{webkit}from"@playwright/test"` is caught too — a shipped dir here
// contains a minified vendor bundle. `import("x")` still cannot match: the
// optional group requires a literal `from`, and the fallback requires a quote
// immediately after `import`.
const STATIC_SPECIFIER_RE = /^[ \t]*(?:import\s*(?:[^'"]*?\bfrom\s*)?|export\s*[^'"]*?\bfrom\s*)["']([^"']+)["']/gm;

test("shipped files never statically import an optional peer dependency", async () => {
  const repoRootUrl = new URL("../../", import.meta.url);
  const repoRootPath = fileURLToPath(repoRootUrl);
  const pkg = await readRootPackage();
  const optionalPeers = optionalPeersOf(pkg);
  assert.ok(optionalPeers.length > 0, "expected at least one optional peer to guard");
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
        if (optionalPeers.includes(pkgName)) {
          offenders.push(`${path.relative(repoRootPath, filePath).split(path.sep).join("/")} -> ${specifier}`);
        }
      }
    }
  }

  assert.deepEqual(offenders.sort(), []);
});

// The guard above derives its names from the manifest, so it would go quiet if
// the declarations vanished. Pin the declarations themselves too — otherwise the
// only check that these are OPTIONAL peers (and not runtime dependencies) is the
// packed-install smoke, which self-skips on registry trouble.
test("the optional peers are declared as optional peerDependencies, not runtime dependencies", async () => {
  const pkg = await readRootPackage();
  const peers = optionalPeersOf(pkg);
  // The browser runners this repo's stages load dynamically must stay in the set.
  for (const required of ["@playwright/test", "@axe-core/playwright"]) {
    assert.ok(peers.includes(required), `${required} must be declared an optional peer`);
  }
  for (const peer of peers) {
    assert.ok(pkg.peerDependencies?.[peer], `${peer} must be declared in peerDependencies`);
    assert.equal(pkg.peerDependenciesMeta?.[peer]?.optional, true, `${peer} must be marked optional`);
    assert.ok(!pkg.dependencies?.[peer], `${peer} must not be a runtime dependency`);
  }
});

test("STATIC_SPECIFIER_RE catches every static form and no dynamic one", () => {
  const specifiers = (source) => [...source.matchAll(STATIC_SPECIFIER_RE)].map((m) => m[1]);

  // Static forms — each one breaks a consumer module graph at load time.
  assert.deepEqual(specifiers('import { webkit } from "@playwright/test";'), ["@playwright/test"]);
  assert.deepEqual(specifiers('import "@playwright/test";'), ["@playwright/test"]);
  assert.deepEqual(specifiers('import def from "@playwright/test";'), ["@playwright/test"]);
  // The re-export shim form: this repo's own harness is written this way.
  assert.deepEqual(specifiers('export { webkit } from "@playwright/test";'), ["@playwright/test"]);
  assert.deepEqual(specifiers('export * from "@playwright/test";'), ["@playwright/test"]);
  assert.deepEqual(specifiers('import {\n  webkit,\n} from "@playwright/test";'), ["@playwright/test"]);
  // The minified form, which a shipped vendor bundle can legitimately contain.
  assert.deepEqual(specifiers('import{webkit}from"@playwright/test";'), ["@playwright/test"]);

  // Dynamic forms — the sanctioned way to load an optional peer.
  assert.deepEqual(specifiers('const { webkit } = await import("@playwright/test");'), []);
  assert.deepEqual(specifiers('  importPlaywright = () => import("@playwright/test")'), []);
  // A string that merely looks like one must not match.
  assert.deepEqual(specifiers('export default "@playwright/test";'), []);
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
      // "./withslash/" normalizes onto "withslash" and is deduped, so the dir is
      // walked once rather than double-reporting every offender inside it.
      ["withslash", "noslash", "absent"],
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

// A trailing slash claims "this is a directory"; when the entry is actually a
// file on disk, that claim is wrong and must fail loudly here rather than
// surfacing later as a confusing walk() error.
test("resolveShippedDirs refuses a trailing-slash files entry that is a file on disk", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "shipped-dirs-file-"));
  try {
    const repoRootUrl = pathToFileURL(`${fixture}/`);
    await writeFile(path.join(fixture, "README.md"), "# not a dir\n");

    await assert.rejects(
      () => resolveShippedDirs(["README.md/"], repoRootUrl),
      /has a trailing slash but is a file on disk/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("findEscapingImports refuses to swallow a mid-walk ENOENT rather than truncating the scan", async () => {
  // The anti-fail-open property the dir-exists probe was scoped for: past that
  // probe, an ENOENT means a dangling symlink or a concurrent delete. Swallowing
  // it would skip the rest of the dir and still report success.
  const fixture = await mkdtemp(path.join(tmpdir(), "escaping-dangling-"));
  try {
    const repoRootUrl = pathToFileURL(`${fixture}/`);
    await mkdir(path.join(fixture, "shipped"), { recursive: true });
    // Sorts before any real file, so the walk reaches it first.
    await symlink(path.join(fixture, "nonexistent-target.mjs"), path.join(fixture, "shipped", "aaa-dangling.mjs"));
    await writeFile(path.join(fixture, "shipped", "zzz.mjs"), "export const z = 1;\n");

    await assert.rejects(
      () => findEscapingImports({ repoRootUrl, shippedDirs: ["shipped"] }),
      (err) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
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
