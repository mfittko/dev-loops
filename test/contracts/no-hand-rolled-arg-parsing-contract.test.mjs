// #808 migrated every scripts/github/*.mjs CLI to node:util parseArgs, but
// hand-rolled while/shift and manual for-index argv scanning loops reappeared
// in files added or edited after that migration closed. This contract fences
// scripts/github/*.mjs (the CLI surface #808 actually migrated) against the
// same two hand-rolled shapes so the regression can't sail through silently
// again: a caller must either use node:util parseArgs, or name a reasoned
// EXCLUDED entry below.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const githubScriptsRoot = path.join(repoRoot, "scripts/github");

// Shape 1: `while (args.length > 0) { const token = args.shift(); ... }` —
// the exact idiom post-gate-findings.mjs regressed to.
const WHILE_SHIFT_LOOP_RE = /while\s*\(\s*(?:args|argv)\w*\.length\s*>\s*0\s*\)/;

// Shape 2: `for (let i = 0; i < args.length; i += 1) { const token = args[i]; ... }` —
// manual index scanning over the raw argv array instead of node:util
// parseArgs tokens (the shape offer-human-handoff.mjs / resolve-handoff-candidates.mjs
// regressed to).
const MANUAL_FOR_INDEX_LOOP_RE = /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*(?:args|argv)\w*\.length/;

// Reasoned exclusions: a scripts/github/*.mjs file that legitimately contains
// one of the banned shapes for a reason unrelated to top-level CLI arg
// parsing. Every entry must name a concrete reason a maintainer can evaluate
// on sight.
const EXCLUDED = new Map([
  // Currently empty: manage-sub-issues.mjs's single leading `args.shift()`
  // (positional subcommand consumption before parseArgs) does not match
  // either banned shape, so it needs no exclusion.
]);

async function discoverGithubScripts() {
  const entries = await readdir(githubScriptsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .sort();
}

test("no scripts/github/*.mjs script hand-rolls a while/shift argv-parsing loop", async () => {
  const files = await discoverGithubScripts();
  assert.ok(files.length > 20, `expected the full scripts/github CLI set, got ${files.length}`);

  const offenders = [];
  for (const name of files) {
    if (EXCLUDED.has(name)) continue;
    const source = await readFile(path.join(githubScriptsRoot, name), "utf8");
    if (WHILE_SHIFT_LOOP_RE.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `hand-rolled while/shift argv-parsing loop found in: ${offenders.join(", ")}\n` +
      `Fix: migrate to node:util parseArgs (see scripts/github/edit-pr.mjs), or add a reasoned EXCLUDED entry.`,
  );
});

test("no scripts/github/*.mjs script hand-rolls a manual for-index argv-parsing loop", async () => {
  const files = await discoverGithubScripts();

  const offenders = [];
  for (const name of files) {
    if (EXCLUDED.has(name)) continue;
    const source = await readFile(path.join(githubScriptsRoot, name), "utf8");
    if (MANUAL_FOR_INDEX_LOOP_RE.test(source)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `hand-rolled manual for-index argv-parsing loop found in: ${offenders.join(", ")}\n` +
      `Fix: migrate to node:util parseArgs (see scripts/github/edit-pr.mjs), or add a reasoned EXCLUDED entry.`,
  );
});

test("every EXCLUDED entry is still a real, currently-discovered scripts/github/*.mjs file (no stale allowlist entries)", async () => {
  const discovered = new Set(await discoverGithubScripts());
  const stale = [...EXCLUDED.keys()].filter((name) => !discovered.has(name));
  assert.deepEqual(stale, [], `stale EXCLUDED entries (file no longer exists): ${stale.join(", ")}`);
});

test("the banned-pattern regexes match the exact regressed shapes (self-test)", () => {
  assert.match(
    "while (args.length > 0) {\n    const token = args.shift();",
    WHILE_SHIFT_LOOP_RE,
    "while/shift loop shape must be detected",
  );
  assert.match(
    "for (let i = 0; i < args.length; i += 1) {\n    const token = args[i];",
    MANUAL_FOR_INDEX_LOOP_RE,
    "manual for-index loop shape must be detected",
  );
  assert.doesNotMatch(
    "const { tokens } = parseArgs({ args: [...argv], options: {}, tokens: true });\nfor (const token of tokens) {",
    WHILE_SHIFT_LOOP_RE,
    "a parseArgs token loop must not false-positive",
  );
  assert.doesNotMatch(
    "const { tokens } = parseArgs({ args: [...argv], options: {}, tokens: true });\nfor (const token of tokens) {",
    MANUAL_FOR_INDEX_LOOP_RE,
    "a parseArgs token loop must not false-positive",
  );
});
