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

    // Assert the cross-reference link + a lightweight label only — the agent
    // doc is a pointer, not a copy of the rule (anti-patterns.md stays canonical).
    assertMatchesAll(content, [
      /tooling internals/i,
      /\[Anti-patterns\]\(\.\.\/skills\/docs\/anti-patterns\.md#core-anti-patterns\)/,
    ], `agents/${agent}.agent.md`);
  });
}
