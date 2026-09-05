#!/usr/bin/env node
import { formatCliError } from "../_core-helpers.mjs";
import { detectAcDodMatrix } from "@dev-loops/core/loop/issue-refinement-artifact";
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
Validate required refinement artifacts (#1951): the AC / DoD mapping matrix (a valid semantic table), an explicit Non-goals section, and scope-boundary ownership prose (missing_scope_boundary). Interactive issue-side Acceptance criteria / Definition of done checklists are not required — the matrix is the authoritative AC→DoD artifact.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

// ponytail: distance caps ({0,200}? and {0,120}?) bound the gap between
// "owns"/"does not own"/(#N) so a single match cannot span the whole body.
// A boundary sentence exceeding these generous limits would false-negative;
// raise the caps if a real conforming boundary ever exceeds them.
const SCOPE_BOUNDARY_PATTERN = /\bowns?\b[\s\S]{0,200}?\bdoes\s+not\s+own\b[\s\S]{0,120}?\(\s*#\s*\d+\s*\)/iu;

function hasScopeBoundary(body) {
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }
  return SCOPE_BOUNDARY_PATTERN.test(body);
}

// #1951: validate the mapping table's SHAPE, not just the presence of pipe
// lines — an identifier-only/tautological table (`AC1 → D1`) or an empty
// header/separator-only table is invalid. Shares `detectAcDodMatrix` with the
// deterministic refinement detector so the epic verifier and the enqueue/draft
// gate cannot drift on what counts as a valid matrix.
function hasValidMatrix(issueBody) {
  return detectAcDodMatrix(typeof issueBody === "string" ? issueBody : "").valid === true;
}

export function runRefinementCompletenessChecker(tree) {
  const errors = [];

  for (const issue of tree.issues) {
    const nonGoals = extractSection(issue.body, "Non-goals");
    const acDodMatrix = extractSection(issue.body, "AC / DoD matrix");

    // #1951: the AC→DoD mapping matrix is the authoritative issue artifact for
    // AC and DoD; interactive issue-side `## Acceptance criteria` /
    // `## Definition of done` checklists are NOT required (they duplicate the
    // matrix). loop-grill synthesizes a matrix-only body, so requiring the
    // checklists here would false-block a grill-refined epic node. The floor is
    // a valid mapping matrix + explicit Non-goals + an explicit scope boundary.

    if (!nonGoals) {
      errors.push({ code: "missing_non_goals", issue: issue.number, message: "Missing ## Non-goals section." });
    }

    if (!acDodMatrix) {
      errors.push({ code: "missing_ac_dod_matrix", issue: issue.number, message: "Missing ## AC / DoD matrix section." });
    } else if (!hasValidMatrix(issue.body)) {
      errors.push({ code: "invalid_ac_dod_matrix", issue: issue.number, message: "AC / DoD matrix section must contain a semantic table mapping each acceptance-criterion outcome to concrete completion evidence (an empty or identifier-only/tautological table is invalid)." });
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
