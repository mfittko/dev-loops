#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkRemediationScopes } from "@dev-loops/core/loop/spec-authority";
import { isDirectCliRun } from "../_core-helpers.mjs";

const USAGE = `Usage: check-judge-decision.mjs --file <spec-authority-verdict.json>

Read-only. Checks every valid_compliant decision in the judge's spec-authority verdict
file: a code-change remedy needs defectClass and siteQuery; remedyKind "evidence_only"
needs neither. Exit 0 when every decision is valid. Otherwise prints
{ ok: false, error, decisionIndex, field } and exits 1.`;

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { file: { type: "string" }, help: { type: "boolean" } } });
  if (values.help || !values.file) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  let result;
  try {
    const verdict = JSON.parse(await readFile(path.resolve(values.file), "utf8"));
    result = { ok: true, checked: checkRemediationScopes(verdict) };
  } catch (error) {
    result = { ok: false, error: error.message, ...(error.code ? { code: error.code, decisionIndex: error.decisionIndex, field: error.field } : {}) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) await main();
