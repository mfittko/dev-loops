// Deterministic docs-reference validator (#1865): the existing
// `referenced-scripts-shipped` contract only matches literal
// `scripts/....mjs` path tokens. It never resolves `npm run <name>` tokens
// against `package.json` scripts, `dev-loops <category> <subcommand>`
// mentions against the CLI's own route tables, or markdown intra-doc anchor
// links (`...#section`) against real headings — so a renamed/removed npm
// script, CLI subcommand, or heading can go stale in shipped docs with no
// backing check (the `docs`/`config-drift`/`contract-surface` review angles
// are agent-judged, not mechanically enforced). This backs those three
// mechanically-checkable reference kinds with a fail-closed, offline check.
//
// Scans the same markdown surface `validate-links.mjs` already scans
// (README/PLAN/AGENTS + docs/ + skills/ + agents/ + .claude/, minus
// docs/archive and the generated .claude/skills mirror) via its exported
// `collectMarkdownFiles`, reusing its fence-aware link parsing
// (`extractAnchorLinks`) rather than re-implementing markdown parsing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SUBCOMMAND_ALIASES, SUBCOMMAND_ROUTES } from "../../cli/index.mjs";
import { collectMarkdownFiles, extractAnchorLinks } from "../../scripts/docs/validate-links.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Intentionally-historical surfaces: narrative/retrospective docs that quote
// commands or CLI shapes as they existed (or were proposed) at the time of
// writing, not a live reference claim — same rationale as CHANGELOG.md
// (never scanned; outside `collectMarkdownFiles`'s surface) and docs/archive
// (excluded by `collectMarkdownFiles` itself). Matched by suffix/prefix so a
// future file under the same convention is covered for free.
const HISTORICAL_DOC_SUFFIXES = ["-review-notes.md"];

// docs/specs/ documents propose TARGET CLI shapes explicitly marked as not
// yet built (see docs/specs/queue-mode/SPEC.md's own "Status" line: "the
// autonomous queue driver described below remains deliberately unwired") — a
// design proposal, not a shipped-reference claim. Exempt from the
// subcommand-route check only; an npm-run or anchor drift there would still
// be a real dangling reference.
const SUBCOMMAND_CHECK_EXCLUDED_PREFIXES = ["docs/specs/"];

function isHistorical(relPath) {
  return HISTORICAL_DOC_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

function isExcludedFromSubcommandCheck(relPath) {
  return SUBCOMMAND_CHECK_EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

// ── npm run <name> resolution ──────────────────────────────────────

// Group 1 (the name) stops before a bare trailing `:` (sentence punctuation
// after the script name, not part of it). Group 2 captures an optional glob
// suffix — a trailing `*`, optionally preceded by `:` — e.g. `` `npm run
// foo:*` `` or `` `npm run foo*` ``. A doc citing that shape names a script
// FAMILY (a glob mention), not a literal invocation of a script named
// `foo:*`, so group 2 matching means: skip validation entirely, do NOT
// validate group 1 alone as a literal script name (a family prefix like
// `smoke` in `smoke:*` need not itself be a real script — only `smoke:headless` is).
const NPM_RUN_RE = /\bnpm run ([A-Za-z0-9](?:[A-Za-z0-9:_-]*[A-Za-z0-9])?)(:?\*)?/g;

export function loadPackageScriptNames(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

export function findUnknownNpmRunReferences(content, knownScriptNames) {
  const failures = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(NPM_RUN_RE)) {
      if (match[2]) {
        continue; // glob-family mention (`name:*` / `name*`) — not a literal script name
      }
      const name = match[1];
      if (!knownScriptNames.has(name)) {
        failures.push({ line: index + 1, name });
      }
    }
  }
  return failures;
}

// ── CLI subcommand resolution ──────────────────────────────────────

// Only resolves the shape this repo's own docs actually use to cite a route:
// a backtick-quoted `` `dev-loops <category> <subcommand>` `` (or the
// equivalent direct `node cli/index.mjs <category> <subcommand>` form).
// Built from `SUBCOMMAND_ROUTES`'s own keys, so a newly-registered category
// is covered without a matching regex edit here.
const CLI_SUBCOMMAND_RE = new RegExp(
  "`(?:dev-loops|node cli/index\\.mjs) (" + Object.keys(SUBCOMMAND_ROUTES).join("|") + ") ([\\w-]+)`",
  "g",
);

export function isKnownSubcommand(category, subcommand, subcommandRoutes = SUBCOMMAND_ROUTES, subcommandAliases = SUBCOMMAND_ALIASES) {
  if (subcommand === "--help" || subcommand === "-h") {
    return true; // generic category-help fast-path (cli/index.mjs), not a route
  }
  if (Object.hasOwn(subcommandRoutes[category] ?? {}, subcommand)) {
    return true;
  }
  return Boolean(subcommandAliases[category]?.[subcommand]);
}

export function findUnresolvedSubcommandReferences(content, subcommandRoutes = SUBCOMMAND_ROUTES, subcommandAliases = SUBCOMMAND_ALIASES) {
  const failures = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(CLI_SUBCOMMAND_RE)) {
      const [, category, subcommand] = match;
      if (!isKnownSubcommand(category, subcommand, subcommandRoutes, subcommandAliases)) {
        failures.push({ line: index + 1, category, subcommand });
      }
    }
  }
  return failures;
}

