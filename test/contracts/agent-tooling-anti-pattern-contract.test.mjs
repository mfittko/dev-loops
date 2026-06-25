import {
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";

// #863: the implementation agents must surface the tooling-internals
// anti-pattern (anti-patterns.md #7), since they do not auto-load that doc.
// The reference must be a pointer/cross-reference, not a duplicated rule.
for (const agent of ["developer", "fixer"]) {
  test(`${agent} agent references the tooling-internals anti-pattern`, async () => {
    const content = await readRepo(`agents/${agent}.agent.md`);

    assertMatchesAll(content, [
      /Do not read installed-package internals or scan tooling source/i,
      /use its CLI[\s\S]{0,40}`--help`[\s\S]{0,40}`skills\/docs\/?`/i,
      /\[Anti-patterns\]\(\.\.\/skills\/docs\/anti-patterns\.md#core-anti-patterns\)/,
    ], `agents/${agent}.agent.md`);
  });
}
