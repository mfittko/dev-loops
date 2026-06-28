#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { extractSection, isDirectCliRun } from "./_refine-helpers.mjs";
import {
  validateSpikeExplorationSections,
  SPIKE_FILE_EXIT_MARKER_SECTION,
} from "./validate-spike-file.mjs";
import { evaluateSpikeIntakeState } from "@dev-loops/core/loop/spike-intake-contract";
import {
  evaluateSpikeExit,
  buildGraduatedPlanBody,
  SPIKE_EXIT_ACTION,
  SPIKE_EXIT_DISPOSITION,
} from "@dev-loops/core/loop/spike-exit-contract";

const USAGE = `Usage:
  exit-spike.mjs --spike-file <path> --disposition <discard|graduate> [--plan-file <path>] [--json]
Conclude a spike that has reached a Recommendation (spike_ready_for_exit).
  discard   The recommendation is "don't pursue": drop the spike with ZERO
            tracker artifacts. The findings doc is the whole record.
  graduate  Emit a #947-consumable local-first plan file (Status/Objective/
            In scope/Explicit non-goals) built from the spike's
            Question/Approach/Findings/Recommendation. The plan then enters the
            existing plan->PR promotion path (scripts/refine/promote-plan.mjs).
            --plan-file is required and graduation is idempotent (re-running
            reproduces the same plan file).

Fail-closed: a spike that is not ready for exit (no Recommendation) or an
unknown disposition makes ZERO tracker mutation and exits 1. No GitHub artifact
is created on any path; graduation only writes a local plan file.

Required:
  --spike-file <path>    Path to the spike findings artifact
  --disposition <which>  discard | graduate
Optional:
  --plan-file <path>     Output plan-file path (required for graduate)
  --json                 Machine-readable JSON output
  --help                 Show this help
Exit codes:
  0  Exit succeeded (discard recorded; or plan file written for graduate)
  1  Argument error, or fail-closed (not ready / unknown disposition)`.trim();

const parseError = buildParseError(USAGE);

export function parseExitSpikeCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "spike-file": { type: "string" },
      disposition: { type: "string" },
      "plan-file": { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, spikeFile: undefined, disposition: undefined, planFile: undefined, json: false };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "spike-file") {
      options.spikeFile = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "disposition") {
      options.disposition = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "plan-file") {
      options.planFile = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "json") {
      options.json = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (typeof options.spikeFile !== "string" || options.spikeFile.trim().length === 0) {
    throw parseError("exit-spike requires --spike-file <path>");
  }
  if (typeof options.disposition !== "string" || options.disposition.trim().length === 0) {
    throw parseError("exit-spike requires --disposition <discard|graduate>");
  }
  // graduate emits a plan file; the destination must be explicit so we never
  // guess a path. discard writes nothing, so --plan-file is irrelevant there.
  if (options.disposition === SPIKE_EXIT_DISPOSITION.GRADUATE
    && (typeof options.planFile !== "string" || options.planFile.trim().length === 0)) {
    throw parseError("exit-spike --disposition graduate requires --plan-file <path>");
  }
  return options;
}

function emit(stdout, json, summary, humanLines) {
  if (json) {
    stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    stdout.write(`${humanLines.join("\n")}\n`);
  }
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseExitSpikeCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }

  const spikePath = path.resolve(options.spikeFile);
  const markdownText = await readFile(spikePath, "utf8");

  // Compute the intake-state facts with the P1 surfaces, then hand them to the
  // pure exit decision. Per spike-intake-contract, `baseSectionsValid` is the
  // exploration scaffold (Question/Approach/Findings); the Recommendation is the
  // separate exit-marker that flips in-progress -> ready-for-exit. So a
  // scaffold-valid spike without a Recommendation classifies as in-progress
  // (fail-closed reason `not_ready_for_exit`), not ambiguous.
  const baseSectionsValid = validateSpikeExplorationSections(markdownText).ok;
  const hasRecommendation = Boolean(extractSection(markdownText, SPIKE_FILE_EXIT_MARKER_SECTION));
  const { state: spikeIntakeState } = evaluateSpikeIntakeState({ baseSectionsValid, hasRecommendation });
  const decision = evaluateSpikeExit({ spikeIntakeState, disposition: options.disposition });

  if (!decision.ok) {
    // Fail closed: no tracker artifact, no plan file — surface the reason.
    const summary = { ok: false, reason: decision.reason, spikeIntakeState: decision.spikeIntakeState ?? spikeIntakeState };
    emit(stdout, options.json, summary, [`exit-spike: FAIL (${decision.reason})`]);
    process.exitCode = 1;
    return summary;
  }

  // DISCARD: zero artifacts. The findings doc on disk is the whole record.
  if (decision.action === SPIKE_EXIT_ACTION.DISCARD) {
    const summary = { ok: true, action: SPIKE_EXIT_ACTION.DISCARD, spikeFile: spikePath };
    emit(stdout, options.json, summary, [
      "exit-spike: PASS (discard)",
      `  spike: ${spikePath}`,
      "  no tracker artifact created (findings doc is the record)",
    ]);
    return summary;
  }

  // GRADUATE: build a base-valid plan body from the spike sections and write it.
  // Pure builder owns the section mapping + fail-closed on empty sections; this
  // script owns the file I/O only. Overwriting the same path is idempotent.
  const planPath = path.resolve(options.planFile);
  const planBody = buildGraduatedPlanBody({
    question: extractSection(markdownText, "Question"),
    approach: extractSection(markdownText, "Approach"),
    findings: extractSection(markdownText, "Findings"),
    recommendation: extractSection(markdownText, SPIKE_FILE_EXIT_MARKER_SECTION),
  });
  await writeFile(planPath, planBody, "utf8");

  const summary = {
    ok: true,
    action: SPIKE_EXIT_ACTION.GRADUATE,
    spikeFile: spikePath,
    planFile: planPath,
  };
  emit(stdout, options.json, summary, [
    "exit-spike: PASS (graduate)",
    `  spike: ${spikePath}`,
    `  plan:  ${planPath} (local-first; promote with scripts/refine/promote-plan.mjs)`,
  ]);
  return summary;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
