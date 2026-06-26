import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir as fsReaddir, readFile, stat } from "node:fs/promises";

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

async function collectMarkdownFiles(dir) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await fsReaddir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdownFiles(rel)));
    } else if (entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

async function existingDir(dir) {
  return stat(path.join(repoRoot, dir)).then((s) => s.isDirectory()).catch(() => false);
}

test("user-facing identity surface carries no stale pi-dev-loops identity reference", async () => {
  const docDirs = ["skills", ".github", "docs"];
  const docFiles = (await Promise.all(docDirs.filter(existingDir).map(collectMarkdownFiles))).flat();
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