// ── Markdown anchor resolution ──────────────────────────────────────

// Mirrors github-slugger's heading-id algorithm (used by GitHub's own
// markdown renderer): lowercase, trim, strip a fixed punctuation set —
// leaving word chars/hyphens/underscores/whitespace — then replace EACH
// whitespace char individually with a hyphen. A removed punctuation
// character sitting between two untouched spaces therefore yields a DOUBLE
// hyphen, not a collapsed single one (e.g. "Phase 4 — Fix" -> the em
// dash is stripped, both flanking spaces survive and each becomes its own
// hyphen: "phase-4--fix") — collapsing runs here would silently mismatch
// real GitHub anchor ids.
const GITHUB_SLUG_PUNCTUATION_RE = new RegExp(
  "[\\u2000-\\u206F\\u2E00-\\u2E7F\\\\'!\"#$%&()*+,./:;<=>?@[\\]^`{|}~]",
  "g",
);

function slugifyHeadingText(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(GITHUB_SLUG_PUNCTUATION_RE, "")
    .replace(/\s/g, "-");
}

// Extracts the set of heading-anchor ids a markdown file produces: the
// github-slugger id for every ATX heading's visible text, de-duplicated the
// same way (repeat slug N gets a `-N` suffix), plus any explicit `{#custom-id}`
// trailer (an explicit id is stripped from the slugified text first, then
// added to the set alongside the auto-computed slug — both are valid targets).
export function extractHeadingAnchorIds(content) {
  const ids = new Set();
  const seenCounts = new Map();
  const lines = content.split(/\r?\n/);
  let activeFence = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fenceToken = fenceMatch[1];
      const fenceInfo = { marker: fenceToken[0], length: fenceToken.length };
      if (!activeFence) {
        activeFence = fenceInfo;
        continue;
      }
      if (activeFence.marker === fenceInfo.marker && fenceInfo.length >= activeFence.length) {
        activeFence = null;
      }
      continue;
    }
    if (activeFence) {
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (!headingMatch) {
      continue;
    }

    let text = headingMatch[1].trim();
    const explicitIdMatch = text.match(/\{#([\w-]+)\}\s*$/);
    let explicitId = null;
    if (explicitIdMatch) {
      explicitId = explicitIdMatch[1];
      text = text.slice(0, explicitIdMatch.index).trim();
    }

    const baseSlug = slugifyHeadingText(text);
    const count = seenCounts.get(baseSlug) ?? 0;
    seenCounts.set(baseSlug, count + 1);
    ids.add(count === 0 ? baseSlug : `${baseSlug}-${count}`);
    if (explicitId) {
      ids.add(explicitId);
    }
  }

  return ids;
}

// `loadTargetContent(pathPart)` resolves a non-empty anchor path relative to
// the citing file and returns its content, or null if the target file
// doesn't exist on disk — a missing target is already the existing
// `validateMarkdownLinks` broken-link check's job, so this skips it rather
// than double-reporting.
export function findDanglingAnchorReferences({ sourceRelPath, sourceContent, loadTargetContent }) {
  const failures = [];
  for (const { line, pathPart, fragment } of extractAnchorLinks(sourceContent)) {
    const targetContent = pathPart === "" ? sourceContent : loadTargetContent(pathPart);
    if (targetContent === null || targetContent === undefined) {
      continue;
    }
    if (!extractHeadingAnchorIds(targetContent).has(fragment)) {
      failures.push({ line, target: pathPart || "(same file)", fragment });
    }
  }
  return failures;
}

function loadTargetContentRelativeTo(repoRoot, sourceAbsPath) {
  return (pathPart) => {
    const targetAbs = path.resolve(path.dirname(sourceAbsPath), pathPart);
    if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
      return null;
    }
    return fs.readFileSync(targetAbs, "utf8");
  };
}

