#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { summarizeGhCallLog } from "@dev-loops/core/github/gh-call-log";

const USAGE = `Usage:
  dev-loops loop gh-calls [--log <path>]
Read-only summary of the shared gh call log: calls per script, per PR and per
minute, the GraphQL share and the rate-limit refusals. Prints JSON.
Optional:
  --log <path>  Log file (default: <main checkout>/tmp/gh-calls.jsonl, or DEVLOOPS_GH_CALL_LOG)
  --help, -h    Show this help

Exit codes:
  0  Success
  1  Argument error or runtime failure`.trim();

const parseError = buildParseError(USAGE);

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { help: { type: "boolean", short: "h" }, log: { type: "string" } }, allowPositionals: false }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  stdout.write(`${JSON.stringify({ ok: true, ...summarizeGhCallLog(values.log) }, null, 2)}\n`);
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
