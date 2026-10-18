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
Stdout: {ok:true,workOrder,workOrderDigest} on success, {ok:false,error} on failure (nothing under --silent).
A failure ignores --fields and --jq.
Exit codes: 0 emitted, 1 refused or runtime failure, 2 invalid --jq/--fields usage on success output.`;

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  const options = {
    input: { type: "string" }, repo: { type: "string" }, "allowed-file": { type: "string", multiple: true },
    attempt: { type: "string" }, help: { type: "boolean", short: "h" }, ...JQ_OUTPUT_PARSE_OPTIONS,
  };
  // One failure shape: {ok:false,error} on stdout unless --silent; --fields and --jq never apply to a failure.
  const fail = (error, stderrText) => {
    if (!(values?.silent ?? parseArgs({ args: argv, options, strict: false }).values.silent)) stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    stderr.write(`${stderrText}\n`);
    return 1;
  };
  try {
    ({ values } = parseArgs({ args: argv, options }));
    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (!values.input) {
      return fail("--input is required", USAGE);
    }
    if (values.attempt !== undefined && !/^[1-9]\d*$/.test(values.attempt)) {
      throw new CoordinatorWorkOrderRefusal("--attempt must be a positive integer");
    }
    const envelope = await buildHandoffEnvelopeCli({ inputPath: values.input, repo: values.repo });
    const { workOrder, workOrderDigest } = buildCoordinatorWorkOrder({
      envelope, allowedFiles: values["allowed-file"] ?? [], ...(values.attempt !== undefined ? { attempt: Number(values.attempt) } : {}),
    });
    return emitResult({ ok: true, workOrder, workOrderDigest }, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), formatCliError(err));
  }
}

if (isDirectCliRun(import.meta.url)) process.exitCode = await runCli();
