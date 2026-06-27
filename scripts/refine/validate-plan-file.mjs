#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { formatCliError } from "../_core-helpers.mjs";
import {
  DEFAULT_USAGE_SUFFIX,
  extractSection,
  parseCheckerCliArgs,
  writeCheckerOutput,
  isDirectCliRun,
} from "./_refine-helpers.mjs";

const USAGE = `Usage:
  validate-plan-file.mjs --input <path> [--json]
Validate the base authoring sections of a phase-doc-format plan file: Status, Objective, In scope, Explicit non-goals.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

/**
 * Base authoring sections a phase doc carries before refinement adds AC/DoD.
 * Heading → distinct missing_* error code.
 */
export const PLAN_FILE_BASE_SECTIONS = ["Status", "Objective", "In scope", "Explicit non-goals"];

const SECTION_CODES = {
  Status: "missing_status",
  Objective: "missing_objective",
  "In scope": "missing_in_scope",
  "Explicit non-goals": "missing_explicit_non_goals",
};

/**
 * Pure validator. Reports whether a plan file (phase-doc format) carries every
 * base authoring section with a non-empty body. An absent or empty-body section
 * is reported under that section's distinct missing_* code. No side effects.
 *
 * @param {string} markdownText
 * @returns {{ checker: "validate-plan-file", ok: boolean, errors: { code: string, message: string }[] }}
 */
export function validatePlanFile(markdownText) {
  const errors = [];
  // extractSection returns the trimmed body (empty string for an empty section)
  // or null when the heading is absent — both are malformed here.
  for (const heading of PLAN_FILE_BASE_SECTIONS) {
    const body = extractSection(markdownText, heading);
    if (!body) {
      errors.push({ code: SECTION_CODES[heading], message: `Missing or empty ## ${heading} section.` });
    }
  }
  return { checker: "validate-plan-file", ok: errors.length === 0, errors };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseCheckerCliArgs(argv, USAGE, "validate-plan-file");
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const markdownText = await readFile(options.input, "utf8");
  const result = validatePlanFile(markdownText);
  writeCheckerOutput(result, { stdout, json: options.json });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
