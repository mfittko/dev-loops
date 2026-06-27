#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, parseJsonText } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { validatePlanFile } from "./validate-plan-file.mjs";
import { extractSection, isDirectCliRun } from "./_refine-helpers.mjs";
import {
  refinePlanFileInPlace,
  PLAN_FILE_REFINE_STOP,
} from "@dev-loops/core/loop/plan-file-refine-contract";
import { PLAN_FILE_REFINEMENT_SECTIONS } from "@dev-loops/core/loop/plan-file-intake-contract";
import { classifyDocsGrillFinding } from "../loop/docs-grill-contract.mjs";

const USAGE = `Usage:
  refine-plan-file.mjs --plan-file <path> --payload <path> [--json]
Refine a local plan file in place: write the refiner-produced Acceptance
criteria, Definition of done, coverage matrix, and recorded docs-grill
findings into the plan file, advance the intake state to
plan_refined_ready_for_promotion, and stop at a local human-review
checkpoint. Read-only against the tracker: no GitHub calls, no issue/PR/
comment, no promotion.

Required:
  --plan-file <path>  Path to the phase-doc-format plan file to refine in place
  --payload <path>    Path to a JSON file with the refiner output
                      ({ acceptanceCriteria, definitionOfDone, coverageMatrix,
                        grillFindings? })
Optional:
  --json              Machine-readable JSON output
  --help              Show this help
Exit codes:
  0  Refinement succeeded; plan written in place; stop for local human review
  1  Argument error, or fail-closed refine/grill/ambiguous state (no write)`.trim();

const parseError = buildParseError(USAGE);

export function parseRefinePlanFileCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "plan-file": { type: "string" },
      payload: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, planFile: undefined, payload: undefined, json: false };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "plan-file") {
      options.planFile = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "payload") {
      options.payload = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "json") {
      options.json = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (typeof options.planFile !== "string" || options.planFile.trim().length === 0) {
    throw parseError("refine-plan-file requires --plan-file <path>");
  }
  if (typeof options.payload !== "string" || options.payload.trim().length === 0) {
    throw parseError("refine-plan-file requires --payload <path>");
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseRefinePlanFileCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }

  const planPath = path.resolve(options.planFile);
  const markdownText = await readFile(planPath, "utf8");
  const payload = parseJsonText(await readFile(path.resolve(options.payload), "utf8"));

  // Read the section-presence facts with the P1 surfaces, then hand them to the
  // pure refine contract. The contract owns the state-machine gate and the
  // in-place rewrite; this script owns I/O only.
  // The docs-grill runs as a step of refinement. Classify each finding here (this
  // script owns the scripts/ boundary) with #948's classifier and pass the
  // dispositions to the pure core contract; an invalid finding yields a null
  // disposition, which the contract fails closed on (docs_grill_failed).
  const rawFindings = Array.isArray(payload?.grillFindings) ? payload.grillFindings : [];
  const grillDispositions = rawFindings.map((finding) => {
    const classified = classifyDocsGrillFinding(finding);
    return {
      kind: finding?.kind,
      summary: typeof finding?.summary === "string" ? finding.summary : "",
      disposition: classified.ok ? classified.disposition : null,
    };
  });

  const [acHeading, dodHeading] = PLAN_FILE_REFINEMENT_SECTIONS;
  const result = refinePlanFileInPlace({
    markdownText,
    baseSectionsValid: validatePlanFile(markdownText).ok,
    hasAcceptanceCriteria: extractSection(markdownText, acHeading) ? true : false,
    hasDefinitionOfDone: extractSection(markdownText, dodHeading) ? true : false,
    payload: { ...payload, grillDispositions },
  });

  if (!result.ok) {
    // Fail closed: surface the reason, do not write, do not advance, do not promote.
    if (options.json) {
      stdout.write(`${JSON.stringify({ ok: false, reason: result.reason, planFileIntakeState: result.planFileIntakeState ?? null })}\n`);
    } else {
      stdout.write(`refine-plan-file: FAIL (${result.reason})\n`);
    }
    process.exitCode = 1;
    return result;
  }

  // Write the refined plan back in place — the single canonical artifact.
  await writeFile(planPath, result.refinedMarkdown, "utf8");

  const summary = {
    ok: true,
    planFile: planPath,
    planFileIntakeState: result.planFileIntakeState,
    stop: result.stop,
    grillDispositions: result.grillDispositions,
  };
  if (options.json) {
    stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    stdout.write(
      [
        "refine-plan-file: PASS",
        `  plan: ${planPath}`,
        `  state: ${result.planFileIntakeState}`,
        `  stop: ${result.stop.kind} (${PLAN_FILE_REFINE_STOP.LOCAL_HUMAN_REVIEW === result.stop.kind ? "stop for local human review; no tracker artifact created" : result.stop.kind})`,
        `  grill findings recorded: ${result.grillDispositions.length}`,
      ].join("\n") + "\n",
    );
  }
  return summary;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
