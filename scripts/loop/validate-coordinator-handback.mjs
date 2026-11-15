#!/usr/bin/env node
// Validates a coordinator hand-back packet before SubagentHandback (COORDINATOR-ROUND-BOUNDARY-HANDBACK, issue 3069).
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { validateCoordinatorHandback } from "./_coordinator-handback.mjs";

const USAGE = `Usage: validate-coordinator-handback.mjs --packet <path>
Reads the hand-back packet JSON ({pr, head, nextAction, workerRunning}) and prints the result.
Stdout: {ok:true} or {ok:false, refusal, message[, missing]}.
Exit codes: 0 valid, 1 refused, unreadable packet or usage error.`;

export async function runCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  let result;
  try {
    const { values } = parseArgs({ args: argv, options: { packet: { type: "string" }, help: { type: "boolean", short: "h" } } });
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
  stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) process.exitCode = await runCli();
