// Every `scripts/...*.mjs` path cited anywhere in the shipped instruction
// surfaces (skills, commands, agents, the .claude mirror, and the guidance
// strings a few core scripts print) must actually be part of the published
// npm package — otherwise a consumer install hits a dangling script
// reference, or a stale global install masquerades as a tooling bug (#1481).
//
// This computes the packed file set the same way `npm pack` would, WITHOUT
// shelling out to `npm pack` (too slow for a unit-run contract test): it
// parses the root package.json `files` array and expands it against the
// worktree — directories walked recursively — plus the files npm always
// ships regardless of `files` (package.json itself). This repo ships no
// `.npmignore` (when `files` is present, npm packs exactly what it expands
// to — there is no separate ignore-pattern layer to reproduce here). The
// expansion was cross-validated once against a live `npm pack --dry-run`
// (exact match, 358 files) during review; the test itself runs offline and
// re-validating against a live pack is a manual spot-check, not a suite step.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Packed file set (pure, no `npm pack`) ──────────────────────────

const ALWAYS_EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git"]);

function walkFiles(absDir, repoRoot, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory() && ALWAYS_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const absChild = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absChild, repoRoot, out);
    } else if (entry.isFile()) {
      const relPosix = path.relative(repoRoot, absChild).split(path.sep).join("/");
      out.add(relPosix);
    }
  }
}

// Expands the root package.json `files` array against the worktree into the
// set of file paths (posix-relative to `repoRoot`) that `npm pack` would
// include. A pure filesystem walk — never shells out to npm.
function expandPackedFileSet(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const files = new Set(["package.json"]); // npm always ships package.json regardless of `files`
  for (const entry of pkg.files ?? []) {
    const absEntry = path.join(repoRoot, entry);
    if (!fs.existsSync(absEntry)) continue;
    const stat = fs.statSync(absEntry);
    if (stat.isDirectory()) {
      walkFiles(absEntry, repoRoot, files);
    } else if (stat.isFile()) {
      const relPosix = path.relative(repoRoot, absEntry).split(path.sep).join("/");
      files.add(relPosix);
    }
  }
  return files;
}

// ── Referenced-script collection ───────────────────────────────────

function walkByExt(absDir, exts, out) {
  if (!fs.existsSync(absDir)) return out;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const absChild = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (ALWAYS_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkByExt(absChild, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(absChild);
    }
  }
  return out;
}

// Matches a whole path-like token ending in `scripts/...mjs`, including any
// leading relative segments (e.g. `../dev-loop/scripts/foo.mjs`) — matching
// only the literal `scripts/[A-Za-z0-9_/.-]+\.mjs` suffix would silently
// truncate the leading `../dev-loop/` and misresolve the reference.
const SCRIPT_REFERENCE_RE = /[A-Za-z0-9_.\-/]*scripts\/[A-Za-z0-9_/.-]+\.mjs/g;

