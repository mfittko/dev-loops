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

// #1111: the `tools:` frontmatter MUST be a single-line, comma-separated token
// list (`tools: read, search, ...`, or a single token). pi-subagents parses
// that line with a naive comma split (not real YAML), so any other shape breaks
// it and can silently drop `subagent` at child depth:
//   - flow-sequence `[a, b]`          → `[read` / `subagent]` keep their brackets
//   - block sequence (bare `tools:`)  → empty tool list
//   - space-separated `a b`           → one invalid token `"a b"`
//   - trailing inline comment `a # x` → last token polluted with `" # x"`
// The comma-token scalar parses cleanly on pi and regenerates a byte-identical
// `.claude/` mirror (normalizeToolList already accepts a string). This fence
// asserts the canonical shape positively, so any pi-hostile form fails.
const TOOLS_CANONICAL = /^tools: [a-z][\w-]*(,\s*[a-z][\w-]*)*$/;

test("every agent `tools:` frontmatter is a pi-safe comma-token scalar (#1111)", async () => {
  const files = (await readdir(new URL("../../agents/", import.meta.url)))
    .filter((name) => name.endsWith(".agent.md"));
  assert.ok(files.length >= 7, `expected the canonical agent set, got ${files.length}`);

  for (const file of files) {
    const content = await readRepo(`agents/${file}`);
    const line = content.split("\n").find((l) => /^tools:/.test(l));
    assert.ok(line, `agents/${file} must declare a tools: frontmatter line`);
    assert.match(
      line,
      TOOLS_CANONICAL,
      `agents/${file} tools: must be a single-line comma-separated token list (\`tools: read, search, ...\`) — any bracketed, block-sequence, space-separated, or trailing-content shape breaks pi's naive comma split and can drop subagent (#1111): ${line}`,
    );
  }
});

// Self-test: pin TOOLS_CANONICAL against every pi-hostile shape so the guard
// above cannot go vacuously green if the regex is ever loosened (#1111).
test("the #1111 tools: fence accepts only the pi-safe comma-token scalar", () => {
  assert.match("tools: read, search, subagent", TOOLS_CANONICAL, "canonical comma list");
  assert.match("tools: read", TOOLS_CANONICAL, "single token");
  assert.doesNotMatch("tools: [read, subagent]", TOOLS_CANONICAL, "flow-sequence brackets");
  assert.doesNotMatch("tools:", TOOLS_CANONICAL, "bare block-sequence header");
  assert.doesNotMatch("tools: read search", TOOLS_CANONICAL, "space-separated → single invalid token");
  assert.doesNotMatch("tools: read, subagent # note", TOOLS_CANONICAL, "trailing inline comment pollutes last token");
});
