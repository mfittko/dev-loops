#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../_core-helpers.mjs";
import { classifyFile } from "@dev-loops/core/analysis/diff-analyzer";

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

const CONVENTIONAL_SUBJECT_RE = /^([a-z]+)(?:\([^()\n]*\))?!?:\s+\S/u;

/**
 * Parse the conventional-commit type from a commit subject line.
 * Returns null for non-conventional subjects (same type vocabulary as the
 * commit-msg guard, issue #1864: reuse the existing detection, no new heuristic;
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
 * `## Unreleased` relative to the base. "Added" means the head Unreleased
 * section contains an item text absent from the base section — editing an
 * existing item without adding a new one does not satisfy the requirement.
 *
 * @param {{
 *   baseChangelog: string,
 *   headChangelog: string,
 *   commitSubjects: string[],
 *   files: string[],
 * }} input
 * @returns {{ notable: boolean, addedItems: string[], errors: string[] }}
 */
export function validateChangelogCompleteness({
  baseChangelog,
  headChangelog,
  commitSubjects,
  files,
}) {
  const notable = isNotableChange({ commitSubjects, files });
  if (!notable) return { notable, addedItems: [], errors: [] };

  const baseItems = new Set(extractUnreleasedItems(baseChangelog));
  const headItems = extractUnreleasedItems(headChangelog);
  const addedItems = headItems.filter((item) => !baseItems.has(item));

  const errors = [];
  if (addedItems.length === 0) {
    errors.push(
      "notable change (feat/fix commit or code-file diff) adds no list item under '## Unreleased' in CHANGELOG.md; the PR is blocked until it adds at least one entry describing the user-facing change (LIFECYCLE-CHANGELOG-COMPLETENESS, issue #1864)",
    );
  }
  return { notable, addedItems, errors };
}

export function createGitClient(root, exec = promisify(execFile)) {
  const run = (args) => exec("git", args, { cwd: root });
  return {
    async symbolicRef(ref) {
      const { stdout } = await run(["symbolic-ref", ref]);
      return stdout.trim();
    },
    async mergeBase(a, b) {
      const { stdout } = await run(["merge-base", a, b]);
      return stdout.trim();
    },
    async diffNameOnly(a, b) {
      // -z (NUL-delimited names) so a C-quoted path containing a newline cannot
      // smuggle a suffix line past classifyFile() as a separate "file".
      const { stdout } = await run(["diff", "--no-renames", "--name-only", "-z", a, b]);
      return stdout.split("\0").filter(Boolean);
    },
    async logSubjects(a, b) {
      const { stdout } = await run(["log", "--format=%s", `${a}..${b}`]);
      return stdout.split(/\r?\n/).filter(Boolean);
    },
    async show(spec) {
      const { stdout } = await run(["show", spec]);
      return stdout;
    },
    async pathExistsIn(rev, rel) {
      const { stdout } = await run(["ls-tree", "-z", rev, "--", rel]);
      return stdout.length > 0;
    },
  };
}

/**
 * Resolve the merge-base comparison point against the default branch.
 * Same resolution order as scripts/docs/validate-decision-records.mjs so the
 * two base-ref-dependent validators cannot drift: origin/HEAD first, then
 * GITHUB_BASE_REF (CI fetches it into origin/<base>), then main/master.
 */
async function resolveBaseRef(git, env = process.env) {
  let defaultBranch = null;
  try {
    defaultBranch = (await git.symbolicRef("refs/remotes/origin/HEAD")).replace(/^refs\/remotes\/origin\//, "");
  } catch {
    defaultBranch = null;
  }
  if (defaultBranch) return git.mergeBase(`origin/${defaultBranch}`, "HEAD");
  const candidates = [
    ...(env.GITHUB_BASE_REF ? [`origin/${env.GITHUB_BASE_REF}`] : []),
    ...["main", "master"].map((b) => `origin/${b}`),
  ];
  for (const branch of candidates) {
    try {
      const base = await git.mergeBase(branch, "HEAD");
      if (base) return base;
    } catch {
      // try next candidate
    }
  }
  return null;
}

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

  const [commitSubjects, files, headChangelog, baseExists] = await Promise.all([
    git.logSubjects(base, "HEAD"),
    git.diffNameOnly(base, "HEAD"),
    readFile(path.join(root, CHANGELOG_PATH), "utf8").catch(() => ""),
    git.pathExistsIn(base, CHANGELOG_PATH),
  ]);
  const baseChangelog = baseExists ? await git.show(`${base}:${CHANGELOG_PATH}`) : "";

  const { errors } = validateChangelogCompleteness({
    baseChangelog,
    headChangelog,
    commitSubjects,
    files,
  });
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