function surfaceFiles(repoRoot) {
  return [
    ...walkByExt(path.join(repoRoot, "skills"), [".md"], []),
    ...fs.readdirSync(path.join(repoRoot, "commands"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(repoRoot, "commands", name)),
    ...fs.readdirSync(path.join(repoRoot, "agents"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(repoRoot, "agents", name)),
    ...walkByExt(path.join(repoRoot, ".claude"), [".md"], []),
    path.join(repoRoot, "scripts/loop/resolve-dev-loop-startup.mjs"),
    path.join(repoRoot, "scripts/loop/build-handoff-envelope.mjs"),
    // cli/index.mjs's QUEUE_ROUTES/SUBCOMMAND_ROUTES tables are the largest
    // single set of scripts/...mjs references in the package — a mistyped or
    // unshipped route is exactly the dangling-reference symptom this contract
    // guards against, and nothing else validates those route targets.
    path.join(repoRoot, "cli/index.mjs"),
    ...walkByExt(path.join(repoRoot, "packages/core/src"), [".mjs"], []),
  ];
}

// `.claude/skills/<name>/SKILL.md` is a generated mirror of
// `skills/<name>/SKILL.md` (scripts/claude/generate-claude-assets.mjs) that
// intentionally does NOT bundle the skill's sibling `scripts/` dir. A
// relative `scripts/...` reference copied into the mirror resolves against
// the ORIGINAL skill directory it was generated from, same as the source.
function effectiveCitingDir(repoRoot, absSurfaceFile) {
  const relPosix = path.relative(repoRoot, absSurfaceFile).split(path.sep).join("/");
  const mirrorMatch = relPosix.match(/^\.claude\/skills\/([^/]+)\//);
  if (mirrorMatch) return path.join(repoRoot, "skills", mirrorMatch[1]);
  return path.dirname(absSurfaceFile);
}

function collectReferences(repoRoot) {
  const references = [];
  for (const surfaceFile of surfaceFiles(repoRoot)) {
    if (!fs.existsSync(surfaceFile)) continue;
    const content = fs.readFileSync(surfaceFile, "utf8");
    for (const match of content.matchAll(SCRIPT_REFERENCE_RE)) {
      references.push({ ref: match[0], surfaceFile });
    }
  }
  return references;
}

// Resolves a cited `scripts/...mjs` reference to the repo-relative path it
// actually names: root-relative first (how routed CLI scripts cite each
// other), then relative to the citing file's effective directory (how a
// skill cites its own sibling `scripts/` dir). Returns null if neither
// candidate exists on disk at all (a genuinely dangling reference).
function resolveReference(repoRoot, ref, surfaceFile) {
  const rootCandidate = ref;
  if (fs.existsSync(path.join(repoRoot, rootCandidate))) return rootCandidate;
  const localAbs = path.resolve(effectiveCitingDir(repoRoot, surfaceFile), ref);
  const localCandidate = path.relative(repoRoot, localAbs).split(path.sep).join("/");
  if (fs.existsSync(path.join(repoRoot, localCandidate))) return localCandidate;
  return null;
}

// Pure: given a repo root, a `{ ref, surfaceFile }` reference list, and a
// packed-file Set, returns the human-readable failure strings for any
// reference that doesn't resolve to a real, packed script. Factored out so a
// synthetic reference/packed-set pair (below) can drive it directly, proving
// the contract actually flags what it claims to.
function computeDanglingReferenceFailures(repoRoot, references, packedFiles) {
  const failures = [];
  for (const { ref, surfaceFile } of references) {
    const relSurface = path.relative(repoRoot, surfaceFile);
    const resolved = resolveReference(repoRoot, ref, surfaceFile);
    if (!resolved) {
      failures.push(`${relSurface} cites \`${ref}\` — no such script exists on disk`);
      continue;
    }
    if (!packedFiles.has(resolved)) {
      failures.push(`${relSurface} cites \`${ref}\` -> \`${resolved}\`, which exists on disk but is NOT in the packed npm file set`);
    }
  }
  return failures;
}

test("every scripts/...mjs reference in the shipped instruction surfaces is in the packed npm file set", () => {
  const packedFiles = expandPackedFileSet(REPO_ROOT);
  assert.ok(packedFiles.size > 100, `packed file set looks too small (${packedFiles.size}) — expansion likely broken`);

  const references = collectReferences(REPO_ROOT);
  assert.ok(references.length > 0, "expected at least one scripts/...mjs reference across the scanned surfaces");

  const failures = computeDanglingReferenceFailures(REPO_ROOT, references, packedFiles);

  assert.deepEqual(failures, [], `dangling/unshipped scripts/...mjs references:\n${failures.join("\n")}`);
});

// Negative self-test: proves the contract can actually FAIL, not just pass
// vacuously. A reference to a script that exists nowhere on disk must be
// flagged as dangling, and a reference to a script that exists on disk but
// is missing from the packed set must be flagged as unshipped.
test("computeDanglingReferenceFailures flags a dangling reference and an unshipped-but-on-disk reference", () => {
  const surfaceFile = path.join(REPO_ROOT, "skills/dev-loop/SKILL.md");
  const packedFiles = expandPackedFileSet(REPO_ROOT);

  const danglingFailures = computeDanglingReferenceFailures(
    REPO_ROOT,
    [{ ref: "scripts/does-not-exist-synthetic-1481.mjs", surfaceFile }],
    packedFiles,
  );
  assert.equal(danglingFailures.length, 1);
  assert.match(danglingFailures[0], /no such script exists on disk/);

  const realScript = "scripts/loop/consolidate-fanin.mjs";
  assert.ok(packedFiles.has(realScript), "fixture assumes this real script is normally packed");
  const packedFilesMissingOne = new Set(packedFiles);
  packedFilesMissingOne.delete(realScript);
  const unshippedFailures = computeDanglingReferenceFailures(
    REPO_ROOT,
    [{ ref: realScript, surfaceFile }],
    packedFilesMissingOne,
  );
  assert.equal(unshippedFailures.length, 1);
  assert.match(unshippedFailures[0], /NOT in the packed npm file set/);
});
