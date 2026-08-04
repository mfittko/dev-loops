#!/usr/bin/env node
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";

const DEFAULT_SCAN_PATHS = Object.freeze([
  "README.md",
  "PLAN.md",
  "AGENTS.md",
  "scripts/README.md",
  "extension/README.md",
  "docs",
  "skills",
  "agents",
  ".claude",
]);

const DEFAULT_SOURCE_EXCLUDES = Object.freeze([
  "docs/archive",
  // Generated Claude skills carry consumer-project `../../…` links that target the INSTALLED
  // repo (where the skill lives at a shallower depth), not this source tree, so they are broken
  // by design from here. The generated `.claude/agents/**` and `.claude/commands/**` wrappers ARE
  // scanned — their repo-doc links are depth-shifted to resolve, so broken ones fail CI.
  ".claude/skills",
]);

const DEFAULT_CANDIDATE_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "tmp",
  "coverage",
  "dist",
  "worktrees",
  "playwright-report",
  "test-results",
]);

const DEFAULT_IGNORE_FILE = ".linkcheckignore";
const LINK_PATTERN = /(?<!!)\[[^\]]*\]\(([^)\n]+)\)/g;

const USAGE = `Usage: validate-links.mjs [--root <path>]

Validate repo-owned markdown relative links.

Options:
  --root <path>   Override the repo root to scan (defaults to this repository)
  --help, -h      Show this help text`.trim();

function resolveDefaultRepoRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseValidateLinksCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, root: { type: "string" } },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repoRoot: resolveDefaultRepoRoot(),
  };

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "root") {
      options.repoRoot = path.resolve(requireTokenValue(token));
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }

  return options;
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function normalizeRepoRelative(relativePath) {
  const normalized = path.normalize(relativePath);
  return toPosixPath(normalized).replace(/^\.\//, "");
}

function shouldSkipSource(repoRelativePath) {
  return DEFAULT_SOURCE_EXCLUDES.some((prefix) => {
    return repoRelativePath === prefix || repoRelativePath.startsWith(`${prefix}/`);
  });
}

async function readPathKind(targetPath) {
  try {
    const entry = await stat(targetPath);
    if (entry.isDirectory()) {
      return "directory";
    }
    if (entry.isFile()) {
      return "file";
    }
    return null;
  } catch {
    return null;
  }
}

async function pathExists(targetPath) {
  return (await readPathKind(targetPath)) !== null;
}

function normalizeLinkTarget(rawTarget) {
  let normalized = rawTarget.trim();

  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }

  const titleMatch = normalized.match(/^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/);
  if (titleMatch) {
    normalized = titleMatch[1];
  }

  return normalized;
}

function stripFragment(rawTarget) {
  const hashIndex = rawTarget.indexOf("#");
  return hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
}

function shouldIgnoreRawTarget(rawTarget) {
  if (rawTarget.length === 0) {
    return true;
  }

  if (rawTarget.startsWith("#") || rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
    return true;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawTarget)) {
    return true;
  }

  return false;
}

export function extractRelativeMarkdownLinks(content) {
  const links = [];
  const lines = content.split(/\r?\n/);
  let activeFence = null;

  for (const [index, line] of lines.entries()) {
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

    for (const match of line.matchAll(LINK_PATTERN)) {
      const rawTarget = normalizeLinkTarget(match[1] ?? "");
      if (shouldIgnoreRawTarget(rawTarget)) {
        continue;
      }

      links.push({
        line: index + 1,
        rawTarget,
      });
    }
  }

  return links;
}

async function collectMarkdownFiles(repoRoot) {
  const collected = new Set();

  async function walkDirectory(absoluteDir, repoRelativeDir) {
    const entries = await readdir(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      const absoluteEntryPath = path.join(absoluteDir, entry.name);
      const repoRelativePath = normalizeRepoRelative(path.join(repoRelativeDir, entry.name));

      if (shouldSkipSource(repoRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkDirectory(absoluteEntryPath, repoRelativePath);
        continue;
      }

      if (entry.isFile()) {
        if (repoRelativePath.endsWith(".md")) {
          collected.add(repoRelativePath);
        }
        continue;
      }

      if (!entry.isSymbolicLink()) {
        continue;
      }

      const kind = await readPathKind(absoluteEntryPath);
      if (kind === "file" && repoRelativePath.endsWith(".md")) {
        collected.add(repoRelativePath);
      }
    }
  }

  for (const scanPath of DEFAULT_SCAN_PATHS) {
    const absolutePath = path.join(repoRoot, scanPath);

    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      continue;
    }

    const repoRelativePath = normalizeRepoRelative(scanPath);
    if (shouldSkipSource(repoRelativePath)) {
      continue;
    }

    if (stats.isDirectory()) {
      await walkDirectory(absolutePath, repoRelativePath);
      continue;
    }

    if (stats.isFile()) {
      if (repoRelativePath.endsWith(".md")) {
        collected.add(repoRelativePath);
      }
      continue;
    }

    if (!stats.isSymbolicLink()) {
      continue;
    }

    const kind = await readPathKind(absolutePath);
    if (kind === "file" && repoRelativePath.endsWith(".md")) {
      collected.add(repoRelativePath);
    }
  }

  return [...collected].sort();
}

