// Release-script import-closure contract (deps-free release path).
//
// release.yml / npm-publish.yml run the release-script family with bare `node`
// BEFORE any install (a deliberate invariant — see the comment in
// scripts/lib/direct-run.mjs). So the FULL transitive static-import closure of
// every release script must contain no `@dev-loops/core` and no 3rd-party
// import: any bare specifier that is not a node: builtin would
// ERR_MODULE_NOT_FOUND at module load and crash the release step.
//
// This regressed once already: an epic added `formatCliError` from
// ../_core-helpers.mjs (which re-exports @dev-loops/core) into
// scripts/lib/jq-output.mjs, which every release script pulls in via
// verify-release-approval — crashing `node scripts/release/*.mjs`. The
// per-script CLI tests use `spawnSync("node", ...)` from THIS checkout, which
// resolves @dev-loops/core from the repo's own node_modules, so they never saw
// it. This static closure walk is resolution-independent: it inspects the
// source graph directly, so it catches the offending import at any depth even
// when node_modules happens to be present.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELEASE_DIR = path.join(REPO_ROOT, "scripts", "release");

// The four release scripts release.yml / npm-publish.yml invoke with bare node.
const RELEASE_ENTRIES = [
  "verify-release-approval.mjs",
  "assert-core-dependency-version.mjs",
  "extract-changelog-section.mjs",
  "resolve-npm-dist-tag.mjs",
].map((f) => path.join(RELEASE_DIR, f));

// Static `import ... from`, side-effect `import "x"`, and `export ... from`
// specifiers — the imports that execute at module load. The match is anchored
// to a line-leading import/export STATEMENT (the shape the core-runtime-boundary
// contract uses) so a `from "..."` inside a string literal or help text is not
// mistaken for an import, and dynamic `import(...)` (lazy/guarded, no load-time
// crash) is excluded by requiring whitespace after `import`. The binding-list
// char class spans newlines so multi-line import blocks still resolve.
const STATIC_SPECIFIER_RE =
  /^[ \t]*(?:import\s+(?:[\w$*,{}\s]*?\bfrom\s+)?|export\s+[\w$*,{}\s]*?\bfrom\s+)["']([^"']+)["']/gm;

function specifiersOf(file) {
  const source = readFileSync(file, "utf8");
  const specs = [];
  for (const m of source.matchAll(STATIC_SPECIFIER_RE)) {
    specs.push(m[1]);
  }
  return specs;
}

// Resolve a relative specifier against its importer to an on-disk file path,
// appending .mjs/.js when the specifier is extensionless.
function resolveRelative(importer, spec) {
  const base = path.resolve(path.dirname(importer), spec);
  if (path.extname(base)) return base;
  for (const ext of [".mjs", ".js"]) {
    if (existsSync(`${base}${ext}`)) return `${base}${ext}`;
  }
  return base;
}

// Walk the transitive static-import closure from the given entry files.
// Returns { closure: Set<file>, offenders: [{ importer, specifier }] } where an
// offender is any non-relative, non-node-builtin specifier (a bare package).
function walkClosure(entries) {
  const closure = new Set();
  const offenders = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (closure.has(file)) continue;
    closure.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith("node:") || isBuiltin(spec)) continue;
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const resolved = resolveRelative(file, spec);
        if (!closure.has(resolved)) queue.push(resolved);
        continue;
      }
      offenders.push({ importer: path.relative(REPO_ROOT, file), specifier: spec });
    }
  }
  return { closure, offenders };
}

test("release scripts' transitive import closure has no @dev-loops/core or 3rd-party import (any depth)", () => {
  const { offenders } = walkClosure(RELEASE_ENTRIES);
  assert.deepEqual(
    offenders,
    [],
    `release-script closure must be node:-pure. Bare (non-node, non-relative) imports found:\n${offenders
      .map((o) => `  ${o.importer} -> ${o.specifier}`)
      .join("\n")}`,
  );
});

test("release scripts' closure specifically never reaches @dev-loops/core", () => {
  const { offenders } = walkClosure(RELEASE_ENTRIES);
  const core = offenders.filter((o) => o.specifier.startsWith("@dev-loops/core"));
  assert.deepEqual(core, [], "no release script may transitively import @dev-loops/core");
});

test("the closure actually traversed jq-output (guards against a walker that silently visits nothing)", () => {
  // A closure walker that resolved nothing would trivially pass the assertions
  // above. Anchor it: verify-release-approval imports jq-output.mjs, so the
  // closure MUST contain it — otherwise the traversal is broken, not clean.
  const { closure } = walkClosure(RELEASE_ENTRIES);
  const jqOutput = path.join(REPO_ROOT, "scripts", "lib", "jq-output.mjs");
  assert.ok(closure.has(jqOutput), "expected jq-output.mjs in the traversed closure");
});
