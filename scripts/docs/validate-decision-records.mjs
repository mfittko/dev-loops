#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../_core-helpers.mjs";
import { createGitClient, resolveBaseRef } from "./_doc-git-client.mjs";

const FILENAME_RE = /^\d{4}-[a-z0-9-]+\.md$/;
const TEMPLATE = "0000-template.md"; // permanently reserved template, not a record
const DECISIONS_DIR = "docs/decisions";

/**
 * Split a decision record into its Status section (lines under `## Status` up to
 * the next `## ` heading) and everything else. The Status heading stays in `rest`
 * (the heading's own text is identical in both versions, so it never affects the
 * rest-equality comparison). A benign deviating heading (e.g. trailing punctuation
 * like `## Status:`) is still recognized as the section boundary.
 */
export function splitStatus(text) {
  const lines = text.split(/\r?\n/);
  const rest = [];
  const statusLines = [];
  let inStatus = false;
  for (const line of lines) {
    // Tolerate benign trailing punctuation (e.g. `## Status:`); a deviating
    // heading must not silently fail open and disable rule 3 for the record.
    if (/^##\s+Status\s*[:;]?\s*$/.test(line)) {
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

/** First non-empty line of the Status section, skipping any leading HTML comment
 * block (single- or multi-line, e.g. the `0000-template.md` instructional comment). */
export function firstMeaningfulLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let inComment = false;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    return line;
  }
  return "";
}

/** A record whose base Status is Accepted or Superseded must not be edited in place (ADR-SUPERSEDE-NOT-REWRITE). */
export function isAcceptedOrSuperseded(statusText) {
  const root = firstMeaningfulLine(statusText);
  return /^Accepted\b/.test(root) || /^Superseded\b/.test(root);
}

/**
 * Normalize a record body for the renumber comparison: the H1's four-digit
 * record number is identity, not body content, so a pure renumber
 * (`# 0095. X` -> `# 0096. X`) compares equal while every other body edit still
 * differs. Anchored at the start of the body, which is the record's H1 line.
 */
export function normalizeRecordNumber(bodyText) {
  return bodyText.replace(/^#\s+\d{4}\./, "# NNNN.");
}

/**
 * The four-digit number in a record's H1 (`# 0096. Title`), or null when the
 * body does not open with one. The renumber exception requires the destination's
 * H1 number to match its new filename, so a rename that leaves a stale H1 number
 * behind is refused rather than silently creating a filename/H1 mismatch.
 */
export function recordTitleNumber(recordText) {
  const match = recordText.match(/^#\s+(\d{4})\./);
  return match ? match[1] : null;
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
        message: `duplicate record number ${prefix} in '${name}' also used by ${seen.get(prefix)} (ADR-PATH-NUMBERING)`,
      });
    } else {
      seen.set(prefix, name);
    }
  }
  return errors;
}

// createGitClient + resolveBaseRef are shared with validate-changelog-completeness.mjs
// via ./_doc-git-client.mjs so the two base-ref-dependent validators cannot
// drift. This validator scopes diffNameOnly to the decisions dir and, unlike the
// changelog one, uses newline-delimited names and never calls logSubjects.
// Re-exported here for the injected-git test suite.
export { createGitClient };

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
 *
 * Scope boundary: rule 3 deliberately guards only edits OUTSIDE a record's
 * Status section. Edits INSIDE the Status section of an accepted record (e.g. an appended
 * annotation beyond the sanctioned Accepted -> Superseded flip) are NOT auto-enforced here:
 * judging whether a record's Status content is correct is a declared non-goal, and the
 * pre-existing 0047 incident of that class was resolved by reverting the record, not by
 * retro-validation.
 *
 * Renumber tolerance (0097): a record that is already on the base branch cannot be
 * renumbered without a delete+add pair, so the deletion guard would refuse the only
 * legal repair for a duplicate record number. Rule 3 therefore also reads a
 * rename-detecting `diffNameStatus` and treats an `R` as a legal renumber only when
 * every one of these holds: the destination is a direct record-shaped file under
 * `docs/decisions` (a nested path would drop the record out of the catalog with no
 * guard firing), the destination's H1 number matches its new filename, and the body
 * outside `## Status` equals the base body with the H1 number normalized. Every other
 * rename is still refused, and the delete/add path (`diffNameOnly`, `--no-renames`) is
 * unchanged, so a bare delete and an add-only still fail closed.
 */
