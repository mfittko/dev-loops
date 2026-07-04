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

// #1111: the `tools:` frontmatter must be a single-line no-bracket comma
// scalar (`tools: read, search, ...`). pi-subagents parses that line with a
// naive comma split (not real YAML), so ANY multi-line/bracketed YAML shape
// breaks it: the flow-sequence `[a, b]` leaves `[read`/`subagent]` mangled,
// and a block sequence (`tools:` alone, then `- read` lines) leaves a bare
// `tools:` line that splits to an empty tool list — either way `subagent` is
// dropped at child depth. The no-bracket comma scalar parses cleanly on pi
// and regenerates a byte-identical `.claude/` mirror (normalizeToolList
// already accepts a string). This fence fails if any agent reintroduces a
// shape outside that canonical form.
const BRACKET_FLOW_SEQUENCE = /^tools:\s*\[/;
const INLINE_SCALAR_VALUE = /^tools:\s*\S/;

test("no agent `tools:` frontmatter uses a pi-hostile YAML shape (#1111)", async () => {
  const files = (await readdir(new URL("../../agents/", import.meta.url)))
    .filter((name) => name.endsWith(".agent.md"));
  assert.ok(files.length >= 7, `expected the canonical agent set, got ${files.length}`);

  for (const file of files) {
    const content = await readRepo(`agents/${file}`);
    const line = content.split("\n").find((l) => /^tools:/.test(l));
    assert.ok(line, `agents/${file} must declare a tools: frontmatter line`);
    // Reject the flow-sequence bracket form: pi keeps `[read`/`subagent]`.
    assert.doesNotMatch(
      line,
      BRACKET_FLOW_SEQUENCE,
      `agents/${file} tools: must be a no-bracket comma list, not a YAML flow-sequence — pi's naive comma split mangles \`[read\`/\`subagent]\` (#1111): ${line}`,
    );
    // Reject the block-sequence form: a bare `tools:` line (followed by `- x`
    // items) splits to an empty tool list on pi, silently dropping subagent.
    assert.match(
      line,
      INLINE_SCALAR_VALUE,
      `agents/${file} tools: must carry its tool names inline on the same line, not as a YAML block sequence — a bare \`tools:\` line makes pi's naive line-split read an empty tool set and drop subagent (#1111): ${line}`,
    );
  }
});

// Self-test: pin the fence regexes so a future edit cannot make the guard
// above vacuously green against already-clean live files (#1111).
test("the #1111 tools: fence regexes trip on the pi-hostile shapes", () => {
  assert.match("tools: [read, subagent]", BRACKET_FLOW_SEQUENCE, "bracket form must be caught");
  assert.doesNotMatch("tools: read, subagent", BRACKET_FLOW_SEQUENCE, "clean comma scalar must pass the bracket check");
  assert.doesNotMatch("tools:", INLINE_SCALAR_VALUE, "a bare block-sequence header line must be caught");
  assert.match("tools: read, subagent", INLINE_SCALAR_VALUE, "clean comma scalar must pass the inline check");
});
