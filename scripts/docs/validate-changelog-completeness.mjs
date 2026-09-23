#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../_core-helpers.mjs";
import { createGitClient, resolveBaseRef } from "./_doc-git-client.mjs";
import { classifyFile } from "@dev-loops/core/analysis/diff-analyzer";
import {
  FRAGMENTS_DIR,
  fragmentBodyClosesSection,
  fragmentFormatErrors,
  isChangelogFragmentPath,
} from "../release/assemble-changelog-fragments.mjs";

const CHANGELOG_PATH = "CHANGELOG.md";

/**
 * Conventional-commit type vocabulary, pinned to the same set the worktree
 * commit-msg guard enforces (`packages/core/src/loop/commit-msg-guard.mjs`).
 * Only the guard's TYPE vocabulary is pinned here, not its stricter subject
 * regex: the PR-seam parser below additionally accepts a scope-less subject
 * and a breaking-change `!` suffix, so `feat!: ...` classifies as notable
 * even though the commit-msg guard would refuse that subject shape.
 * A `feat` or `fix` subject marks the change as notable (user-facing), so the
 * PR must document it in the CHANGELOG.
 */
export const NOTABLE_COMMIT_TYPES = new Set(["feat", "fix"]);

/** All conventional-commit types recognized by the commit-msg guard. */
const CONVENTIONAL_TYPES = new Set([
  ...NOTABLE_COMMIT_TYPES,
  "chore",
  "docs",
  "test",
  "refactor",
  "revert",
  "perf",
  "style",
  "ci",
  "build",
]);

const CONVENTIONAL_SUBJECT_RE = /^([a-z]+)(?:\([^()\n]+\))?!?:\s+\S/u;

/**
 * Parse the conventional-commit type from a commit subject line.
 * Returns null for non-conventional subjects (same type vocabulary as the
 * commit-msg guard, reusing its existing detection rather than a new heuristic;
 * the subject shape here is looser than the guard's — scope-less subjects and
 * a breaking-change `!` suffix are accepted).
 *
 * @param {string} subject
 * @returns {string|null} The type token (e.g. "feat"), or null.
 */
export function parseConventionalType(subject) {
  const match = CONVENTIONAL_SUBJECT_RE.exec(String(subject ?? ""));
  if (!match) return null;
  const type = match[1];
  return CONVENTIONAL_TYPES.has(type) ? type : null;
}

/**
 * Extract the list items under `## Unreleased` in a Keep-a-Changelog file.
 *
 * @param {string} changelog - Full CHANGELOG.md contents.
 * @returns {string[]} Item texts (marker and leading whitespace stripped).
 */