// ── Aggregate contract ──────────────────────────────────────────────

async function computeAllFailures(repoRoot) {
  const knownScriptNames = loadPackageScriptNames(repoRoot);
  const scannedFiles = await collectMarkdownFiles(repoRoot);
  const failures = [];

  for (const relPath of scannedFiles) {
    if (isHistorical(relPath)) {
      continue;
    }

    const absPath = path.join(repoRoot, relPath);
    const content = fs.readFileSync(absPath, "utf8");

    for (const { line, name } of findUnknownNpmRunReferences(content, knownScriptNames)) {
      failures.push(`${relPath}:${line} cites \`npm run ${name}\` — no such script in package.json`);
    }

    if (!isExcludedFromSubcommandCheck(relPath)) {
      for (const { line, category, subcommand } of findUnresolvedSubcommandReferences(content)) {
        failures.push(`${relPath}:${line} cites \`dev-loops ${category} ${subcommand}\` — no such subcommand in cli/index.mjs's route table`);
      }
    }

    for (const { line, target, fragment } of findDanglingAnchorReferences({
      sourceRelPath: relPath,
      sourceContent: content,
      loadTargetContent: loadTargetContentRelativeTo(repoRoot, absPath),
    })) {
      failures.push(`${relPath}:${line} cites \`${target}#${fragment}\` — no heading in ${target} produces that anchor id`);
    }
  }

  return { scannedFiles, failures };
}

test("the docs-reference surface is non-trivially scanned", async () => {
  const { scannedFiles } = await computeAllFailures(REPO_ROOT);
  assert.ok(scannedFiles.length > 100, `scanned markdown surface looks too small (${scannedFiles.length}) — collectMarkdownFiles likely broken`);
});

test("every npm run / CLI subcommand / markdown anchor reference in the shipped docs surface resolves", async () => {
  const { failures } = await computeAllFailures(REPO_ROOT);
  assert.deepEqual(failures, [], `stale docs references:\n${failures.join("\n")}`);
});

// ── Negative self-tests: prove each check can actually fail ─────────

test("findUnknownNpmRunReferences flags an absent script and accepts a real one", () => {
  const knownScriptNames = loadPackageScriptNames(REPO_ROOT);
  assert.ok(knownScriptNames.has("verify"), "fixture assumes `verify` is a real script");

  const failing = findUnknownNpmRunReferences("Run `npm run does-not-exist-synthetic-1865`.", knownScriptNames);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].name, "does-not-exist-synthetic-1865");

  const passing = findUnknownNpmRunReferences("Run `npm run verify`.", knownScriptNames);
  assert.deepEqual(passing, []);
});

test("findUnknownNpmRunReferences does not flag a script-family glob mention", () => {
  const knownScriptNames = loadPackageScriptNames(REPO_ROOT);
  // `smoke` is deliberately NOT itself a package.json script — only
  // `smoke:headless` is — so this pins that the glob-family exemption
  // skips validation of the family prefix entirely, rather than
  // (incorrectly) validating it as a literal script name.
  assert.ok(!knownScriptNames.has("smoke"), "fixture assumes `smoke` is not itself a real script");
  assert.ok(knownScriptNames.has("smoke:headless"), "fixture assumes `smoke:headless` is a real script");

  const colonGlob = findUnknownNpmRunReferences("historically ran `npm run smoke:*` scripts", knownScriptNames);
  assert.deepEqual(colonGlob, []);

  const bareGlob = findUnknownNpmRunReferences("historically ran `npm run smoke*` scripts", knownScriptNames);
  assert.deepEqual(bareGlob, []);
});

