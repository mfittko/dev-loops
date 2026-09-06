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
//
// Supported anchor-link surface (the reference kinds this check resolves,
// #1920):
//   - heading anchors into a MARKDOWN target (`.md`), matched against both ATX
//     (`# Heading`) and setext (text underlined by `===`/`---`) headings, since
//     GitHub renders and slugs both. Leading YAML frontmatter is stripped so a
//     `key: value` line above a frontmatter-closing `---` is not read as a
//     setext heading.
//   - a `#fragment` into a NON-markdown target (a source-line anchor like
//     `foo.mjs#L10`, an image, or a directory) is NOT a heading-anchor claim
//     and is skipped, the same as a missing target — it is not false-failed as
//     a dangling heading.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import { SUBCOMMAND_ALIASES, SUBCOMMAND_ROUTES } from "../../cli/index.mjs";
import {
  collectMarkdownFiles,
  extractAnchorLinks,
  isInsideRepoRoot,
  iterNonFencedLines,
} from "../../scripts/docs/validate-links.mjs";

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

function loadPackageScriptNames(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

function findUnknownNpmRunReferences(content, knownScriptNames) {
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

// Resolves BOTH citation shapes this repo's own docs actually use: a
// backtick-quoted `` `dev-loops <category> <subcommand>` `` (or the
// equivalent direct `node cli/index.mjs <category> <subcommand>` form)
// anywhere in a line, and an UNBACKTICKED citation on a line of its own —
// the fenced usage-block form, where the line's trimmed content starts with
// the command (e.g. `dev-loops gate consolidate-fanin --findings-dir <dir>`).
// A `<placeholder>` argument after the category (e.g. `dev-loops queue
// <subcommand>`) describes the CLI shape rather than citing a route, and is
// skipped — the subcommand alternation only matches word/hyphen tokens.
// Built from `SUBCOMMAND_ROUTES`'s own keys, so a newly-registered category
// is covered without a matching regex edit here.
const CLI_SUBCOMMAND_RE = new RegExp(
  "`(?:dev-loops|node cli/index\\.mjs) (" + Object.keys(SUBCOMMAND_ROUTES).join("|") + ") ([\\w-]+)`",
  "g",
);
// Line-anchored variant for unbackticked citations: anchored at the start of
// the (trimmed) line, no trailing backticks.
const CLI_SUBCOMMAND_LINE_RE = new RegExp(
  "^(?:dev-loops|node cli/index\\.mjs) (" + Object.keys(SUBCOMMAND_ROUTES).join("|") + ") ([\\w-]+)",
);

function isKnownSubcommand(category, subcommand) {
  if (subcommand === "--help" || subcommand === "-h") {
    return true; // generic category-help fast-path (cli/index.mjs), not a route
  }
  if (Object.hasOwn(SUBCOMMAND_ROUTES[category] ?? {}, subcommand)) {
    return true;
  }
  return Boolean(SUBCOMMAND_ALIASES[category]?.[subcommand]);
}

function findUnresolvedSubcommandReferences(content) {
  const failures = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineAnchored = line.trimStart().match(CLI_SUBCOMMAND_LINE_RE);
    if (lineAnchored) {
      // An unbackticked citation opening the line (the fenced usage-block
      // shape): validate that single citation and move on — a command line is
      // not also scanned for backtick-quoted matches.
      const [, category, subcommand] = lineAnchored;
      if (!isKnownSubcommand(category, subcommand)) {
        failures.push({ line: index + 1, category, subcommand });
      }
      continue;
    }
    for (const match of line.matchAll(CLI_SUBCOMMAND_RE)) {
      const [, category, subcommand] = match;
      if (!isKnownSubcommand(category, subcommand)) {
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

// Strips a leading YAML frontmatter block (`---` on the first line through the
// next `---` delimiter) so its `key: value` lines are never mistaken for a
// setext heading followed by a `---` underline. Every scanned `---`/`===`
// "underline immediately under a non-blank line" in this repo is a frontmatter
// closer, so without this strip setext support would forge phantom anchors
// (e.g. `user-invocable: false` -> `user-invocable-false`). Only the leading
// block is stripped, matching the universal frontmatter convention.
function stripLeadingFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return content;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      return lines.slice(index + 1).join("\n");
    }
  }
  return content;
}

// Extracts the set of heading-anchor ids a markdown file produces. Covers BOTH
// heading syntaxes GitHub renders and slugs:
//   - ATX headings (`# Heading`)
//   - setext headings (a text line immediately underlined by a run of `=` for
//     h1 or `-` for h2, no blank line between) — GitHub generates the same
//     slug for these, so a link to a setext heading is a VALID reference and
//     must not be false-failed as dangling (#1920). The underline must sit
//     directly under a non-blank line that is not itself an ATX heading or
//     another underline; a `---` after a blank line is a thematic break, not a
//     setext underline, and leading frontmatter is stripped first.
// Both syntaxes are de-duplicated the same way (repeat slug N gets a `-N`
// suffix), plus any explicit `{#custom-id}` trailer (an explicit id is stripped
// from the slugified text first, then added to the set alongside the
// auto-computed slug — both are valid targets).
function extractHeadingAnchorIds(content) {
  const ids = new Set();
  const seenCounts = new Map();

  function addHeadingText(rawText) {
    let text = rawText.trim();
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

  const lines = [...iterNonFencedLines(stripLeadingFrontmatter(content))];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;

    const atxMatch = line.trimStart().match(/^#{1,6}\s+(.+)$/);
    if (atxMatch) {
      addHeadingText(atxMatch[1]);
      continue;
    }

    const isUnderline = /^(=+|-+)$/.test(line.trim());
    if (isUnderline && index > 0) {
      const previous = lines[index - 1].text;
      const previousIsHeadingText = previous.trim() !== ""
        && !/^#{1,6}\s+/.test(previous.trimStart())
        && !/^(=+|-+)$/.test(previous.trim());
      if (previousIsHeadingText) {
        addHeadingText(previous);
      }
    }
  }

  return ids;
}

// `loadTargetContent(pathPart)` resolves a non-empty anchor path relative to
// the citing file and returns its content, or null if the target file
// doesn't exist on disk — a missing target is already the existing
// `validateMarkdownLinks` broken-link check's job, so this skips it rather
// than double-reporting.
function findDanglingAnchorReferences({ sourceContent, loadTargetContent }) {
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
    // Only markdown targets carry heading anchors this offline check can
    // resolve. A `#fragment` into a NON-markdown file — a source-line anchor
    // (`foo.mjs#L10`), an image/asset, or a directory — is not a heading-anchor
    // claim, so skip it the same as a missing target (#1920). This also NARROWS
    // the filesystem reads (non-`.md` targets are never read) rather than
    // broadening them.
    if (!pathPart.toLowerCase().endsWith(".md")) {
      return null;
    }
    const targetAbs = path.resolve(path.dirname(sourceAbsPath), pathPart);
    // Guard against a link path traversing outside the repo (e.g. `../../../../etc/hosts`):
    // treat it the same as a missing target rather than reading outside the repo root.
    if (!isInsideRepoRoot(repoRoot, targetAbs)) {
      return null;
    }
    if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
      return null;
    }
    return fs.readFileSync(targetAbs, "utf8");
  };
}

// ── Aggregate contract ──────────────────────────────────────────────

// Doc-derived tokens interpolated into failure strings (script names,
// subcommand names, anchor targets/fragments) come from arbitrary doc text
// and could embed terminal control/format characters or line/paragraph
// separators (e.g. an ANSI escape inside a fabricated link target). Escape
// them so the check's own output cannot forge CI logs.
function sanitizeForLog(value) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

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
      failures.push(`${sanitizeForLog(relPath)}:${line} cites \`npm run ${sanitizeForLog(name)}\` — no such script in package.json`);
    }

    if (!isExcludedFromSubcommandCheck(relPath)) {
      for (const { line, category, subcommand } of findUnresolvedSubcommandReferences(content)) {
        failures.push(`${sanitizeForLog(relPath)}:${line} cites \`dev-loops ${sanitizeForLog(category)} ${sanitizeForLog(subcommand)}\` — no such subcommand in cli/index.mjs's route table`);
      }
    }

    for (const { line, target, fragment } of findDanglingAnchorReferences({
      sourceContent: content,
      loadTargetContent: loadTargetContentRelativeTo(repoRoot, absPath),
    })) {
      failures.push(`${sanitizeForLog(relPath)}:${line} cites \`${sanitizeForLog(target)}#${sanitizeForLog(fragment)}\` — no heading in ${sanitizeForLog(target)} produces that anchor id`);
    }
  }

  return { scannedFiles, failures };
}

