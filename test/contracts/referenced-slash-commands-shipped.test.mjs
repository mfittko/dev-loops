// A bare `/loop-*` slash command (e.g. `/loop-continue`) only resolves in the
// dev-loops source repo itself, where repo-local `.claude/commands/` defines
// it. In a consumer (plugin) install the commands are namespaced
// (`/dev-loops:loop-continue`), so any shipped skill/command/doc or emitted
// guidance string that instructs a bare `/loop-*` without also naming the
// namespaced plugin form (or the CLI) hands the consumer an un-runnable
// instruction (#1485).
//
// This contract flags a bare `/loop-<cmd>` slash reference in the shipped
// instruction surfaces unless the SAME file also carries the namespaced plugin
// spelling `/dev-loops:loop-<cmd>` — the "name both spellings" pattern the
// issue endorses. Replacing the bare reference with the CLI
// (`dev-loops loop ...`) leaves no bare token and passes trivially. The only
// allowlist is the source-repo-scoped `.claude/commands/` docs themselves,
// where the bare form is the runnable command.
//
// Sibling to `referenced-scripts-shipped.test.mjs`: it scans the same shipped
// instruction-surface set (skills, commands, agents, the .claude mirror, and
// the scripts/core sources that print guidance strings) for this new class.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { flatDir, walkByExt } from "./_walk-helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function surfaceFiles(repoRoot) {
  return [
    ...walkByExt(path.join(repoRoot, "skills"), [".md"], []),
    ...flatDir(path.join(repoRoot, "commands"), ".md", []),
    ...flatDir(path.join(repoRoot, "agents"), ".md", []),
    ...walkByExt(path.join(repoRoot, ".claude"), [".md"], []),
    ...walkByExt(path.join(repoRoot, "scripts"), [".mjs"], []),
    ...walkByExt(path.join(repoRoot, "packages", "core", "src"), [".mjs"], []),
    ...walkByExt(path.join(repoRoot, "cli"), [".mjs"], []),
  ];
}

// `.claude/commands/<name>.md` is the source-repo-local command doc where the
// bare `/loop-*` form is the runnable command itself — the one allowlisted
// surface. Generated `.claude/skills|agents/` mirrors are NOT allowlisted
// (they inherit their source's portability once regenerated).
function isAllowlisted(repoRoot, absSurfaceFile) {
  const relPosix = path.relative(repoRoot, absSurfaceFile).split(path.sep).join("/");
  return relPosix.startsWith(".claude/commands/");
}

// Matches a bare slash command `/loop-<cmd>` (cmd = lowercase letters and
// hyphens, never a trailing hyphen). The negative lookbehind excludes
// path-adjacent occurrences so a file path like
// `commands/loop-continue.command.md` or `.claude/commands/loop-continue.md`
// (where `/loop-...` is preceded by a word/path char) is NOT mistaken for an
// instruction. The namespaced form `/dev-loops:loop-continue` contains no
// `/loop-` substring at all (the `loop-continue` there follows `:`), so it
// never matches.
const BARE_LOOP_CMD_RE = /(?<![-A-Za-z0-9_\/.\\:])\/loop-([a-z]+(?:-[a-z]+)*)/g;

// For each bare `/loop-<cmd>` token in a file's content, the file must also
// contain the namespaced plugin spelling `/dev-loops:loop-<cmd>` (same command
// root). Returns the human-readable failure strings (one per uncovered root).
// Factored as a pure content function so the negative self-test exercises the
// SAME code path the production scan uses (no duplicated logic that can drift).
function computeBareSlashFailuresForContent(relSurface, content) {
  const bareRoots = new Set();
  for (const match of content.matchAll(BARE_LOOP_CMD_RE)) {
    bareRoots.add(match[1]);
  }
  const failures = [];
  for (const root of bareRoots) {
    const namespaced = `/dev-loops:loop-${root}`;
    if (!content.includes(namespaced)) {
      failures.push(`${relSurface} instructs a bare \`/loop-${root}\` without the namespaced \`${namespaced}\` alternative`);
    }
  }
  return failures;
}

function computeBareSlashFailures(repoRoot, surfaceFile) {
  const content = fs.readFileSync(surfaceFile, "utf8");
  return computeBareSlashFailuresForContent(path.relative(repoRoot, surfaceFile), content);
}

// The selection predicate (existing on disk, not allowlisted) — the SINGLE
// source of which surface files the scan actually inspects. Shared by
// `collectFailures` and the vacuous-pass guard below so a skip condition
// added to one can never drift from what the other counts.
function scannedSurfaceFiles(repoRoot) {
  return surfaceFiles(repoRoot).filter(
    (surfaceFile) => fs.existsSync(surfaceFile) && !isAllowlisted(repoRoot, surfaceFile),
  );
}

function collectFailures(repoRoot) {
  const failures = [];
  for (const surfaceFile of scannedSurfaceFiles(repoRoot)) {
    failures.push(...computeBareSlashFailures(repoRoot, surfaceFile));
  }
  return failures;
}

