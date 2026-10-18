#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadDevLoopConfig, resolveBaseBranch } from "@dev-loops/core/config";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { PRE_PR_REVIEW_DISPOSITIONS, PRE_PR_REVIEW_VERDICTS, writePrePrReviewRecord } from "./_pre-pr-review-record.mjs";
import { PRE_PR_STALE_SURFACE_UNADDRESSED, readSkipsFile, requireStaleSurfaceAddressed, scanPrePrStaleSurface } from "./_pre-pr-stale-surface.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: record-pre-pr-review.mjs --verdict <${PRE_PR_REVIEW_VERDICTS.join("|")}> --disposition <${PRE_PR_REVIEW_DISPOSITIONS.join("|")}> [sweep flags]
       record-pre-pr-review.mjs --scan [sweep flags]
Sanctioned writer of the pre-PR review record (PRE-PR-BEFORE-FIRST-PUSH). Run it after the
pre-PR review and its fixes are committed. It reads the head from git (no head argument) and
writes <main-tmp-root>/pre-pr-review/<head>.json. \`pr create\` refuses with
pre_pr_review_missing when no valid record covers the branch head.
Before writing, it rescans base...HEAD (PRE-PR-STALE-SURFACE-SWEEP) and refuses with
pre_pr_stale_surface_unaddressed while a hit is neither fixed nor skipped with a reason.
Required:
  --verdict <v>        Reviewer verdict: ${PRE_PR_REVIEW_VERDICTS.join(" | ")}
  --disposition <d>    Act-list disposition: ${PRE_PR_REVIEW_DISPOSITIONS.join(" | ")}
Sweep flags:
  --scan               Print the sweep result and write nothing (paste it into the reviewer brief)
  --base <ref>         Base ref of base...HEAD (default: origin/<configured base branch>)
  --body-file <path>   PR body file to compare with the linked issue (pair with --issue)
  --issue <n>          Linked issue number (pair with --body-file); omit when the PR body is the spec
  --skips-file <path>  JSON array of { "site": "<file>|<file>:<line>|<file>:<a>-<b>", "reason": "<non-empty>" }
Output (stdout, JSON): { "ok": true, "head", "verdict", "disposition", "file" }
Scan output (stdout, JSON): { "ok", "head", "base", "staleSurfaceHits", "staleSurfaceTruncated", "truncatedNeedles" }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);

async function defaultBase(cwd) {
  let config = null;
  try { ({ config } = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(cwd) })); } catch { config = null; }
  return `origin/${resolveBaseBranch(config, { cwd })}`;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), readIssueBody } = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" }, verdict: { type: "string" }, disposition: { type: "string" }, scan: { type: "boolean" }, base: { type: "string" }, "body-file": { type: "string" }, issue: { type: "string" }, "skips-file": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS }, strict: true });
    if (values.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (!values.scan && (!values.verdict || !values.disposition)) throw parseError("pre-pr-review requires --verdict and --disposition (or --scan)");
    if (Boolean(values["body-file"]) !== Boolean(values.issue)) throw parseError("--body-file and --issue come as a pair");
    const output = { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr };
    const scan = await scanPrePrStaleSurface({ cwd, base: values.base ?? await defaultBase(cwd), bodyFile: values["body-file"], issue: values.issue, ...(readIssueBody ? { readIssueBody } : {}) });
    if (values.scan) return emitResult(scan, output);
    requireStaleSurfaceAddressed(scan, readSkipsFile(values["skips-file"]));
    const { record, file } = writePrePrReviewRecord({ cwd, verdict: values.verdict, disposition: values.disposition });
    return emitResult({ ok: true, head: record.head, verdict: record.verdict, disposition: record.disposition, file }, output);
  } catch (error) {
    const envelope = JSON.parse(formatCliError(error));
    if (error?.code === PRE_PR_STALE_SURFACE_UNADDRESSED) envelope.code = error.code;
    stderr.write(`${JSON.stringify(envelope)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