test("the docs-reference surface covers the required root doc surfaces", async () => {
  const { scannedFiles } = await computeAllFailures(REPO_ROOT);
  const scanned = new Set(scannedFiles);

  // Assert the required root surfaces directly instead of a brittle scan-SIZE
  // proxy (#1920): a size threshold passes even if a specific required root
  // (say AGENTS.md) silently drops out of the scan, and false-fails on a
  // legitimate shrink of the docs surface. Naming the roots pins exactly what
  // `collectMarkdownFiles` must keep scanning.
  for (const requiredRoot of ["README.md", "PLAN.md", "AGENTS.md"]) {
    assert.ok(scanned.has(requiredRoot), `required root surface ${requiredRoot} is not in the scanned set — collectMarkdownFiles likely broken`);
  }
  assert.ok(
    scannedFiles.some((relPath) => relPath.startsWith("docs/")),
    "no docs/ file is in the scanned set — collectMarkdownFiles likely broken",
  );
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

test("findUnresolvedSubcommandReferences also resolves unbackticked line-anchored citations (fenced usage-block shape)", () => {
  const failing = findUnresolvedSubcommandReferences("dev-loops queue does-not-exist-synthetic-1865\n");
  assert.equal(failing.length, 1);
  assert.deepEqual(failing[0], { line: 1, category: "queue", subcommand: "does-not-exist-synthetic-1865" });

  const nodeFormFailing = findUnresolvedSubcommandReferences("node cli/index.mjs queue does-not-exist-synthetic-1865\n");
  assert.equal(nodeFormFailing.length, 1);
  assert.deepEqual(nodeFormFailing[0], { line: 1, category: "queue", subcommand: "does-not-exist-synthetic-1865" });

  const passing = findUnresolvedSubcommandReferences("dev-loops loop startup\n");
  assert.deepEqual(passing, []);

  const aliased = findUnresolvedSubcommandReferences("dev-loops pr create-draft\n");
  assert.deepEqual(aliased, [], "alias resolution must also apply to unbackticked line-anchored citations");

  const withArgs = findUnresolvedSubcommandReferences("dev-loops gate consolidate-fanin --findings-dir <dir> --gate <gate>\n");
  assert.deepEqual(withArgs, [], "trailing flags/args after a real citation must not hide it or false-positive");

  const help = findUnresolvedSubcommandReferences("dev-loops queue --help\n");
  assert.deepEqual(help, [], "--help fast-path must apply to unbackticked line-anchored citations too");

  const placeholder = findUnresolvedSubcommandReferences("dev-loops queue <subcommand> [--help]\n");
  assert.deepEqual(placeholder, [], "a <placeholder> subcommand token describes the CLI shape, not a citation of a route");

  const indented = findUnresolvedSubcommandReferences("  dev-loops queue does-not-exist-synthetic-1865\n");
  assert.equal(indented.length, 1, "leading indentation must not hide a fenced usage-block citation");

  const prose = findUnresolvedSubcommandReferences("dev-loops supports three routing modes.\n");
  assert.deepEqual(prose, [], "a prose line starting with dev-loops but no real category is not a citation");
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

test("extractHeadingAnchorIds resolves setext headings and ignores frontmatter / thematic breaks (#1920)", () => {
  const ids = extractHeadingAnchorIds([
    "---",
    "title: Frontmatter Key",
    "user-invocable: false",
    "---",
    "",
    "Setext Title",
    "======",
    "",
    "Setext Section",
    "---",
    "",
    "Some paragraph.",
    "",
    "---",
    "",
    "After break.",
  ].join("\n"));

  assert.ok(ids.has("setext-title"), "a `===` underline directly under text is a setext h1 anchor");
  assert.ok(ids.has("setext-section"), "a `---` underline directly under text is a setext h2 anchor");
  assert.ok(!ids.has("frontmatter-key"), "leading YAML frontmatter must not forge heading anchors");
  assert.ok(!ids.has("user-invocable-false"), "a frontmatter-closing `---` must not read the key line above it as a setext heading");
  assert.ok(!ids.has("some-paragraph"), "a `---` after a blank line is a thematic break, not a setext underline");

  // The exclusion guard: an underline sitting directly under an ATX heading (or
  // another underline) must NOT re-consume that line as setext text. `# Title`
  // then `===` yields exactly one `title` anchor — never a deduped
  // `title` + `title-1` from double-counting the same heading.
  const atxThenUnderline = extractHeadingAnchorIds("# Title\n===\n");
  assert.ok(atxThenUnderline.has("title"), "the ATX heading itself still produces its anchor");
  assert.ok(!atxThenUnderline.has("title-1"), "an ATX heading followed by an underline is not double-counted as a setext heading");
});

test("findDanglingAnchorReferences accepts a valid anchor into a setext heading in another file (#1920)", () => {
  const sourceContent = "See [Section](./other.md#setext-section).";
  const otherContent = "# Other\n\nSetext Section\n---\n";
  const failures = findDanglingAnchorReferences({
    sourceContent,
    loadTargetContent: (pathPart) => (pathPart === "./other.md" ? otherContent : null),
  });
  assert.deepEqual(failures, [], "a link to a real setext heading must not be false-failed as dangling");
});

test("loadTargetContentRelativeTo skips a non-markdown anchor target rather than reading it (#1920)", () => {
  const sourceAbsPath = path.join(REPO_ROOT, "docs", "synthetic-1920.md");
  const loadTargetContent = loadTargetContentRelativeTo(REPO_ROOT, sourceAbsPath);
  // `package.json` exists and is inside the repo, but is not markdown — a
  // `#fragment` into it is not a heading-anchor claim, so it is skipped
  // (returns null) rather than read-and-false-failed for having no headings.
  assert.equal(loadTargetContent("../package.json"), null);
});

test("findDanglingAnchorReferences flags a same-file anchor with no matching heading and accepts a real one", () => {
  const sourceContent = ["# Guide", "", "See [Overview](#overview) and [Real](#guide).", ""].join("\n");
  const failures = findDanglingAnchorReferences({
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
    sourceContent,
    loadTargetContent: (pathPart) => (pathPart === "./other.md" ? otherContent : null),
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].fragment, "does-not-exist");
});

test("findDanglingAnchorReferences skips an anchor whose target file does not exist (the broken-link check's job)", () => {
  const failures = findDanglingAnchorReferences({
    sourceContent: "See [Missing file](./missing.md#anything).",
    loadTargetContent: () => null,
  });
  assert.deepEqual(failures, []);
});

test("loadTargetContentRelativeTo refuses a cross-file anchor link that traverses outside the repo root", () => {
  const sourceAbsPath = path.join(REPO_ROOT, "docs", "synthetic-1865.md");
  const loadTargetContent = loadTargetContentRelativeTo(REPO_ROOT, sourceAbsPath);
  // An absolute pathPart makes `path.resolve` ignore the base dir entirely, so this
  // resolves to the real, existing `/etc/hosts` — outside the repo root. A relative
  // `../../../../etc/hosts` would resolve to a NONEXISTENT in-tree path from
  // `docs/`, making the plain existence check (not the containment guard) return
  // null and passing vacuously even with the containment guard deleted.
  // `/etc/hosts` exists on every runner this test targets, so a non-null return here
  // would prove the traversal guard failed and the file was read from outside the repo.
  assert.equal(loadTargetContent("/etc/hosts"), null);
});

test("sanitizeForLog escapes control/format characters and line/paragraph separators in doc-derived tokens", () => {
  assert.equal(sanitizeForLog("plain"), "plain");
  assert.equal(sanitizeForLog("[x](\u001b[31mFAKE\u001b[0m)"), "[x](\\u001b[31mFAKE\\u001b[0m)");
  assert.equal(sanitizeForLog("tab\there"), "tab\\u0009here");
  assert.equal(sanitizeForLog("\x9b[31mFAKE\x9b[0m"), "\\u009b[31mFAKE\\u009b[0m");
  assert.equal(sanitizeForLog("\u202eRLO"), "\\u202eRLO");
  assert.equal(sanitizeForLog("\u2066LRI"), "\\u2066LRI");
  // Previously-missed format marks (bidi LRM/RLM/ALM, zero-width) and the
  // line/paragraph separators — all pass through the old enumerated class.
  assert.equal(sanitizeForLog("\u200eLRM\u200fRLM"), "\\u200eLRM\\u200fRLM");
  assert.equal(sanitizeForLog("\u061cALM\u200bZWSP\u2060WJ\ufeffZWNBSP"), "\\u061cALM\\u200bZWSP\\u2060WJ\\ufeffZWNBSP");
  assert.equal(sanitizeForLog("\u2028LS\u2029PS"), "\\u2028LS\\u2029PS");
});
