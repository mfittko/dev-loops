#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { GH_CALL_LOG_ENV, resolveGhCallLogPath, summarizeGhCallLog } from "@dev-loops/core/github/gh-call-log";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  dev-loops loop gh-calls [--log <path>]
Read-only summary of the shared gh call log: calls per script, per PR and per
minute, the GraphQL share and the rate-limit refusals. Prints JSON.
Optional:
  --log <path>  Log file (default: <main checkout>/tmp/gh-calls.jsonl, or DEVLOOPS_GH_CALL_LOG)
  --help, -h    Show this help

${JQ_OUTPUT_USAGE}

Exit codes:
  0  Success
  1  Argument error or runtime failure`.trim();

const parseError = buildParseError(USAGE);

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { help: { type: "boolean", short: "h" }, log: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, allowPositionals: false }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  if (values.log !== undefined && values.log.trim() === "") throw parseError("--log requires a non-empty path");
  // A relative --log resolves against the main checkout, like DEVLOOPS_GH_CALL_LOG.
  const logPath = values.log === undefined ? undefined : resolveGhCallLogPath(process.cwd(), { [GH_CALL_LOG_ENV]: values.log.trim() });
  process.exitCode = emitResult({ ok: true, ...summarizeGhCallLog(logPath) }, { jq: values.jq, silent: values.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
