#!/usr/bin/env node
/**
 * seal-evidence
 *
 * Seals a review evidence file to the run that produced it (GATE-EXEC-EVIDENCE-SEALED).
 * Kind `delta`: the file is a DeltaPrePushReviewResult; the run key derives from its heads and its runId.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { deltaResultKey, sealEvidence } from "@dev-loops/core/loop/evidence-seal";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: seal-evidence.mjs --kind delta --file <path> [--tmp-root <path>]

Seals the reviewer's result file to its producing run. Run it right after writing the file.
${JQ_OUTPUT_USAGE}
Exit codes: 0 sealed, 2 refused (typed reason: evidence_run_missing, evidence_foreign_run, evidence_malformed) or bad input.`;

export function runCli(argv = process.argv.slice(2), { stdout = process.stdout, cwd = process.cwd() } = {}) {
  const { values } = parseArgs({ args: argv, options: { kind: { type: "string" }, file: { type: "string" }, "tmp-root": { type: "string" }, help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
  if (values.help) { stdout.write(`${USAGE}\n`); return; }
  if (values.kind !== "delta" || !values.file) throw new Error("--kind delta and --file are required");
  const file = path.resolve(cwd, values.file);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const tmpRoot = values["tmp-root"] ? path.resolve(cwd, values["tmp-root"]) : resolveGateArtifactTmpRoot(cwd);
  const sealed = sealEvidence(tmpRoot, deltaResultKey(parsed), file, parsed);
  process.exitCode = emitResult({ ok: true, sealed }, { jq: values.jq, silent: values.silent, fields: values.fields, stdout });
}

if (isDirectCliRun(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  }
}
