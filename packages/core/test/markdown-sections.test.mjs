import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { buildSectionHeadingPattern, extractSection } from "../src/loop/markdown-sections.mjs";

describe("markdown-sections", () => {
  test("extracts an H2 section body up to the next H2", () => {
    const body = "# Title\n\n## Scope\nin scope\n\n## Notes\nlater";
    assert.equal(extractSection(body, "Scope"), "in scope");
  });

  test("returns null when the heading is absent", () => {
    assert.equal(extractSection("## Other\nx", "Scope"), null);
  });

  describe("buildSectionHeadingPattern hardening (public export)", () => {
    // The heading is regex-escaped, so a literal `## A.B` matches only `A.B`.
    test("escapes regex metacharacters in the heading", () => {
      const re = buildSectionHeadingPattern("A.B");
      assert.ok(re.test("## A.B"));
      assert.ok(!re.test("## AxB"));
    });

    // Non-string / empty headings must never throw and never broad-match a bare
    // `##` — they return a never-match pattern, so extractSection yields null.
    for (const bad of [undefined, null, 0, {}, [], ""]) {
      test(`never-matches for invalid heading ${JSON.stringify(bad)}`, () => {
        const re = buildSectionHeadingPattern(bad);
        assert.ok(!re.test("## Anything\nbody"));
        assert.equal(extractSection("## Anything\nbody", bad), null);
      });
    }
  });
});
