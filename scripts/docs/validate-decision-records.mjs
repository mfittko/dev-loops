#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../_core-helpers.mjs";

const FILENAME_RE = /^\d{4}-[a-z0-9-]+\.md$/;
const TEMPLATE = "0000-template.md"; // permanently reserved template, not a record
const DECISIONS_DIR = "docs/decisions";

/**
 * Split a decision record into its Status section (lines under `## Status` up to
 * the next `## ` heading) and everything else. The Status heading stays in `rest`
 * (it is identical in both versions, so equality is unaffected).
 */
export function splitStatus(text) {
  const lines = text.split(/\r?\n/);
  const rest = [];
  const statusLines = [];
  let inStatus = false;
  for (const line of lines) {
    if (/^##\s+Status\s*$/.test(line)) {
      inStatus = true;
      rest.push(line);
      continue;
    }
    if (inStatus && /^##\s+\S/.test(line)) inStatus = false;
    if (inStatus) statusLines.push(line);
    else rest.push(line);
  }
  return { status: statusLines.join("\n"), rest: rest.join("\n") };
}

/** First non-empty, non-HTML-comment line of the Status section. */
export function firstMeaningfulLine(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("<!--"));
  return line || "";
}

/** A record whose base Status is Accepted or Superseded must not be edited in place (ADR-SUPERSEDE-NOT-REWRITE). */
export function isAcceptedOrSuperseded(statusText) {
  const root = firstMeaningfulLine(statusText);
  return /^Accepted\b/.test(root) || /^Superseded\b/.test(root);
}

/**
 * Index checks (ADR-PATH-NUMBERING): filename shape and unique four-digit prefix.
 * Returns a list of named errors, one per violation.
 */
export function detectIndexErrors(names) {
  const errors = [];
  const seen = new Map();
  for (const name of names) {
    if (name === TEMPLATE) continue; // template is exempt, not a record
    if (!FILENAME_RE.test(name)) {
      errors.push({
        kind: "adr_filename",
        rule: "ADR-PATH-NUMBERING",
        file: name,
        message: `filename '${name}' does not match NNNN-<slug>.md (ADR-PATH-NUMBERING)`,
      });
      continue;
    }
    const prefix = name.slice(0, 4);
    if (seen.has(prefix)) {
      errors.push({
        kind: "adr_duplicate_prefix",
        rule: "ADR-PATH-NUMBERING",
        file: name,
        prefix,
        message: `duplicate record number ${prefix} also used by ${seen.get(prefix)} (ADR-PATH-NUMBERING)`,
      });
    } else {
      seen.set(prefix, name);
    }
  }
  return errors;
}

function createGitClient(root, exec = promisify(execFile)) {
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
    async diffNameOnly(a, b, dir) {
      const { stdout } = await run(["diff", "--name-only", a, b, "--", dir]);
      return stdout.split(/\r?\n/).filter(Boolean);
    },
    async show(spec) {
      const { stdout } = await run(["show", spec]);
      return stdout;
    },
  };
}

async function resolveBaseRef(git) {
  let defaultBranch = null;
  try {
    defaultBranch = (await git.symbolicRef("refs/remotes/origin/HEAD")).replace(/^refs\/remotes\/origin\//, "");
  } catch {
    defaultBranch = null;
  }
  if (defaultBranch) return git.mergeBase(`origin/${defaultBranch}`, "HEAD");
  for (const branch of ["main", "master"]) {
    try {
      const base = await git.mergeBase(`origin/${branch}`, "HEAD");
      if (base) return base;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Validate decision records under `docs/decisions`.
 *
 * Rules enforced:
 *  - ADR-PATH-NUMBERING: filename shape + unique numeric prefix (`0000-template.md` exempt).
 *  - ADR-SUPERSEDE-NOT-REWRITE: in base-ref mode, a record whose base Status is Accepted
 *    or Superseded must not change any line outside its Status section.
 *
 * Rule 3 is base-ref dependent (git merge-base origin/<default> HEAD). When the base ref
 * cannot be resolved (shallow checkout, no origin), it degrades gracefully: rule 3 is
 * skipped with a notice instead of failing every local run.
 */
export async function validateDecisionRecords({ root, git = createGitClient(root) }) {
  const dir = path.join(root, DECISIONS_DIR);
  const errors = [];
  let names;
  try {
    const entries = await readdir(dir);
    names = entries.filter((e) => e.endsWith(".md")).sort();
  } catch {
    names = [];
  }

  errors.push(...detectIndexErrors(names));

  let rule3 = { state: "not_run", notice: null };
  // Only base-resolution failures degrade rule 3 (the legitimate no-history case).
  // Any error inside the per-record loop is a real failure and must surface
  // (fail closed) rather than silently disabling the guard.
  let base = null;
  try {
    base = await resolveBaseRef(git);
  } catch {
    base = null;
  }
  if (!base) {
    rule3 = { state: "degraded", notice: "base ref unavailable; skipping ADR-SUPERSEDE-NOT-REWRITE post-acceptance edit check" };
  } else {
    const changed = await git.diffNameOnly(base, "HEAD", DECISIONS_DIR);
    for (const rel of changed) {
      const baseName = path.posix.basename(rel);
      if (baseName === TEMPLATE || !rel.endsWith(".md")) continue;
      let baseText;
      try {
        baseText = await git.show(`${base}:${rel}`);
      } catch {
        continue; // path absent from base: newly added record, not blocked
      }
      const { status: baseStatus, rest: baseRest } = splitStatus(baseText);
      if (!isAcceptedOrSuperseded(baseStatus)) continue; // Proposed records may still change
      let currentText;
      try {
        currentText = await readFile(path.join(root, rel), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") {
          // Deleting an Accepted/Superseded record is itself a post-acceptance
          // rewrite; refuse it instead of passing silently.
          errors.push({
            kind: "adr_post_acceptance_rewrite",
            rule: "ADR-SUPERSEDE-NOT-REWRITE",
            file: rel,
            message: `accepted/superseded record '${rel}' was deleted (ADR-SUPERSEDE-NOT-REWRITE)`,
          });
        } else {
          throw err; // real read error surfaces (fail closed)
        }
        continue;
      }
      if (splitStatus(currentText).rest !== baseRest) {
        errors.push({
          kind: "adr_post_acceptance_rewrite",
          rule: "ADR-SUPERSEDE-NOT-REWRITE",
          file: rel,
          message: `accepted/superseded record '${rel}' was edited outside its Status section (ADR-SUPERSEDE-NOT-REWRITE)`,
        });
      }
    }
    rule3 = { state: "ran" };
  }

  return { ok: errors.length === 0, errors, filesScanned: names.length, rule3 };
}

function resolveDefaultRepoRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function renderError(error) {
  return `${error.rule}: ${error.file} - ${error.message}`;
}

async function main() {
  const root = resolveDefaultRepoRoot();
  const result = await validateDecisionRecords({ root });
  if (result.rule3.notice) process.stdout.write(`${result.rule3.notice}\n`);
  if (result.ok) {
    process.stdout.write(`Decision record validation passed: ${result.filesScanned} records; rule 3 ${result.rule3.state}.\n`);
    return 0;
  }
  process.stdout.write(`Decision record validation failed (${result.errors.length}):\n`);
  for (const error of result.errors) process.stdout.write(`- ${renderError(error)}\n`);
  return 1;
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
