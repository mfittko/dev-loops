#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkRemediationScopes } from "@dev-loops/core/loop/spec-authority";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: check-judge-decision.mjs --file <spec-authority-verdict.json> [--jq <filter>] [--silent]

Read-only. Checks every valid_compliant decision in the judge's spec-authority verdict
file: a code-change remedy needs defectClass and siteQuery; remedyKind "evidence_only"
needs neither. Exit 0 when every decision is valid. Otherwise prints
{ ok: false, error, decisionIndex, field } and exits 1.

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
    result = { ok: true, checked: checkRemediationScopes(verdict) };
  } catch (error) {
    result = { ok: false, error: error.message, ...(error.code ? { code: error.code, decisionIndex: error.decisionIndex, field: error.field } : {}) };
  }
  process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) await main();
