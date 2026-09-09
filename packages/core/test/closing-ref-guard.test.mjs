import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  detectClosingKeyword,
  extractClosingIssueNumber,
  extractClosingIssueNumbers,
  extractIssueFromBranchSlug,
  resolveExpectedIssueFromPrContext,
  resolveClosingRefMismatch,
} from "../src/github/closing-ref-guard.mjs";

test("extractClosingIssueNumber reads Closes/Fixes and null otherwise", () => {
  assert.equal(extractClosingIssueNumber("Closes #123"), 123);
  assert.equal(extractClosingIssueNumber("body. Fixes #456."), 456);
  assert.equal(extractClosingIssueNumber("no keyword here"), null);
  assert.equal(extractClosingIssueNumber(null), null);
});

test("detectClosingKeyword true only when a closing keyword is present", () => {
  assert.equal(detectClosingKeyword("Closes #1"), true);
  assert.equal(detectClosingKeyword("plain text"), false);
});

test("extractClosingIssueNumber recognizes GitHub's full closing vocabulary (not just Closes/Fixes)", () => {
  for (const verb of ["Close", "Closes", "Closed", "Fix", "Fixes", "Fixed", "Resolve", "Resolves", "Resolved", "RESOLVES"]) {
    assert.equal(extractClosingIssueNumber(`${verb} #77`), 77, `verb ${verb} must be recognized`);
  }
  // Not a closing keyword adjacent to a number: no false match.
  assert.equal(extractClosingIssueNumber("foreclose #5"), null);
  assert.equal(extractClosingIssueNumber("prefix #5"), null);
  assert.equal(extractClosingIssueNumber("closing the door on #5"), null);
});

test("extractClosingIssueNumbers returns every closing reference, de-duplicated in order", () => {
  assert.deepEqual(extractClosingIssueNumbers("Closes #2110 and also Resolves #2071"), [2110, 2071]);
  assert.deepEqual(extractClosingIssueNumbers("Closes #5, Closes #5"), [5]);
  assert.deepEqual(extractClosingIssueNumbers("no closing keyword"), []);
});

test("extractIssueFromBranchSlug parses default and prefixed slugs", () => {
  assert.equal(extractIssueFromBranchSlug("issue-2110"), 2110);
  assert.equal(extractIssueFromBranchSlug("issue-2092-body-swap"), 2092);
  assert.equal(extractIssueFromBranchSlug("dl/issue-2092-body-swap"), 2092);
  assert.equal(extractIssueFromBranchSlug("feature/no-issue"), null);
  assert.equal(extractIssueFromBranchSlug("main"), null);
  assert.equal(extractIssueFromBranchSlug(null), null);
});

test("resolveExpectedIssueFromPrContext prefers branch slug over closingIssuesReferences", () => {
  assert.equal(
    resolveExpectedIssueFromPrContext({ headRefName: "issue-2110", closingIssuesReferences: [{ number: 999 }] }),
    2110,
  );
});

test("resolveExpectedIssueFromPrContext falls back to closingIssuesReferences when the branch has no issue", () => {
  assert.equal(
    resolveExpectedIssueFromPrContext({ headRefName: "fix/thing", closingIssuesReferences: [{ number: 42 }] }),
    42,
  );
  assert.equal(resolveExpectedIssueFromPrContext({ headRefName: "fix/thing", closingIssuesReferences: [] }), null);
  assert.equal(resolveExpectedIssueFromPrContext(null), null);
});

test("resolveExpectedIssueFromPrContext accepts a plain-number closingIssuesReferences entry and skips non-positive/non-integer ones", () => {
  assert.equal(resolveExpectedIssueFromPrContext({ headRefName: "fix/thing", closingIssuesReferences: [42] }), 42);
  // Skip a 0/negative/non-integer entry and fall through to the next valid one.
  assert.equal(
    resolveExpectedIssueFromPrContext({ headRefName: "fix/thing", closingIssuesReferences: [0, -3, { number: "x" }, { number: 7 }] }),
    7,
  );
  assert.equal(resolveExpectedIssueFromPrContext({ headRefName: "fix/thing", closingIssuesReferences: [0, -3] }), null);
});

test("resolveClosingRefMismatch refuses a disagreeing reference with a named error", () => {
  const refusal = resolveClosingRefMismatch({ body: "Closes #2071", expectedIssue: 2110 });
  assert.match(refusal, /CLOSING-REF-BRANCH-MISMATCH/);
  assert.match(refusal, /#2071/);
  assert.match(refusal, /#2110/);
});

test("resolveClosingRefMismatch refuses a wrong SECOND reference even when the first matches (GitHub closes every one)", () => {
  const refusal = resolveClosingRefMismatch({ body: "Closes #2110\n\nCloses #2071", expectedIssue: 2110 });
  assert.match(refusal, /CLOSING-REF-BRANCH-MISMATCH/);
  assert.match(refusal, /#2071/);
});

test("resolveClosingRefMismatch refuses a mismatch expressed with a non-Closes/Fixes verb (Resolves)", () => {
  const refusal = resolveClosingRefMismatch({ body: "Resolves #2071", expectedIssue: 2110 });
  assert.match(refusal, /CLOSING-REF-BRANCH-MISMATCH/);
  assert.match(refusal, /#2071/);
});

test("closing references inside fenced or inline-code spans are ignored (GitHub does not auto-close them)", () => {
  // A fenced example or inline-code mention must NOT spoof the guard: only the
  // real trailing reference is honored.
  const fenced = "See the example:\n\n```\nCloses #2071\n```\n\nCloses #2110";
  assert.deepEqual(extractClosingIssueNumbers(fenced), [2110]);
  assert.equal(resolveClosingRefMismatch({ body: fenced, expectedIssue: 2110 }), null);
  const inline = "The `Closes #2071` example is illustrative. Closes #2110";
  assert.deepEqual(extractClosingIssueNumbers(inline), [2110]);
  assert.equal(resolveClosingRefMismatch({ body: inline, expectedIssue: 2110 }), null);
});

test("resolveClosingRefMismatch also inspects the cross-repo owner/repo#N closing form", () => {
  const refusal = resolveClosingRefMismatch({ body: "Closes owner/other-repo#2071", expectedIssue: 2110 });
  assert.match(refusal, /CLOSING-REF-BRANCH-MISMATCH/);
  assert.match(refusal, /#2071/);
});

test("resolveClosingRefMismatch accepts a correct-match body", () => {
  assert.equal(resolveClosingRefMismatch({ body: "Closes #2110", expectedIssue: 2110 }), null);
});

test("resolveClosingRefMismatch exempts issue-less (no expected issue) and bodies with no closing ref", () => {
  assert.equal(resolveClosingRefMismatch({ body: "Closes #2071", expectedIssue: null }), null);
  assert.equal(resolveClosingRefMismatch({ body: "no closing keyword", expectedIssue: 2110 }), null);
});

test("resolveClosingRefMismatch honors the cross-issue waiver", () => {
  assert.equal(resolveClosingRefMismatch({ body: "Closes #2071", expectedIssue: 2110, allowCrossIssue: true }), null);
});