// Per-root vacuous-pass guard: `commands/` and `agents/` are scanned via the
// shared `flatDir` helper, which fails OPEN (returns an empty list) when the
// dir is missing. The aggregate guards below (scannedSurfaces.length,
// totalBareTokens) are satisfied by OTHER surface roots (skills, .claude,
// ...), so a vanished/renamed `commands/` or `agents/` dir would otherwise
// silently shrink the scanned surface with no test failure. Assert each root
// contributes at least one surface file directly.
test("the commands/ and agents/ surface roots each contribute at least one surface file", () => {
  const commandsFiles = flatDir(path.join(REPO_ROOT, "commands"), ".md", []);
  assert.ok(commandsFiles.length > 0, "expected commands/ to contribute at least one .md surface file — a vanished/renamed commands/ dir would silently shrink the scanned surface");

  const agentsFiles = flatDir(path.join(REPO_ROOT, "agents"), ".md", []);
  assert.ok(agentsFiles.length > 0, "expected agents/ to contribute at least one .md surface file — a vanished/renamed agents/ dir would silently shrink the scanned surface");
});

test("no shipped surface instructs a bare /loop-* slash command without the namespaced alternative", () => {
  // Vacuous-pass guard, two layers deep — mirrors referenced-scripts-shipped's
  // `references.length` check at the same depth (scan-OUTPUT, not just file
  // selection):
  const scannedSurfaces = scannedSurfaceFiles(REPO_ROOT);
  assert.ok(scannedSurfaces.length > 0, "expected the scanned surface set to be non-empty (vacuous-pass guard)");
  const totalBareTokens = scannedSurfaces.reduce(
    (count, surfaceFile) => count + [...fs.readFileSync(surfaceFile, "utf8").matchAll(BARE_LOOP_CMD_RE)].length,
    0,
  );
  assert.ok(totalBareTokens > 0, "expected at least one bare /loop-* token across the scanned surfaces (vacuous-pass guard)");
  const failures = collectFailures(REPO_ROOT);
  assert.deepEqual(failures, [], `bare /loop-* slash references without a namespaced alternative:\n${failures.join("\n")}`);
});

// Negative self-test: proves the contract can actually FAIL, not pass vacuously,
// by driving the SAME production content-scan function (`computeBareSlashFailuresForContent`)
// — not a duplicated body. A bare `/loop-continue` with no namespaced form is
// flagged; adding `/dev-loops:loop-continue` clears it; a file path reference
// (`commands/loop-continue.command.md`) is NOT flagged (path-adjacent); a CLI
// replacement (no bare token) passes; a trailing-hyphen token does not yield a
// malformed root.
test("computeBareSlashFailuresForContent flags an uncovered bare reference, clears it with the namespaced form, ignores file paths, and rejects trailing-hyphen roots", () => {
  const relSurface = "skills/dev-loop/SKILL.md";

  const bareOnly = computeBareSlashFailuresForContent(relSurface, "run `/loop-continue #N` to proceed");
  assert.equal(bareOnly.length, 1);
  assert.match(bareOnly[0], /instructs a bare `\/loop-continue`/);

  const bothSpellings = computeBareSlashFailuresForContent(relSurface, "run `/dev-loops:loop-continue #N` (or `/loop-continue #N` in the dev-loops repo) to proceed");
  assert.equal(bothSpellings.length, 0);

  const filePath = computeBareSlashFailuresForContent(relSurface, "see commands/loop-continue.command.md and .claude/commands/loop-continue.md");
  assert.equal(filePath.length, 0);

  const cliReplacement = computeBareSlashFailuresForContent(relSurface, "run `dev-loops loop continue #N` to proceed");
  assert.equal(cliReplacement.length, 0);

  // A trailing hyphen does not become part of the root: `/loop-grill-` resolves
  // to root `grill`, so it is flagged only when `/dev-loops:loop-grill` is
  // absent — never as a malformed `grill-` root.
  const trailingHyphen = computeBareSlashFailuresForContent(relSurface, "run `/loop-grill-` now");
  assert.equal(trailingHyphen.length, 1);
  assert.match(trailingHyphen[0], /`\/loop-grill`/);
  assert.doesNotMatch(trailingHyphen[0], /`\/loop-grill-`/);
});

// Multi-root case: two distinct bare commands in one file where only one has
// the namespaced alternative — the uncovered root is flagged, the covered one
// is not. This pins the per-root Set dedup + per-root `includes` check against a
// regression that accepts any-namespaced-form-present instead of per-root.
test("computeBareSlashFailuresForContent flags only the uncovered root when one bare command has the alternative and another does not", () => {
  const relSurface = "skills/dev-loop/SKILL.md";
  const mixed = computeBareSlashFailuresForContent(
    relSurface,
    "run `/dev-loops:loop-continue #N` (or `/loop-continue #N` in the dev-loops repo); also run `/loop-grill --auto`.",
  );
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /`\/loop-grill`/);
  assert.doesNotMatch(mixed[0], /`\/loop-continue`/);
});

// Allowlist path: `.claude/commands/<name>.md` is the source-repo-local
// command doc where the bare form is the runnable command itself, so it is
// skipped entirely; a non-allowlisted `.claude` mirror with a bare reference
// is NOT skipped.
test("isAllowlisted skips only .claude/commands/ surfaces", () => {
  assert.equal(isAllowlisted(REPO_ROOT, path.join(REPO_ROOT, ".claude/commands/loop-continue.md")), true);
  assert.equal(isAllowlisted(REPO_ROOT, path.join(REPO_ROOT, ".claude/skills/dev-loop/SKILL.md")), false);
  assert.equal(isAllowlisted(REPO_ROOT, path.join(REPO_ROOT, "skills/dev-loop/SKILL.md")), false);
});
