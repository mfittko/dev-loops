import {
  assert,
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";
import { assertRuleOwned, assertRulePresent } from "./_rule-helpers.mjs";

const SKILL_PATH = "skills/local-implementation/SKILL.md";

test("local-implementation skill owns the narrow failure-triage order by rule ID", async () => {
  assertRulePresent("LOCAL-FAILURE-TRIAGE-ORDER");
  assertRuleOwned("LOCAL-FAILURE-TRIAGE-ORDER", SKILL_PATH);

  const content = await readRepo(SKILL_PATH);
  const headingIndex = content.indexOf("## Narrow failure-triage fast path");
  assert.ok(headingIndex !== -1, "the Narrow failure-triage fast path section must exist");
  const afterHeading = content.slice(headingIndex + 1);
  const nextHeading = afterHeading.search(/^## /m);
  const section = afterHeading.slice(0, nextHeading === -1 ? undefined : nextHeading);
  const numberedSteps = section.match(/^\d+\.\s/gm) ?? [];

  assert.ok(numberedSteps.length >= 7, "narrow failure-triage fast path should keep its 7 ordered steps");

  // The ORDER is the rule's semantics: startup → inspect → reproduce →
  // narrow search → minimal patch → focused smoke → default verification.
  const orderedKeySteps = [
    /startup once/i,
    /`git status`/,
    /reproduce[^\n]*failing command/i,
    /exact-pattern search/i,
    /minimum call sites/i,
    /focused smoke checks/i,
    /default verification/i,
  ];
  let lastPos = -1;
  for (const pattern of orderedKeySteps) {
    const match = section.match(pattern);
    assert.ok(match, `failure-triage section should match ${pattern}`);
    assert.ok(match.index > lastPos, `failure-triage step ${pattern} (at ${match.index}) should appear after the previous step (last at ${lastPos})`);
    lastPos = match.index;
  }

  assert.match(section, /general tooling-internals and duplicate-broad-search prohibition/i);
});

test("anti-patterns doc owns the general tooling-internals guidance", async () => {
  const content = await readRepo("skills/docs/anti-patterns.md");

  assertMatchesAll(content, [
    /Spelunking tooling internals instead of using the public surface/i,
    /Do not read installed package internals/i,
    /scan tooling source/i,
    /run ad-hoc scripts to understand a tool's behavior/i,
    /Use the CLI[\s\S]{0,120}`--help` subcommands[\s\S]{0,120}`skills\/docs\/?`/i,
    /concrete failure path is inside it and no public CLI\/docs path exists/i,
    /search changed files for the exact pattern/i,
    /don't run duplicate broad searches/i,
  ], "skills/docs/anti-patterns.md");
});
