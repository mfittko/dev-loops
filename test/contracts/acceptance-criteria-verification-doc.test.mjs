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
