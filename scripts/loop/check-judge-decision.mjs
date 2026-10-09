#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateSpecAuthorityDecision } from "@dev-loops/core/loop/spec-authority";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: check-judge-decision.mjs --file <spec-authority-verdict.json> [--jq <filter>] [--silent]

Read-only. Runs the ledger writer's per-decision validator on every decision in the judge's
spec-authority verdict file. The identities come from the verdict (specDigest, headSha,
contentDigest); the criterion set is the union of the decisions' checkedCriteria. A code-change
remedy needs defectClass and siteQuery; remedyKind "evidence_only" needs neither.
Exit 0 and print { ok: true, checked } when every decision is valid. Otherwise print
{ ok: false, error, code?, decisionIndex?, field? } and exit 1. The typed fields appear only when
a valid_compliant decision fails its remediation-scope check.

${JQ_OUTPUT_USAGE}`;

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = {};
  const { tokens } = parseArgs({
    args: argv,
    options: { file: { type: "string" }, help: { type: "boolean" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (token.name === "file") args.file = token.value;
    else if (token.name === "help") args.help = true;
    else matchJqOutputToken(token, args);
  }
  if (args.help || !args.file) {
    stdout.write(`${USAGE}\n`);
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  let result;
  try {
    const verdict = JSON.parse(await readFile(path.resolve(args.file), "utf8"));
    const decisions = Array.isArray(verdict?.decisions) ? verdict.decisions : [];
    const criterionIds = [...new Set(decisions.flatMap((d) => (Array.isArray(d?.checkedCriteria) ? d.checkedCriteria : [])))];
    for (const d of decisions) validateSpecAuthorityDecision(d, { specDigest: verdict.specDigest, headSha: verdict.headSha, contentDigest: verdict.contentDigest, criterionIds });
    result = { ok: true, checked: decisions.length };
  } catch (error) {
    result = { ok: false, error: error.message, ...(error.code ? { code: error.code, decisionIndex: error.decisionIndex, field: error.field } : {}) };
  }
  process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) await main();
