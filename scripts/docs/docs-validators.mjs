#!/usr/bin/env node
/**
 * The one list of docs validators (`test:docs` in package.json calls it; the
 * pre-push delta `--result` run calls `runDocsValidators` in process).
 * Each validator writes its report to `out` and returns an exit code.
 */
import { fileURLToPath } from "node:url";

import { isDirectCliRun } from "../_core-helpers.mjs";
import { main as changelogMain } from "./validate-changelog-completeness.mjs";
import { run as decisionRecordsRun } from "./validate-decision-records.mjs";
import { run as linksRun } from "./validate-links.mjs";
import { run as ruleOwnershipRun } from "./validate-rule-ownership.mjs";

export const DOCS_VALIDATORS = Object.freeze([
  { id: "links", run: ({ root, out }) => linksRun({ root, out, err: out }) },
  { id: "rule-ownership", run: ({ root, out }) => ruleOwnershipRun({ root, out }) },
  { id: "decision-records", run: ({ root, out, git }) => decisionRecordsRun({ root, out, ...(git ? { git } : {}) }) },
  {
    id: "changelog",
    run: ({ root, out }) => changelogMain({ root, log: { log: (...args) => out.write(`${args.join(" ")}\n`), error: (...args) => out.write(`${args.join(" ")}\n`) } }),
  },
]);

/**
 * Run the validators named in `ids` (default: all, in list order).
 * @returns {Promise<Array<{ id: string, code: number, output: string, crashed: boolean }>>} `crashed`: the validator threw instead of returning a code
 */
export async function runDocsValidators({ root, ids = DOCS_VALIDATORS.map((v) => v.id), out, git } = {}) {
  const results = [];
  for (const validator of DOCS_VALIDATORS.filter((v) => ids.includes(v.id))) {
    let output = "";
    const sink = { write: (text) => { output += text; } };
    let code, crashed = false;
    try { code = await validator.run({ root, out: sink, git }); } catch (error) { output += `${error.message}\n`; code = 1; crashed = true; }
    out?.write(output);
    results.push({ id: validator.id, code, output, crashed });
  }
  return results;
}

if (isDirectCliRun(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const results = await runDocsValidators({ root, out: process.stdout });
  process.exitCode = results.some((r) => r.code !== 0) ? 1 : 0;
}
