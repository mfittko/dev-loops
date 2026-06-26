import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir as fsReaddir, readFile, stat } from "node:fs/promises";

const MARKDOWN_EXTENSIONS = new Set([".md"]);
// `.github/` carries identity-bearing config (workflow YAML), not just docs. Scan it for the
// same stale-slug references so the guard's "covers `.github/**`" claim is actually true.
const GITHUB_EXTENSIONS = new Set([".md", ".yml", ".yaml"]);

import { assert, fromRepoRoot, readRepo, test } from "../imported-assets-helpers.mjs";

// #768: docs-identity guard. v0.3.0 shipped `dev-loops` / `@dev-loops/core` to npm, so the
// user-facing identity surface must consistently say `dev-loops` and must not carry stale
// `pi-dev-loops` / `@pi-dev-loops` install/identity references. Historical rename-survey
// artifacts (which intentionally record the old slug) are explicitly allow-listed.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const STALE_IDENTITY_RE = /(?:@)?pi-dev-loops/;

// Historical rename artifacts intentionally record the old slug. They must NOT be rewritten
// and must NOT trip the guard. Any genuine rename-history doc belongs here.
const HISTORICAL_ARTIFACT_ALLOWLIST = new Set([
  "docs/phase-a-repo-slug-survey.md",
]);

// Recursively collect files under `dir` whose extension is in `extensions`. A MISSING directory
// is skipped gracefully (ENOENT → empty list); any other readdir error (permissions, I/O) is
// rethrown so the guard fails loudly rather than silently under-scanning the identity surface.
async function collectFiles(dir, extensions) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await fsReaddir(abs, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(rel, extensions)));
    } else if (extensions.has(path.extname(entry.name))) {
      out.push(rel);
    }
  }
  return out;
}

test("user-facing identity surface carries no stale pi-dev-loops identity reference", async () => {
  // Each surface declares the extensions it owns: docs dirs scan Markdown, `.github/` also scans
  // workflow/config YAML. `collectFiles` already skips missing directories, so no pre-filtering is
  // needed (the previous `docDirs.filter(existingDir)` was a dead async predicate that filtered
  // nothing because it returned a Promise).
  const docDirs = [
    { dir: "skills", extensions: MARKDOWN_EXTENSIONS },
    { dir: ".github", extensions: GITHUB_EXTENSIONS },
    { dir: "docs", extensions: MARKDOWN_EXTENSIONS },
  ];
  const docFiles = (
    await Promise.all(docDirs.map(({ dir, extensions }) => collectFiles(dir, extensions)))
  ).flat();
  const rootDocs = ["README.md", "AGENTS.md", "extension/README.md"];
  for (const rel of rootDocs) {
    if (await stat(path.join(repoRoot, rel)).then(() => true).catch(() => false)) {
      docFiles.push(rel);
    }
  }

  const surface = [...new Set(docFiles)]
    .filter((rel) => !HISTORICAL_ARTIFACT_ALLOWLIST.has(rel))
    .sort();
  assert.ok(surface.length > 0, "expected to scan the user-facing doc surface");

  const offenders = [];
  for (const rel of surface) {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    if (STALE_IDENTITY_RE.test(content)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `stale pi-dev-loops identity references must be migrated to dev-loops: ${offenders.join(", ")}`,
  );

  // Guard the guard: the allow-listed historical artifact must still exist, so the exclusion
  // stays meaningful and does not silently mask a moved/renamed doc.
  for (const rel of HISTORICAL_ARTIFACT_ALLOWLIST) {
    const exists = await stat(path.join(repoRoot, rel)).then(() => true).catch(() => false);
    assert.ok(exists, `historical-artifact allowlist entry should exist: ${rel}`);
  }
});

test("CLI --help text carries no stale pi-dev-loops identity reference", () => {
  const res = spawnSync("node", [path.join(repoRoot, "cli", "index.mjs"), "--help"], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, STALE_IDENTITY_RE, "CLI --help must reference dev-loops, not pi-dev-loops");
});

test("README references installing dev-loops from npm and stays consistent with the published major", async () => {
  const readme = await readRepo("README.md");

  // Accept both the global and non-global install form.
  assert.match(readme, /npm install (-g )?dev-loops/, "README should reference `npm install dev-loops`");
  assert.match(readme, /npx dev-loops/, "README should reference `npx dev-loops`");

  // Derive the published identity/major from package.json so the guard does not rot on the
  // next bump (do NOT hard-code a major here).
  const pkg = JSON.parse(await readFile(fromRepoRoot("package.json"), "utf8"));
  assert.equal(pkg.name, "dev-loops", "package should be published as dev-loops");
  const major = pkg.version.split(".")[0];

  // If the README pins any concrete dev-loops major (e.g. `dev-loops@0`), it must agree with
  // the currently published major. Placeholder forms (`dev-loops@<version>`) are allowed and
  // do not pin a major.
  const pinnedMajors = [...readme.matchAll(/dev-loops@(\d+)/g)].map((m) => m[1]);
  for (const pinned of pinnedMajors) {
    assert.equal(
      pinned,
      major,
      `README pins dev-loops@${pinned} but the published major is ${major}`,
    );
  }
});