test("findUnresolvedSubcommandReferences flags an unresolved subcommand and accepts a real one/an alias", () => {
  const failing = findUnresolvedSubcommandReferences("See `dev-loops queue does-not-exist-synthetic-1865`.");
  assert.equal(failing.length, 1);
  assert.deepEqual(failing[0], { line: 1, category: "queue", subcommand: "does-not-exist-synthetic-1865" });

  const passing = findUnresolvedSubcommandReferences("See `dev-loops loop startup` first.");
  assert.deepEqual(passing, []);

  const aliased = findUnresolvedSubcommandReferences("See `dev-loops pr create-draft` (deprecated).");
  assert.deepEqual(aliased, []);

  const help = findUnresolvedSubcommandReferences("See `dev-loops queue --help`.");
  assert.deepEqual(help, []);

  const shortHelp = findUnresolvedSubcommandReferences("See `dev-loops queue -h`.");
  assert.deepEqual(shortHelp, []);

  const nodeForm = findUnresolvedSubcommandReferences("See `node cli/index.mjs loop startup` first.");
  assert.deepEqual(nodeForm, []);

  const nodeFormFailing = findUnresolvedSubcommandReferences("See `node cli/index.mjs queue does-not-exist-synthetic-1865`.");
  assert.equal(nodeFormFailing.length, 1);
  assert.deepEqual(nodeFormFailing[0], { line: 1, category: "queue", subcommand: "does-not-exist-synthetic-1865" });
});

test("isExcludedFromSubcommandCheck exempts docs/specs/ from the subcommand-route check but leaves everything else covered", () => {
  const content = "See `dev-loops queue does-not-exist-synthetic-1865`.";
  const specsPath = "docs/specs/queue-mode/SPEC.md";
  const normalPath = "docs/queue-mode/guide.md";

  assert.ok(isExcludedFromSubcommandCheck(specsPath), "docs/specs/ must be in the allowlist");
  assert.ok(!isExcludedFromSubcommandCheck(normalPath), "a normal docs/ file must not be in the allowlist");

  // Mirrors computeAllFailures's own guard: only run the subcommand check when not excluded.
  const specsFailures = isExcludedFromSubcommandCheck(specsPath) ? [] : findUnresolvedSubcommandReferences(content);
  const normalFailures = isExcludedFromSubcommandCheck(normalPath) ? [] : findUnresolvedSubcommandReferences(content);

  assert.deepEqual(specsFailures, [], "the same unresolved-subcommand citation is exempted under docs/specs/");
  assert.equal(normalFailures.length, 1, "the same unresolved-subcommand citation must still fail outside docs/specs/");
});

test("extractHeadingAnchorIds mirrors github-slugger, including the double-hyphen case and explicit {#id}", () => {
  const ids = extractHeadingAnchorIds([
    "# Phase 4 — Fix",
    "## Angle carry-forward (fail-closed) {#angle-carry-forward-fail-closed}",
    "## Repeat",
    "## Repeat",
  ].join("\n"));

  assert.ok(ids.has("phase-4--fix"), "em-dash between two untouched spaces must yield a DOUBLE hyphen");
  assert.ok(ids.has("angle-carry-forward-fail-closed"));
  assert.ok(ids.has("repeat"));
  assert.ok(ids.has("repeat-1"), "github-slugger de-dupes repeated headings with a -N suffix");
});

test("findDanglingAnchorReferences flags a same-file anchor with no matching heading and accepts a real one", () => {
  const sourceContent = ["# Guide", "", "See [Overview](#overview) and [Real](#guide).", ""].join("\n");
  const failures = findDanglingAnchorReferences({
    sourceRelPath: "docs/synthetic-1865.md",
    sourceContent,
    loadTargetContent: () => null,
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].fragment, "overview");
});

test("findDanglingAnchorReferences flags a cross-file anchor with no matching heading and accepts a real one", () => {
  const sourceContent = "See [Setup](./other.md#setup) and [Missing](./other.md#does-not-exist).";
  const otherContent = "# Other\n\n## Setup\n";
  const failures = findDanglingAnchorReferences({
    sourceRelPath: "docs/synthetic-1865.md",
    sourceContent,
    loadTargetContent: (pathPart) => (pathPart === "./other.md" ? otherContent : null),
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].fragment, "does-not-exist");
});

test("findDanglingAnchorReferences skips an anchor whose target file does not exist (the broken-link check's job)", () => {
  const failures = findDanglingAnchorReferences({
    sourceRelPath: "docs/synthetic-1865.md",
    sourceContent: "See [Missing file](./missing.md#anything).",
    loadTargetContent: () => null,
  });
  assert.deepEqual(failures, []);
});
