import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  detectClosingKeyword,
  extractClosingIssueNumber,
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

test("resolveClosingRefMismatch refuses a disagreeing reference with a named error", () => {
  const refusal = resolveClosingRefMismatch({ body: "Closes #2071", expectedIssue: 2110 });
  assert.match(refusal, /CLOSING-REF-BRANCH-MISMATCH/);
  assert.match(refusal, /#2071/);
  assert.match(refusal, /#2110/);
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