async function loadIgnoreList(repoRoot, ignoreFileName = DEFAULT_IGNORE_FILE) {
  const ignorePath = path.join(repoRoot, ignoreFileName);

  try {
    const content = await readFile(ignorePath, "utf8");
    const ignored = new Set();

    for (const line of content.split(/\r?\n/)) {
      const withoutComment = line.split("#", 1)[0].trim();
      if (withoutComment.length === 0) {
        continue;
      }
      ignored.add(normalizeRepoRelative(withoutComment));
    }

    return ignored;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

async function buildCandidateIndex(repoRoot) {
  const candidates = [];

  async function walkDirectory(absoluteDir, repoRelativeDir = "") {
    const entries = await readdir(absoluteDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && DEFAULT_CANDIDATE_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const absoluteEntryPath = path.join(absoluteDir, entry.name);
      const repoRelativePath = normalizeRepoRelative(path.join(repoRelativeDir, entry.name));

      if (shouldSkipSource(repoRelativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        candidates.push({
          repoRelativePath,
          absolutePath: absoluteEntryPath,
          parentDir: normalizeRepoRelative(path.dirname(repoRelativePath)),
          baseName: path.basename(repoRelativePath),
          baseNameLower: path.basename(repoRelativePath).toLowerCase(),
        });
        await walkDirectory(absoluteEntryPath, repoRelativePath);
        continue;
      }

      if (entry.isFile()) {
        candidates.push({
          repoRelativePath,
          absolutePath: absoluteEntryPath,
          parentDir: normalizeRepoRelative(path.dirname(repoRelativePath)),
          baseName: path.basename(repoRelativePath),
          baseNameLower: path.basename(repoRelativePath).toLowerCase(),
        });
        continue;
      }

      if (!entry.isSymbolicLink()) {
        continue;
      }

      const kind = await readPathKind(absoluteEntryPath);
      if (kind === null) {
        continue;
      }

      candidates.push({
        repoRelativePath,
        absolutePath: absoluteEntryPath,
        parentDir: normalizeRepoRelative(path.dirname(repoRelativePath)),
        baseName: path.basename(repoRelativePath),
        baseNameLower: path.basename(repoRelativePath).toLowerCase(),
      });
    }
  }

  await walkDirectory(repoRoot);
  return candidates;
}

function isInsideRepoRoot(repoRoot, candidatePath) {
  const relative = path.relative(repoRoot, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function levenshteinDistance(left, right) {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1).fill(0);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function toSuggestedRelativePath(sourceAbsolutePath, targetAbsolutePath) {
  return toPosixPath(path.relative(path.dirname(sourceAbsolutePath), targetAbsolutePath));
}

function suggestCorrection({ sourceAbsolutePath, attemptedName, attemptedParentPath, repoRoot, candidateIndex }) {
  if (attemptedName.length === 0) {
    return null;
  }

  const exactBaseNameMatches = candidateIndex.filter((candidate) => candidate.baseNameLower === attemptedName.toLowerCase());
  if (exactBaseNameMatches.length === 1) {
    return toSuggestedRelativePath(sourceAbsolutePath, exactBaseNameMatches[0].absolutePath);
  }

  if (!isInsideRepoRoot(repoRoot, attemptedParentPath)) {
    return null;
  }

  const attemptedParentRelative = normalizeRepoRelative(path.relative(repoRoot, attemptedParentPath));
  const nearbyCandidates = candidateIndex
    .filter((candidate) => candidate.parentDir === attemptedParentRelative)
    .map((candidate) => ({
      candidate,
      distance: levenshteinDistance(attemptedName.toLowerCase(), candidate.baseNameLower),
    }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance || left.candidate.repoRelativePath.localeCompare(right.candidate.repoRelativePath));

  if (nearbyCandidates.length === 0) {
    return null;
  }

  if (nearbyCandidates.length > 1 && nearbyCandidates[0].distance === nearbyCandidates[1].distance) {
    return null;
  }

  return toSuggestedRelativePath(sourceAbsolutePath, nearbyCandidates[0].candidate.absolutePath);
}

export async function validateMarkdownLinks({ repoRoot = resolveDefaultRepoRoot() } = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const scannedFiles = await collectMarkdownFiles(absoluteRepoRoot);
  const ignoredResolvedPaths = await loadIgnoreList(absoluteRepoRoot);
  let candidateIndex = null;
  let candidateIndexUnavailable = false;
  const brokenLinks = [];
  let checkedLinkCount = 0;

  async function getCandidateIndex() {
    if (candidateIndexUnavailable) {
      return [];
    }

    if (candidateIndex === null) {
      try {
        candidateIndex = await buildCandidateIndex(absoluteRepoRoot);
      } catch {
        candidateIndexUnavailable = true;
        return [];
      }
    }

    return candidateIndex;
  }

  for (const sourcePath of scannedFiles) {
    const sourceAbsolutePath = path.join(absoluteRepoRoot, sourcePath);
    const content = await readFile(sourceAbsolutePath, "utf8");
    const extractedLinks = extractRelativeMarkdownLinks(content);

    for (const extractedLink of extractedLinks) {
      const strippedTarget = stripFragment(extractedLink.rawTarget);
      if (strippedTarget.length === 0) {
        continue;
      }

      checkedLinkCount += 1;
      const resolvedAbsolutePath = path.resolve(path.dirname(sourceAbsolutePath), strippedTarget);
      const resolvedPath = normalizeRepoRelative(path.relative(absoluteRepoRoot, resolvedAbsolutePath));
      const resolvedInsideRepoRoot = isInsideRepoRoot(absoluteRepoRoot, resolvedAbsolutePath);

      if (resolvedInsideRepoRoot && ignoredResolvedPaths.has(resolvedPath)) {
        continue;
      }

      if (resolvedInsideRepoRoot && await pathExists(resolvedAbsolutePath)) {
        continue;
      }

      brokenLinks.push({
        sourcePath,
        line: extractedLink.line,
        rawTarget: extractedLink.rawTarget,
        resolvedPath,
        suggestion: resolvedInsideRepoRoot
          ? suggestCorrection({
            sourceAbsolutePath,
            attemptedName: path.basename(strippedTarget),
            attemptedParentPath: path.dirname(resolvedAbsolutePath),
            repoRoot: absoluteRepoRoot,
            candidateIndex: await getCandidateIndex(),
          })
          : null,
      });
    }
  }

  brokenLinks.sort((left, right) => {
    return left.sourcePath.localeCompare(right.sourcePath)
      || left.line - right.line
      || left.rawTarget.localeCompare(right.rawTarget);
  });

  return {
    ok: brokenLinks.length === 0,
    repoRoot: absoluteRepoRoot,
    scannedFiles,
    checkedLinkCount,
    ignoredResolvedPaths: [...ignoredResolvedPaths].sort(),
    brokenLinks,
  };
}

export function formatBrokenLinkReport(brokenLinks) {
  const lines = ["Broken markdown links found:"];

  for (const brokenLink of brokenLinks) {
    lines.push(`- ${brokenLink.sourcePath}:${brokenLink.line} -> ${brokenLink.rawTarget}`);
    lines.push(`  resolved: ${brokenLink.resolvedPath}`);
    if (brokenLink.suggestion) {
      lines.push(`  suggestion: ${brokenLink.suggestion}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  try {
    const options = parseValidateLinksCliArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 0;
      return;
    }

    const result = await validateMarkdownLinks({ repoRoot: options.repoRoot });
    if (result.ok) {
      process.stdout.write(`Markdown links OK (${result.scannedFiles.length} files, ${result.checkedLinkCount} links checked).\n`);
      process.exitCode = 0;
      return;
    }

    process.stderr.write(`${formatBrokenLinkReport(result.brokenLinks)}\n`);
    process.exitCode = 1;
  } catch (error) {
    // Deliberately out of formatCliError's scope: this tool's error output is
    // human-readable TEXT (a message + the full usage body), not the JSON
    // { ok, error, hint } envelope — AC5's short-error contract targets
    // JSON-emitting gate CLIs specifically, and forcing this into JSON would
    // break its plain-text consumers for no token saving (nothing here parses
    // stderr as JSON).
    if (error instanceof Error && "usage" in error && typeof error.usage === "string") {
      process.stderr.write(`${error.message}\n\n${error.usage}\n`);
      process.exitCode = 2;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Markdown link validation failed: ${message}\n`);
    process.exitCode = 2;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
