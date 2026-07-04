#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { formatCliError } from "../_core-helpers.mjs";
import {
  DEFAULT_USAGE_SUFFIX,
  checkBaseSections,
  parseCheckerCliArgs,
  writeCheckerOutput,
  isDirectCliRun,
} from "./_refine-helpers.mjs";

const USAGE = `Usage:
  validate-spike-file.mjs --input <path> [--json]
Validate the base authoring sections of a spike artifact: Question, Approach, Findings, Recommendation.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

/**
 * Base authoring sections a spike artifact carries.
 * Heading → distinct missing_* error code.
 */
const SECTION_CODES = {
  Question: "missing_question",
  Approach: "missing_approach",
  Findings: "missing_findings",
  Recommendation: "missing_recommendation",
};

export const SPIKE_FILE_BASE_SECTIONS = Object.keys(SECTION_CODES);

/**
 * Recommendation is the exit-marker section: present + non-empty means the
 * spike has reached a recommendation and is ready for a discard/graduate exit
 * decision. The exploration scaffold (Question/Approach/Findings) is what an
 * in-progress spike must carry for `--spike` entry. (Mirrors the plan-file
 * base-vs-refinement-section split.)
 */
export const SPIKE_FILE_EXIT_MARKER_SECTION = "Recommendation";
export const SPIKE_FILE_EXPLORATION_SECTIONS = SPIKE_FILE_BASE_SECTIONS.filter(
  (h) => h !== SPIKE_FILE_EXIT_MARKER_SECTION,
);

const EXPLORATION_SECTION_CODES = Object.fromEntries(
  SPIKE_FILE_EXPLORATION_SECTIONS.map((h) => [h, SECTION_CODES[h]]),
);

/**
 * Pure validator. Reports whether a spike artifact carries every base authoring
 * section with a non-empty body. An absent or empty-body section is reported
 * under that section's distinct missing_* code. No side effects.
 *
 * @param {string} markdownText
 * @returns {{ checker: "validate-spike-file", ok: boolean, errors: { code: string, message: string }[] }}
 */
export function validateSpikeFile(markdownText) {
  return checkBaseSections(markdownText, "validate-spike-file", SECTION_CODES);
}

/**
 * Entry-gate validator for `--spike`: a spike is startable as soon as it carries
 * the exploration scaffold (Question/Approach/Findings) with non-empty bodies;
 * the Recommendation is filled in DURING the spike, not required to begin one.
 *
 * @param {string} markdownText
 * @returns {{ checker: "validate-spike-file", ok: boolean, errors: { code: string, message: string }[] }}
 */
export function validateSpikeExplorationSections(markdownText) {
  return checkBaseSections(markdownText, "validate-spike-file", EXPLORATION_SECTION_CODES);
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseCheckerCliArgs(argv, USAGE, "validate-spike-file");
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const markdownText = await readFile(options.input, "utf8");
  const result = validateSpikeFile(markdownText);
  process.exitCode = writeCheckerOutput(result, { stdout, json: options.json, jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
