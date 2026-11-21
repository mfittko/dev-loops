#!/usr/bin/env node
// Validates a coordinator hand-back packet before SubagentHandback (COORDINATOR-ROUND-BOUNDARY-HANDBACK, issue 3069).
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { validateCoordinatorHandback } from "./_coordinator-handback.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: validate-coordinator-handback.mjs --packet <path>
Reads the hand-back packet JSON ({pr, head, nextAction, workerRunning[, verdictRefusal: {reason: "ci_red", actListPath}]}) and prints the result.
A verdictRefusal needs nextAction "fix_ci_failure".
Stdout: {ok:true}, {ok:false, refusal, message[, missing][, recovery on verdict_refusal_route]}, or {ok:false, error} for a usage error or unreadable packet.
Exit codes: 0 valid, 1 refused, unreadable packet or usage error, 2 invalid --jq/--fields filter.

${JQ_OUTPUT_USAGE}`;

export async function runCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  let result;
  let values = {};
  try {
    ({ values } = parseArgs({ args: argv, options: { packet: { type: "string" }, help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS } }));
    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!values.packet) {
      stderr.write(`${USAGE}\n`);
      result = { ok: false, error: "--packet is required" };
    } else {
      result = validateCoordinatorHandback(JSON.parse(await readFile(values.packet, "utf8")));
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const code = emitResult(result, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
  // A refused packet never exits 0, whatever the output flags select.
  return code === 0 && result.ok === false ? 1 : code;
}

if (isDirectCliRun(import.meta.url)) process.exitCode = await runCli();