export function extractUnreleasedItems(changelog) {
  const lines = String(changelog ?? "").split(/\r?\n/);
  const items = [];
  let inUnreleased = false;
  for (const line of lines) {
    if (/^##\s+Unreleased\b/i.test(line)) {
      inUnreleased = true;
      continue;
    }
    if (inUnreleased && /^##\s+\S/.test(line)) break;
    if (!inUnreleased) continue;
    const match = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
    if (match) items.push(match[1]);
  }
  return items;
}

/**
 * Whether the described change is "notable" and therefore must add a
 * `## Unreleased` CHANGELOG entry. Reuses the existing change classifier:
 * a conventional `feat`/`fix` commit subject, or a changed file that
 * classifies as code (`classifyFile()` from the diff analyzer — covers
 * packages/core and scripts source, excludes docs/config/test-only diffs).
 *
 * @param {{ commitSubjects: string[], files: string[] }} input
 * @returns {boolean}
 */
export function isNotableChange({ commitSubjects, files }) {
  const subjects = Array.isArray(commitSubjects) ? commitSubjects : [];
  const paths = Array.isArray(files) ? files : [];
  if (subjects.some((s) => NOTABLE_COMMIT_TYPES.has(parseConventionalType(s)))) return true;
  return paths.some((f) => classifyFile(f) === "code");
}

/**
 * Core check: a notable change must add at least one list item under
 * `## Unreleased` relative to the base. "Added" is endpoint-based: the head
 * Unreleased section contains an item text absent from the base section.
 * Consequence: a reworded item (new text absent from base) satisfies the
 * requirement, while keeping the exact item text does not — intermediate
 * churn within the PR is not observed.
 *
 * A changeset fragment (a NEWLY ADDED `changes/<slug>.md` file) satisfies the
 * requirement in place of a direct `CHANGELOG.md` edit: uniquely named
 * fragments never collide, so concurrent PRs stop conflicting on the changelog.
 * The contract requires a NEW fragment, so only ADDED paths count — a modified
 * or deleted existing `changes/*.md` does not satisfy the gate. `addedFiles`
 * carries the base→HEAD `--diff-filter=A` list; it defaults to `files` only for
 * direct callers that do not separate them (the CLI always passes the added
 * list). The legacy path (an added `## Unreleased` item) still passes for
 * backward compatibility.
 *
 * @param {{
 *   baseChangelog: string,
 *   headChangelog: string,
 *   commitSubjects: string[],
 *   files: string[],
 *   addedFiles?: string[],
 * }} input
 * @returns {{ notable: boolean, addedItems: string[], addedFragment: boolean, errors: string[] }}
 */
export function validateChangelogCompleteness({
  baseChangelog,
  headChangelog,
  commitSubjects,
  files,
  addedFiles,
}) {
  const notable = isNotableChange({ commitSubjects, files });
  if (!notable) return { notable, addedItems: [], addedFragment: false, errors: [] };

  const addedPaths = Array.isArray(addedFiles)
    ? addedFiles
    : (Array.isArray(files) ? files : []);
  const addedFragment = addedPaths.some((f) => isChangelogFragmentPath(f));

  const baseItems = new Set(extractUnreleasedItems(baseChangelog));
  const headItems = extractUnreleasedItems(headChangelog);
  const addedItems = headItems.filter((item) => !baseItems.has(item));

  const errors = [];
  if (!addedFragment && addedItems.length === 0) {
    errors.push(
      "notable change (feat/fix commit or code-file diff) records no changelog note; the PR is blocked until it either adds a changeset fragment (a new changes/<slug>.md file) or adds a list item under '## Unreleased' in CHANGELOG.md (LIFECYCLE-CHANGELOG-COMPLETENESS, issues #1864/#2293)",
    );
  }
  return { notable, addedItems, addedFragment, errors };
}

// createGitClient + resolveBaseRef are shared with validate-decision-records.mjs
// via ./_doc-git-client.mjs so the two base-ref-dependent validators cannot
// drift. Re-exported here for the injected-git test suite.
export { createGitClient };

/**
 * Run the validator end to end, returning the process exit code. Injectable
 * `root`/`git`/`env`/`log` keep the CLI path unit-testable (base-ref resolution
 * order, the degrade path, and exit codes), matching the sibling
 * validate-decision-records.mjs run({ root, git }) shape.
 */
export async function main({ root, env = process.env, log = console, git = createGitClient(root) } = {}) {
  const base = await resolveBaseRef(git, env).catch(() => null);
  if (!base) {
    // Legitimate no-history case (shallow checkout, no origin): degrade with a
    // notice like the decision-record validator. PR CI fetches the base branch
    // (existing test:docs step), so the PR seam still enforces.
    log.log("base ref unavailable; skipping CHANGELOG completeness check");
    return 0;
  }

  const [commitSubjects, files, addedFiles, headChangelog, baseExists] = await Promise.all([
    git.logSubjects(base, "HEAD"),
    git.diffNameOnly(base, "HEAD", { nulDelimited: true }),
    git.diffAddedFiles(base, "HEAD", { nulDelimited: true }),
    readFile(path.join(root, CHANGELOG_PATH), "utf8").catch(() => ""),
    git.pathExistsIn(base, CHANGELOG_PATH),
  ]);
  const baseChangelog = baseExists ? await git.show(`${base}:${CHANGELOG_PATH}`) : "";

  // A fragment must be a REGULAR file carrying a real note. Two exclusions keep
  // the gate consistent with the release assembler (`readFragments`):
  //  - a symlink is rejected, never followed: an untrusted PR could point
  //    `changes/x.md` at an arbitrary host file, and reading through it would
  //    leak that file's contents into CHANGELOG.md (data disclosure).
  //  - an empty/whitespace fragment passes a path-only check but is dropped by
  //    the assembler, silently omitting the note.
  // The `changes/` parent must itself be a real directory (lstat, not followed):
  // a symlinked `changes/` would make an inner fragment resolve through an
  // external directory. When it is not a real directory, no fragment is trusted.
  const changesStat = await lstat(path.join(root, FRAGMENTS_DIR)).catch(() => null);
  const changesDirIsReal = Boolean(changesStat && changesStat.isDirectory());
  const addedFilesWithNotes = [];
  for (const f of addedFiles) {
    if (isChangelogFragmentPath(f)) {
      if (!changesDirIsReal) continue;
      const stat = await lstat(path.join(root, f)).catch(() => null);
      if (!stat || !stat.isFile()) continue; // missing, symlink, or non-regular
      const body = await readFile(path.join(root, f), "utf8").catch(() => "");
      // Reject an empty note, or a body with a level-2 "## " heading that would
      // truncate the release section at assembly (silently dropping later notes).
      if (body.trim() === "" || fragmentBodyClosesSection(body)) continue;
    }
    addedFilesWithNotes.push(f);
  }

  const { errors } = validateChangelogCompleteness({
    baseChangelog,
    addedFiles: addedFilesWithNotes,
    headChangelog,
    commitSubjects,
    files,
  });

  // Format rule for every new or changed fragment still present at HEAD. A
  // fragment consumed into CHANGELOG.md is deleted, so history is never re-checked.
  if (changesDirIsReal) {
    for (const f of files.filter((file) => isChangelogFragmentPath(file))) {
      const stat = await lstat(path.join(root, f)).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const body = await readFile(path.join(root, f), "utf8").catch(() => "");
      for (const error of fragmentFormatErrors(body)) errors.push(`${f}: ${error}`);
    }
  }
  if (errors.length > 0) {
    log.error("CHANGELOG completeness check failed (issue #1864):");
    for (const error of errors) log.error(`  - ${error}`);
    return 1;
  }
  log.log(`CHANGELOG completeness check passed (base ${base.slice(0, 12)}).`);
  return 0;
}

/* istanbul ignore if */
if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main({
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}
