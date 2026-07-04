import {
  assert,
  assertMatchesAll,
  readRepo,
  readdir,
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

// #1111: the `tools:` frontmatter must NOT use the YAML flow-sequence
// `[a, b, c]` form. pi-subagents parses that line with a naive comma split
// (not real YAML), so `[read` / `subagent]` keep their brackets and the
// first/last tool never matches a real tool — dropping `subagent` at child
// depth. The no-bracket comma scalar parses cleanly on pi and regenerates a
// byte-identical `.claude/` mirror (normalizeToolList already accepts a string).
// This fence fails if any agent reintroduces the bracket form.
test("no agent `tools:` frontmatter uses the YAML flow-sequence bracket form (#1111)", async () => {
  const files = (await readdir(new URL("../../agents/", import.meta.url)))
    .filter((name) => name.endsWith(".agent.md"));
  assert.ok(files.length >= 7, `expected the canonical agent set, got ${files.length}`);

  for (const file of files) {
    const content = await readRepo(`agents/${file}`);
    const line = content.split("\n").find((l) => /^tools:/.test(l));
    assert.ok(line, `agents/${file} must declare a tools: frontmatter line`);
    assert.doesNotMatch(
      line,
      /^tools:\s*\[/,
      `agents/${file} tools: must be a no-bracket comma list, not a YAML flow-sequence — pi's naive comma split mangles \`[read\`/\`subagent]\` (#1111): ${line}`,
    );
  }
});
