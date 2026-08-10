// #1616 contract test: the verdict-consistency enforcement in
// upsert-checkpoint-verdict.mjs must match GATE-COMMENT-VERDICT-VALUES's stated
// meaning, so the script-level constraint and the doc-level rule cannot drift.
//
// The rule (skills/docs/gate-review-comment-contract.md) defines:
//   clean            = no findings with a severity in the gate's
//                      blockCleanOnFindingSeverities remain
//   findings_present = the gate found issues at blocking severities; fixes are
//                      required before the gate boundary can be crossed
//
// consolidate-fanin.mjs computes `overallVerdict` from exactly that definition.
// upsert-checkpoint-verdict.mjs refuses a --verdict that contradicts the
// durable ledger's overallVerdict, and its refusal error MUST cite
// GATE-COMMENT-VERDICT-VALUES so a reader lands on the rule it upholds. This
// test pins both sides: the rule's stated meaning in the doc, and the script's
// citation of it, so a reword on either side that drops the linkage fails here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACT_DOC = path.join(REPO_ROOT, "skills/docs/gate-review-comment-contract.md");
const UPSERT_SCRIPT = path.join(REPO_ROOT, "scripts/github/upsert-checkpoint-verdict.mjs");
const CONSOLIDATE_SCRIPT = path.join(REPO_ROOT, "scripts/loop/consolidate-fanin.mjs");

test("GATE-COMMENT-VERDICT-VALUES states the clean/findings_present meanings the consolidator computes", async () => {
  const doc = await readFile(CONTRACT_DOC, "utf8");
  // The rule ID is present and owns the verdict-value definitions.
  assert.match(doc, /<!-- rule: GATE-COMMENT-VERDICT-VALUES -->/);
  // The stated meaning of "clean" matches what consolidate-fanin computes
  // (no findings at a blocking severity remain).
  assert.match(doc, /\| `clean` \| No findings with a severity in the gate's `blockCleanOnFindingSeverities` remain \|/);
  // The stated meaning of "findings_present" matches (blocking findings found).
  assert.match(doc, /\| `findings_present` \| The gate found issues at blocking severities/);
});

test("upsert-checkpoint-verdict's refusal error cites GATE-COMMENT-VERDICT-VALUES so it points at the rule it upholds", async () => {
  const src = await readFile(UPSERT_SCRIPT, "utf8");
  // The refusal cites the rule ID and the contract doc path.
  assert.match(src, /GATE-COMMENT-VERDICT-VALUES/);
  assert.match(src, /skills\/docs\/gate-review-comment-contract\.md/);
  // The refusal names both the posted verdict and the ledger's overallVerdict,
  // so the contradiction is identifiable from the error alone.
  assert.match(src, /contradicts the consolidated ledger's overallVerdict/);
});

test("consolidate-fanin emits overallVerdict (the value the enforcement reads) into --ledger-out", async () => {
  const src = await readFile(CONSOLIDATE_SCRIPT, "utf8");
  // The consolidator computes overallVerdict...
  assert.match(src, /overallVerdict: consolidated\.verdict/);
  // ...and embeds it in the --ledger-out wrapper that write-gate-findings-log
  // threads into the durable ledger upsert-checkpoint-verdict enforces against.
  assert.match(src, /JSON\.stringify\(\{ overallVerdict: consolidated\.verdict, findings \}/);
});

test("upsert-checkpoint-verdict derives the verdict from the ledger's overallVerdict by default (#1616 AC: no --verdict is valid)", async () => {
  const src = await readFile(UPSERT_SCRIPT, "utf8");
  // The derive path: when --verdict is omitted and the ledger carries
  // overallVerdict, the verdict is derived from it.
  assert.match(src, /options\.verdict = ledgerVerdict/);
  // No override flag is added (the contradiction is a consolidator bug to fix,
  // not an operator decision to override) — the refusal has no escape hatch.
  assert.doesNotMatch(src, /--override-verdict|--allow-contradiction|--force-verdict/);
});
