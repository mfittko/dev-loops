#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { PRE_PR_REVIEW_DISPOSITIONS, PRE_PR_REVIEW_VERDICTS, writePrePrReviewRecord } from "./_pre-pr-review-record.mjs";

const USAGE = `Usage: record-pre-pr-review.mjs --verdict <${PRE_PR_REVIEW_VERDICTS.join("|")}> --disposition <${PRE_PR_REVIEW_DISPOSITIONS.join("|")}>
Sanctioned writer of the pre-PR review record (PRE-PR-BEFORE-FIRST-PUSH). Run it after the
pre-PR review and its fixes are committed. It reads the head from git (no head argument) and
writes <main-tmp-root>/pre-pr-review/<head>.json. \`pr create\` refuses with
pre_pr_review_missing when no valid record covers the branch head.
Required:
  --verdict <v>        Reviewer verdict: ${PRE_PR_REVIEW_VERDICTS.join(" | ")}
  --disposition <d>    Act-list disposition: ${PRE_PR_REVIEW_DISPOSITIONS.join(" | ")}
Output (stdout, JSON): { "ok": true, "head", "verdict", "disposition", "file" }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, verdict: { type: "string" }, disposition: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (values.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (!values.verdict || !values.disposition) throw parseError("pre-pr-review requires --verdict and --disposition");
    const { record, file } = writePrePrReviewRecord({ cwd, verdict: values.verdict, disposition: values.disposition });
    return emitResult({ ok: true, head: record.head, verdict: record.verdict, disposition: record.disposition, file }, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
