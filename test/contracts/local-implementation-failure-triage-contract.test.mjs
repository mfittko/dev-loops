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
  const section = content.slice(content.indexOf("## Narrow failure-triage fast path"));
  const numberedSteps = section.match(/^\d+\.\s/gm) ?? [];

  assert.ok(numberedSteps.length >= 7, "narrow failure-triage fast path should keep its 7 ordered steps");
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
