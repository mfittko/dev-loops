import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  computeCommentDiscipline,
  evaluateCommentDiscipline,
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

test("blocks a single added #NNN issue reference in a runtime comment", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      added("// Fail closed when the base ref is unresolvable (#2054): silence must mean checked."),
    ]),
  });
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].type, "issue-reference");
  assert.ok(out.reasons.some((r) => r.includes("LOCAL-COMMENT-DISCIPLINE")));
});

test("blocks any issue reference spread across multiple added comment lines (span aggregation)", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      added("// State the current invariant here."),
      added("// #1902 relaxed it."),
    ]),
  });
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].type, "issue-reference");
});

test("scans shell (.sh) comments: blocks a single # issue ref, ignores a #! shebang", () => {
  const block = computeCommentDiscipline({
    diffOutput: diff("scripts/deploy.sh", [added("# provisions the box (#2054)")]),
  });
  assert.equal(block.outcome, "block");
  assert.equal(block.findings[0].type, "issue-reference");
  const clean = computeCommentDiscipline({
    diffOutput: diff("scripts/deploy.sh", [added("#!/usr/bin/env bash"), added("# provisions the box per infra-provisioning-contract PROV-BOX-01")]),
  });
  assert.equal(clean.outcome, "pass");
});

test("passes a current-invariant comment that cites the contract/rule by name/rule-id (no issue number)", () => {
  const out = computeCommentDiscipline({
    diffOutput: diff("scripts/loop/thing.mjs", [
      added("// Fail closed when the base ref is unresolvable (per gate-review-sub-loop-contract GATE-EXEC-FAIL-CLOSED): silence must mean checked."),
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

test("evaluateCommentDiscipline fails closed on an implausible git ref (trust boundary)", async () => {
  await assert.rejects(() => evaluateCommentDiscipline({ base: "a..b", head: "HEAD" }), /plausible git ref/);
  await assert.rejects(() => evaluateCommentDiscipline({ base: "-x", head: "HEAD" }), /plausible git ref/);
  await assert.rejects(() => evaluateCommentDiscipline({ base: "origin/main", head: ".." }), /plausible git ref/);
});

test("ignores non-runtime files (tests, docs, generated mirrors)", () => {
  for (const file of ["test/loop/x.test.mjs", "docs/notes.mjs", ".claude/hooks/h.mjs", "skills/docs/x.md"]) {
    const out = computeCommentDiscipline({
      diffOutput: diff(file, [added("// #1 then #2 then #3 chronology chain")]),
    });
    assert.equal(out.outcome, "pass", `expected ${file} to be out of scope`);
  }
});
