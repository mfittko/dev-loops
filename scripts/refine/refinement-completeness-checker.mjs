#!/usr/bin/env node
import { formatCliError } from "../_core-helpers.mjs";
import {
  DEFAULT_USAGE_SUFFIX,
  extractSection,
  loadTreeFromInput,
  parseCheckerCliArgs,
  writeCheckerOutput,
  isDirectCliRun,
} from "./_refine-helpers.mjs";

const USAGE = `Usage:
  refinement-completeness-checker.mjs --input <path> [--json]
Validate required refinement sections: Acceptance criteria, Definition of done, Non-goals, and AC / DoD matrix.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

const SCOPE_BOUNDARY_PATTERN = /\bowns?\b[\s\S]{0,200}?\bdoes\s+not\s+own\b[\s\S]{0,120}?\(\s*#\s*\d+\s*\)/iu;

function hasScopeBoundary(body) {
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }
  return SCOPE_BOUNDARY_PATTERN.test(body);
}

function hasCheckbox(sectionText) {
  if (typeof sectionText !== "string") {
    return false;
  }
  return /^\s*-\s*\[\s\]\s+/imu.test(sectionText);
}

function hasMatrixTable(sectionText) {
  if (typeof sectionText !== "string") {
    return false;
  }
  const rows = sectionText
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  return rows.length >= 2;
}

export function runRefinementCompletenessChecker(tree) {
  const errors = [];

  for (const issue of tree.issues) {
    const acceptanceCriteria = extractSection(issue.body, "Acceptance criteria");
    const definitionOfDone = extractSection(issue.body, "Definition of done");
    const nonGoals = extractSection(issue.body, "Non-goals");
    const acDodMatrix = extractSection(issue.body, "AC / DoD matrix");

    if (!acceptanceCriteria) {
      errors.push({ code: "missing_acceptance_criteria", issue: issue.number, message: "Missing ## Acceptance criteria section." });
    } else if (!hasCheckbox(acceptanceCriteria)) {
      errors.push({ code: "missing_acceptance_checkbox", issue: issue.number, message: "Acceptance criteria section must include at least one '- [ ]' checkbox." });
    }

    if (!definitionOfDone) {
      errors.push({ code: "missing_definition_of_done", issue: issue.number, message: "Missing ## Definition of done section." });
    }

    if (!nonGoals) {
      errors.push({ code: "missing_non_goals", issue: issue.number, message: "Missing ## Non-goals section." });
    }

    if (!acDodMatrix) {
      errors.push({ code: "missing_ac_dod_matrix", issue: issue.number, message: "Missing ## AC / DoD matrix section." });
    } else if (!hasMatrixTable(acDodMatrix)) {
      errors.push({ code: "invalid_ac_dod_matrix", issue: issue.number, message: "AC / DoD matrix section must contain a markdown table." });
    }

    if (!hasScopeBoundary(issue.body)) {
      errors.push({ code: "missing_scope_boundary", issue: issue.number, message: "Issue body is missing an explicit scope boundary sentence (\"This issue owns X. It does NOT own Y (#NNN).\"). Required by EPIC-REFINEMENT-REQUIRED-CONTRACTS." });
    }
  }

  return {
    checker: "refinement-completeness-checker",
    ok: errors.length === 0,
    errors,
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseCheckerCliArgs(argv, USAGE, "refinement-completeness-checker");
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const tree = await loadTreeFromInput(options.input);
  const result = runRefinementCompletenessChecker(tree);
  process.exitCode = writeCheckerOutput(result, { stdout, json: options.json, jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
