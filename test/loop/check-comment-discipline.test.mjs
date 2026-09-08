import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  computeCommentDiscipline,
  DEFAULT_MAX_ADDED_COMMENT_BLOCK_LINES,
  ESCAPE_MARKER,
} from "../../scripts/loop/check-comment-discipline.mjs";

// Minimal unified-diff fixture builder: one file header plus a hunk of `+`
// added lines (and optional context lines prefixed with a space).
function diff(file, lines) {
  return [`diff --git a/${file} b/${file}`, `+++ b/${file}`, "@@ -0,0 +1 @@", ...lines].join("\n");
}
const added = (s) => `+${s}`;
const context = (s) => ` ${s}`;

test("blocks an added runtime comment that cites an issue-number chronology chain", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      added("// #1867 introduced the tripwire, then #1902 relaxed it, superseded by #2034"),
    ]),
  });
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].type, "issue-chronology");
  assert.ok(out.reasons.some((r) => r.includes("LOCAL-COMMENT-DISCIPLINE")));
});

test("passes a clean current-invariant comment (single authoritative reference allowed)", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      added("// Fail closed when the base ref is unresolvable (#2054): silence must mean checked."),
    ]),
  });
  assert.equal(out.outcome, "pass");
  assert.deepEqual(out.findings, []);
});

test("never flags a pre-existing (context) chronology comment — added-lines-only", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      context("// #1867 did X, then #1902 did Y, later #2034 changed it again"),
      added("const x = 1;"),
    ]),
  });
  assert.equal(out.outcome, "pass");
});

test("inline escape marker admits a load-bearing exception", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      added(`// external contract: mirror the #1867 shape and the #2034 rename (${ESCAPE_MARKER} tracked mirror)`),
    ]),
  });
  assert.equal(out.outcome, "pass");
});

test("blocks an added design-essay comment block over the threshold", () => {
  const bloat = Array.from({ length: DEFAULT_MAX_ADDED_COMMENT_BLOCK_LINES + 1 }, (_, i) => added(` * essay line ${i}`));
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [added("/**"), ...bloat, added(" */")]),
  });
  assert.equal(out.outcome, "block");
  assert.ok(out.findings.some((f) => f.type === "design-essay"));
});

test("ignores non-runtime files (tests, docs, generated mirrors)", () => {
  for (const file of ["test/loop/x.test.mjs", "docs/notes.mjs", ".claude/hooks/h.mjs", "skills/docs/x.md"]) {
    const out = computeCommentDiscipline({
      diffOutput: diff(file, [added("// #1 then #2 then #3 chronology chain")]),
    });
    assert.equal(out.outcome, "pass", `expected ${file} to be out of scope`);
  }
});
