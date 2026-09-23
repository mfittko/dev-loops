import { assert, readRepo, test } from "../imported-assets-helpers.mjs";
import { assertRuleOwned } from "./_rule-helpers.mjs";
import { parseTickVerifiedCliArgs } from "../../scripts/github/tick-verified-checkboxes.mjs";

const OWNER = "skills/docs/acceptance-criteria-verification.md";

test("acceptance owner prescribes the combined issue/PR tick command with verified labels", async () => {
  assertRuleOwned("ACCEPT-CRITERIA-VERIFY-AND-REFLECT", OWNER);
  const doc = await readRepo(OWNER);
  const command = [...doc.matchAll(/`([^`]+)`/g)].map((match) => match[1])
    .find((text) => text.startsWith("node scripts/github/tick-verified-checkboxes.mjs "));
  assert.ok(command, "missing combined verification handoff");
  // Instantiate the documented placeholders and exercise the actual argument
  // parser. Split only this bounded example; this is not a general shell parser.
  const args = command.replace("<owner/name>", "owner/repo").replace("<issue-number>", "42")
    .replace("<pr-number>", "17").replace("<exact label>...", "Verified-criterion")
    .split(/\s+/).slice(2);
  const parsed = parseTickVerifiedCliArgs(args);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.issue, 42);
  assert.equal(parsed.pr, 17);
  assert.deepEqual(parsed.verified, ["Verified-criterion"]);
});

test("acceptance owner names both completeness fields and their verdict writer", async () => {
  const doc = await readRepo(OWNER);
  const step = doc.split(/\n(?=\d+\. )/).find((text) => text.includes('`prBodyUncheckedAcItems`'));
  assert.ok(step);
  for (const literal of ["prBodyUncheckedAcItems", "prBodyUncheckedDodItems", "upsert-checkpoint-verdict.mjs", "pre_approval_gate", "pr-checklist"]) {
    assert.ok(step.includes(`\`${literal}\``), `missing completeness handoff: ${literal}`);
  }
  // Exact-label/no-uncheck behavior and checked/unchecked gate outcomes are
  // exercised by tick-verified-checkboxes and coordination/verdict suites.
  // The linked-issue scope and reviewer/judge truthfulness duty are semantic
  // review obligations, not proved by matching a sentence about completeness.
});

test("step 8 composes the review verdict with deterministic gate blockers (#2389)", async () => {
  const doc = await readRepo(OWNER);
  const step = doc.split(/\n(?=\d+\. )/).find((text) => text.startsWith("8. "));
  assert.ok(step, "missing step 8");
  // The retired instruction mapped an unmet AC to findings_present.
  assert.doesNotMatch(step, /findings_present` when any AC item is not satisfied/);
  for (const row of [
    /review ledger clean and all gate prerequisites satisfied \| `clean`/,
    /blocking-severity review finding, no independent gate blocker \| `findings_present`/,
    /unmet AC\/DoD or another deterministic gate blocker \| `blocked`/,
    /review\/fan-in itself unable to complete \| `blocked`/,
  ]) {
    assert.match(step, row);
  }
  // Linkage cases are draft-boundary precondition refusals, never a composed
  // blocked the writer would refuse over a completed ledger.
  assert.doesNotMatch(step, /unable to complete \(for example no linked issue/);
  assert.match(step, /Precondition refusals stay refusals/);
  assert.match(step, /`missing_refinement_artifact`[^\n]*`REPORT_BLOCKED`/);
  // No AC source fails closed as blocked, never findings_present or clean.
  const noAc = doc.split("\n").find((line) => line.startsWith("When the spec-of-record surface carries no acceptance-criteria items"));
  assert.ok(noAc, "missing no-AC rule");
  assert.doesNotMatch(noAc, /findings_present/);
  assert.match(noAc, /the outcome is `blocked`, never `clean`/);
  assert.match(noAc, /`missing_acceptance_criteria`/);
});

test("gate-chain exit table routes a composed AC/DoD blocked to rerun, fan-in blocked to escalation (#2389)", async () => {
  const doc = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  assert.match(doc, /\| `pre_approval_gate` checkpoint `blocked` composed from a deterministic AC\/DoD blocker[^\n]*\| [^\n]*rerun the gate[^\n]*\|/);
  assert.match(doc, /\| `blocked` verdict from the review\/fan-in itself \(gate could not complete\) \| Stop; escalate to operator \|/);
});
