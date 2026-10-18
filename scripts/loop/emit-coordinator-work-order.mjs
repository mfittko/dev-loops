#!/usr/bin/env node
/**
 * Coordinator work order adapter (issue 2483, slice 1). Derives the envelope from the
 * startup resolver output through build-handoff-envelope.mjs and prints the coordinator
 * work order and its digest. It accepts no brief, summary file, overrides or payload JSON.
 */
import { parseArgs } from "node:util";
import { buildCoordinatorWorkOrder, CoordinatorWorkOrderRefusal } from "@dev-loops/core/loop/coordinator-work-order";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { buildHandoffEnvelopeCli } from "./build-handoff-envelope.mjs";

const USAGE = `Usage: emit-coordinator-work-order.mjs --input <resolver-output.json> [--repo <owner/name>] [--allowed-file <path>]... [--attempt <n>]
Derives the coordinator work order from the resolved handoff envelope. The allowed-file list
always includes changes/<issue>-*.md (the PR number for a unit without an issue).
${JQ_OUTPUT_USAGE}
Exit codes: 0 emitted, 1 refused or runtime failure.`;

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      input: { type: "string" }, repo: { type: "string" }, "allowed-file": { type: "string", multiple: true },
      attempt: { type: "string" }, help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS,
    } });
    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!values.input) {
      stderr.write(`--input is required\n${USAGE}\n`);
      return 1;
    }
    const envelope = await buildHandoffEnvelopeCli({ inputPath: values.input, repo: values.repo });
    const { workOrder, workOrderDigest } = buildCoordinatorWorkOrder({
      envelope, allowedFiles: values["allowed-file"] ?? [], ...(values.attempt ? { attempt: Number(values.attempt) } : {}),
    });
    return emitResult({ ok: true, workOrder, workOrderDigest }, { jq: values.jq, silent: values.silent, stdout, stderr });
  } catch (err) {
    if (err instanceof CoordinatorWorkOrderRefusal) return emitResult({ ok: false, error: err.message }, { stdout, stderr });
    stdout.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
    stderr.write(`${formatCliError(err)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) process.exitCode = await runCli();