export async function validateDecisionRecords({ root, git = createGitClient(root) }) {
  const dir = path.join(root, DECISIONS_DIR);
  const errors = [];
  let names;
  try {
    const entries = await readdir(dir);
    names = entries.filter((e) => e.endsWith(".md")).sort();
  } catch (err) {
    // docs/decisions is an internal path that is always expected to exist;
    // a genuine readdir failure must fail closed, not silently skip ALL index
    // checks while reporting a successful '0 records scanned'.
    throw new Error(`unable to read ${DECISIONS_DIR}: ${err.message}`);
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
    const changed = await git.diffNameOnly(base, "HEAD", { dir: DECISIONS_DIR });
    // Rename detection is read separately (0097): the delete/add truth above stays
    // `--no-renames`, so a rename can never collapse there and hide a delete.
    const renameTargets = new Map(
      (await git.diffNameStatus(base, "HEAD", { dir: DECISIONS_DIR }))
        .filter(({ status }) => status.startsWith("R"))
        .map(({ from, to }) => [from, to]),
    );
    for (const rel of changed) {
      const baseName = path.posix.basename(rel);
      if (baseName === TEMPLATE || !rel.endsWith(".md")) continue;
      // Only a genuinely absent base path (a newly added record) skips rule 3.
      // Any other git failure (corrupt object, invalid rev) must surface (fail
      // closed) rather than silently disabling the guard for the record — see
      // the fail-closed invariant above.
      if (!(await git.pathExistsIn(base, rel))) continue;
      const baseText = await git.show(`${base}:${rel}`);
      const { status: baseStatus, rest: baseRest } = splitStatus(baseText);
      if (!isAcceptedOrSuperseded(baseStatus)) continue; // Proposed records may still change
      let currentText;
      try {
        currentText = await readFile(path.join(root, rel), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") {
          const renamedTo = renameTargets.get(rel);
          // A renumber is only ever a record-to-record move: the destination must
          // stay a direct record under docs/decisions, and its H1 number must match
          // its new filename. Anything else is not a renumber and is refused below.
          const renamedBase = renamedTo === undefined ? null : path.posix.basename(renamedTo);
          if (renamedTo !== undefined
            && path.posix.dirname(renamedTo) === DECISIONS_DIR
            && FILENAME_RE.test(renamedBase)) {
            const renamedText = await readFile(path.join(root, renamedTo), "utf8");
            const staleTitleNumber = recordTitleNumber(renamedText) !== renamedBase.slice(0, 4);
            const editedBody = normalizeRecordNumber(splitStatus(renamedText).rest) !== normalizeRecordNumber(baseRest);
            if (staleTitleNumber || editedBody) {
              errors.push({
                kind: "adr_post_acceptance_rewrite",
                rule: "ADR-SUPERSEDE-NOT-REWRITE",
                file: rel,
                message: staleTitleNumber
                  ? `accepted/superseded record '${rel}' was renamed to '${renamedTo}' without matching its new record number in the H1 (ADR-SUPERSEDE-NOT-REWRITE)`
                  : `accepted/superseded record '${rel}' was renamed to '${renamedTo}' and edited outside its Status section (ADR-SUPERSEDE-NOT-REWRITE)`,
              });
            }
            continue;
          }
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
  // error.message already embeds the rule (and, where relevant, the file); the
  // `file` field is a structured convenience for tests, not a second prefix.
  return error.message;
}

/**
 * Run the validator end to end, returning the process exit code. Injectable
 * `root`/`git`/`env`/`out` keep the CLI path unit-testable (so the CI-degrade
 * fail-closed guard is mutation-anchored rather than only reachable through a
 * real CI run).
 */
export async function run({ root = resolveDefaultRepoRoot(), git = createGitClient(root), env = process.env, out = process.stdout } = {}) {
  const result = await validateDecisionRecords({ root, git });
  if (result.rule3.notice) out.write(`${result.rule3.notice}\n`);
  if (result.ok) {
    // In CI, rule 3 must actually have run: a silent degrade must not report
    // green without the post-acceptance-edit guard executing (ci-guard).
    if (result.rule3.state === "degraded" && env.CI) {
      out.write("Decision record validation failed: rule 3 degraded in CI (base ref unavailable); it must run to enforce ADR-SUPERSEDE-NOT-REWRITE.\n");
      return 1;
    }
    out.write(`Decision record validation passed: ${result.filesScanned} records; rule 3 ${result.rule3.state}.\n`);
    return 0;
  }
  out.write(`Decision record validation failed (${result.errors.length}):\n`);
  for (const error of result.errors) out.write(`- ${renderError(error)}\n`);
  return 1;
}

async function main() {
  return run();
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
