import assert from "node:assert/strict";
import test from "node:test";

import {
  extractReviewCommitSha,
  isCopilotLogin,
  normalizeTimestamp,
  parseGateReviewCommentBody,
  parseGateReviewCommentMarkerBody,
  summarizeCopilotReviews,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../src/github/copilot-helpers.mjs";

test("isCopilotLogin matches copilot-prefixed logins case-insensitively", () => {
  assert.equal(isCopilotLogin("copilot-swe-agent"), true);
  assert.equal(isCopilotLogin("Copilot"), true);
  assert.equal(isCopilotLogin("COPILOT"), true);
  assert.equal(isCopilotLogin("copilot"), true);
  assert.equal(isCopilotLogin("notcopilot"), false);
  assert.equal(isCopilotLogin(""), false);
  assert.equal(isCopilotLogin(null), false);
  assert.equal(isCopilotLogin(undefined), false);
  assert.equal(isCopilotLogin(42), false);
});

test("normalizeTimestamp returns ms for valid ISO strings and null for invalid input", () => {
  const ts = normalizeTimestamp("2024-01-15T12:00:00Z");
  assert.equal(typeof ts, "number");
  assert.ok(Number.isFinite(ts));
  assert.equal(normalizeTimestamp(""), null);
  assert.equal(normalizeTimestamp("not-a-date"), null);
  assert.equal(normalizeTimestamp(null), null);
  assert.equal(normalizeTimestamp(undefined), null);
  assert.equal(normalizeTimestamp(42), null);
});

test("extractReviewCommitSha prefers GraphQL oid over REST commit_id", () => {
  assert.equal(extractReviewCommitSha({ commit: { oid: "abc123" } }), "abc123");
  assert.equal(extractReviewCommitSha({ commit_id: "def456" }), "def456");
  assert.equal(extractReviewCommitSha({ commit: { oid: "abc123" }, commit_id: "def456" }), "abc123");
  assert.equal(extractReviewCommitSha({}), null);
  assert.equal(extractReviewCommitSha(null), null);
});

test("parseGateReviewCommentBody returns null when required fields are missing", () => {
  assert.equal(parseGateReviewCommentBody(""), null);
  assert.equal(parseGateReviewCommentBody("gate: draft_gate\nhead sha reviewed: abc1234"), null);
});

test("parseGateReviewCommentBody parses a full gate inspection comment", () => {
  const body = [
    "gate: draft_gate",
    "head sha reviewed: abc1234",
    "verdict: clean",
    "findings summary: no issues found",
    "next action: mark ready for review",
  ].join("\n");

  const result = parseGateReviewCommentBody(body);
  assert.ok(result !== null);
  assert.equal(result.gate, "draft_gate");
  assert.equal(result.headSha, "abc1234");
  assert.equal(result.verdict, "clean");
  assert.equal(result.findingsSummary, "no issues found");
  assert.equal(result.nextAction, "mark ready for review");
});

test("parseGateReviewCommentMarkerBody accepts gate+headSha even with partial contract fields", () => {
  const body = "gate: pre_approval_gate\nhead sha reviewed: def5678";
  const result = parseGateReviewCommentMarkerBody(body);
  assert.ok(result !== null);
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "def5678");
  assert.equal(result.contractComplete, false);
});

test("parseGateReviewCommentBody parses the new Markdown template format", () => {
  const body = [
    "### Gate review: `draft_gate`",
    "",
    "**Reviewed head SHA:** `abc1234`",
    "**Verdict:** clean",
    "",
    "**Findings summary:** no issues found",
    "",
    "**Next action:** mark ready for review",
  ].join("\n");

  const result = parseGateReviewCommentBody(body);
  assert.ok(result !== null, "should parse the new template format");
  assert.equal(result.gate, "draft_gate");
  assert.equal(result.headSha, "abc1234");
  assert.equal(result.verdict, "clean");
  assert.equal(result.findingsSummary, "no issues found");
  assert.equal(result.nextAction, "mark ready for review");
});

test("parseGateReviewCommentMarkerBody parses partial new-format markers", () => {
  const body = [
    "### Gate review: `pre_approval_gate`",
    "",
    "**Reviewed head SHA:** `def5678`",
    "**Verdict:** clean",
  ].join("\n");

  const result = parseGateReviewCommentMarkerBody(body);
  assert.ok(result !== null, "should parse partial new-format marker");
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "def5678");
  assert.equal(result.contractComplete, false);
});


test("summarizeGateReviewComments picks the most-recently-updated entry per gate", () => {
  const comments = [
    {
      body: "gate: draft_gate\nhead sha reviewed: aaa1111\nverdict: findings_present\nfindings summary: issues\nnext action: stay draft and fix",
      updated_at: "2024-01-01T00:00:00Z",
      id: 1,
    },
    {
      body: "gate: draft_gate\nhead sha reviewed: bbb2222\nverdict: clean\nfindings summary: no issues found\nnext action: mark ready for review",
      updated_at: "2024-01-02T00:00:00Z",
      id: 2,
    },
  ];

  const summary = summarizeGateReviewComments(comments);
  assert.equal(summary.draft_gate?.commentId, 2);
  assert.equal(summary.draft_gate?.verdict, "clean");
  assert.equal(summary.pre_approval_gate, null);
});

test("summarizeGateReviewCommentMarkers filters by headSha when provided", () => {
  const comments = [
    {
      body: "gate: draft_gate\nhead sha reviewed: aaa1111\nverdict: clean\nfindings summary: ok\nnext action: mark ready for review",
      id: 1,
    },
    {
      body: "gate: draft_gate\nhead sha reviewed: bbb2222\nverdict: clean\nfindings summary: ok\nnext action: mark ready for review",
      id: 2,
    },
  ];

  const summary = summarizeGateReviewCommentMarkers(comments, { headSha: "aaa1111" });
  assert.equal(summary.draft_gate?.commentId, 1);
});

test("summarizeCopilotReviews identifies submitted reviews on the current head", () => {
  const reviews = [
    {
      author: { login: "copilot-swe-agent" },
      state: "CHANGES_REQUESTED",
      commit: { oid: "abc1234" },
      submittedAt: "2024-01-10T00:00:00Z",
    },
  ];

  const result = summarizeCopilotReviews(reviews, { headSha: "abc1234" });
  assert.equal(result.copilotReviewPresent, true);
  assert.equal(result.hasSubmittedReviewOnCurrentHead, true);
  assert.equal(result.hasPendingReviewOnCurrentHead, false);
  assert.equal(result.latestSubmittedReviewOnCurrentHeadAt, "2024-01-10T00:00:00Z");
});

test("summarizeCopilotReviews ignores non-Copilot reviews", () => {
  const reviews = [
    {
      author: { login: "human-reviewer" },
      state: "APPROVED",
      commit: { oid: "abc1234" },
    },
  ];

  const result = summarizeCopilotReviews(reviews, { headSha: "abc1234" });
  assert.equal(result.copilotReviewPresent, false);
  assert.equal(result.hasSubmittedReviewOnCurrentHead, false);
});

// ── Lenient gate comment parsing (#451) ───────────────────────────────────

test("parseGateReviewCommentMarkerBody detects gate+head in non-standard format", () => {
  const body = "pre_approval_gate check for head e284c2e341: all clear!";
  const result = parseGateReviewCommentMarkerBody(body);
  assert.notEqual(result, null);
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "e284c2e341");
  assert.equal(result.contractComplete, false); // no verdict/next-action fields
});

test("parseGateReviewCommentMarkerBody detects draft_gate in loose format", () => {
  const body = "draft_gate passed for abc1234def";
  const result = parseGateReviewCommentMarkerBody(body);
  assert.notEqual(result, null);
  assert.equal(result.gate, "draft_gate");
  assert.equal(result.headSha, "abc1234def");
  assert.equal(result.contractComplete, false);
});

test("parseGateReviewCommentMarkerBody returns null when no gate or SHA found", () => {
  const body = "just a regular comment with no gate references";
  assert.equal(parseGateReviewCommentMarkerBody(body), null);
});

test("parseGateReviewCommentMarkerBody returns null when gate found but no SHA", () => {
  const body = "draft_gate check passed";
  assert.equal(parseGateReviewCommentMarkerBody(body), null);
});

test("parseGateReviewCommentMarkerBody returns null when SHA found but no gate", () => {
  const body = "commit abc1234def5678 looks good";
  assert.equal(parseGateReviewCommentMarkerBody(body), null);
});

test("parseGateReviewCommentBody still returns null for lenient match (needs all fields)", () => {
  const body = "pre_approval_gate for abc1234def all clear";
  // parseGateReviewCommentBody requires verdict, findingsSummary, AND nextAction
  assert.equal(parseGateReviewCommentBody(body), null);
});

test("parseGateReviewCommentMarkerBody lenient fallback does not break structured format", () => {
  const body = [
    "### Gate review: `pre_approval_gate`",
    "",
    "**Reviewed head SHA:** `e284c2e341`",
    "**Verdict:** clean",
    "**Findings summary:** all good",
    "**Next action:** await approval",
  ].join("\n");
  const result = parseGateReviewCommentMarkerBody(body);
  assert.notEqual(result, null);
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "e284c2e341");
  assert.equal(result.verdict, "clean");
  assert.equal(result.findingsSummary, "all good");
  assert.equal(result.nextAction, "await approval");
  assert.equal(result.contractComplete, true);
});

test("summarizeGateReviewCommentMarkers picks up lenient gate comment", () => {
  const comments = [
    {
      id: 1,
      html_url: "https://github.com/o/r/pull/1#issuecomment-1",
      body: "pre_approval_gate for e284c2e341: approved",
      updated_at: "2026-06-01T10:00:00Z",
    },
  ];
  const result = summarizeGateReviewCommentMarkers(comments, { headSha: "e284c2e341" });
  assert.notEqual(result.pre_approval_gate, null);
  assert.equal(result.pre_approval_gate.gate, "pre_approval_gate");
  assert.equal(result.pre_approval_gate.headSha, "e284c2e341");
  assert.equal(result.pre_approval_gate.visible, true);
  assert.equal(result.pre_approval_gate.contractComplete, false);
});

test("summarizeGateReviewCommentMarkers prefers structured over lenient when both exist", () => {
  const comments = [
    {
      id: 1,
      html_url: "https://github.com/o/r/pull/1#issuecomment-1",
      body: "draft_gate for abc1234",  // lenient match
      updated_at: "2026-06-01T10:00:00Z",
    },
    {
      id: 2,
      html_url: "https://github.com/o/r/pull/1#issuecomment-2",
      body: [
        "### Gate review: `draft_gate`",
        "",
        "**Reviewed head SHA:** `abc1234`",
        "**Verdict:** clean",
        "**Findings summary:** good",
        "**Next action:** mark ready",
      ].join("\n"),
      updated_at: "2026-06-01T11:00:00Z",  // newer
    },
  ];
  const result = summarizeGateReviewCommentMarkers(comments, { headSha: "abc1234" });
  assert.notEqual(result.draft_gate, null);
  // Should prefer the newer structured comment
  assert.equal(result.draft_gate.commentId, 2);
  assert.equal(result.draft_gate.contractComplete, true);
});

test("parseGateReviewCommentMarkerBody lenient SHA ignores github comment URLs", () => {
  // "head e284c2e341" matched by context-based parser; URL #issuecomment-4615274563 ignored
  const body = "pre_approval_gate for head e284c2e341: all clear!\n\n" +
    "See https://github.com/mfittko/dev-loops/pull/450#issuecomment-4615274563 for details.";
  const result = parseGateReviewCommentMarkerBody(body);
  assert.notEqual(result, null);
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "e284c2e341");
  assert.equal(result.contractComplete, false);
});

test("parseGateReviewCommentMarkerBody lenient SHA ignores plain-text numeric ID before head SHA", () => {
  // Plain-text "comment 4615274563" is 10 decimal digits that would match [0-9a-f]{7,64}
  // Context-based parser picks SHA after "head", not the numeric ID
  const body = "pre_approval_gate: comment 4615274563 for head e284c2e341 all clear!";
  const result = parseGateReviewCommentMarkerBody(body);
  assert.notEqual(result, null);
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "e284c2e341");
  assert.equal(result.contractComplete, false);
});

test("parseGateReviewCommentMarkerBody context matcher uses word boundaries on head/sha/commit", () => {
  // "ahead" should NOT match the \bhead\b context matcher
  // The real SHA follows the comma after the numeric ID
  const body = "pre_approval_gate: ahead 4615274563, head e284c2e341 — all clear!";
  const result = parseGateReviewCommentMarkerBody(body);
  assert.notEqual(result, null);
  assert.equal(result.gate, "pre_approval_gate");
  assert.equal(result.headSha, "e284c2e341");
  assert.equal(result.contractComplete, false);
});

// ── draftGateResetAtMs round-count reset (#560) ─────────────────────────

test("summarizeCopilotReviews filters reviews before draftGateResetAtMs", () => {
  const reviews = [
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "aaa1111" },
      submittedAt: "2024-01-08T00:00:00Z",
    },
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "bbb2222" },
      submittedAt: "2024-01-10T00:00:00Z",
    },
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "ccc3333" },
      submittedAt: "2024-01-12T00:00:00Z",
    },
  ];

  // Reset at 2024-01-09: only reviews after this time count
  const resetAtMs = Date.parse("2024-01-09T00:00:00Z");
  const result = summarizeCopilotReviews(reviews, {
    headSha: "ccc3333",
    draftGateResetAtMs: resetAtMs,
  });

  // Only the Jan 10 and Jan 12 reviews count → 2 rounds (2 reviews after reset (Jan 10 + Jan 12))
  assert.equal(result.copilotReviewPresent, true);
  assert.equal(result.completedCopilotReviewRounds, 2);
  assert.equal(result.hasSubmittedReviewOnCurrentHead, true);
  assert.equal(result.latestSubmittedReviewOnCurrentHeadAt, "2024-01-12T00:00:00Z");
});

test("summarizeCopilotReviews returns zero rounds when all reviews are before draftGateResetAtMs", () => {
  const reviews = [
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "aaa1111" },
      submittedAt: "2024-01-05T00:00:00Z",
    },
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "bbb2222" },
      submittedAt: "2024-01-06T00:00:00Z",
    },
  ];

  // Reset at 2024-01-10: no reviews after this time
  const resetAtMs = Date.parse("2024-01-10T00:00:00Z");
  const result = summarizeCopilotReviews(reviews, {
    headSha: "bbb2222",
    draftGateResetAtMs: resetAtMs,
  });

  // copilotReviewPresent reflects all reviews, not just effective ones
  assert.equal(result.copilotReviewPresent, true);
  assert.equal(result.completedCopilotReviewRounds, 0);
  assert.equal(result.hasSubmittedReviewOnCurrentHead, false);
});

test("summarizeCopilotReviews with null/undefined draftGateResetAtMs behaves same as before (backward compat)", () => {
  const reviews = [
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "aaa1111" },
      submittedAt: "2024-01-08T00:00:00Z",
    },
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "bbb2222" },
      submittedAt: "2024-01-10T00:00:00Z",
    },
  ];

  const resultNull = summarizeCopilotReviews(reviews, {
    headSha: "bbb2222",
    draftGateResetAtMs: null,
  });
  const resultUndefined = summarizeCopilotReviews(reviews, { headSha: "bbb2222" });

  assert.equal(resultNull.completedCopilotReviewRounds, 2);
  assert.equal(resultUndefined.completedCopilotReviewRounds, 2);
  assert.equal(resultNull.completedCopilotReviewRounds, resultUndefined.completedCopilotReviewRounds);
});

test("summarizeCopilotReviews excludes reviews with exactly draftGateResetAtMs timestamp", () => {
  const reviews = [
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "aaa1111" },
      submittedAt: "2024-01-10T00:00:00Z",
    },
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "bbb2222" },
      submittedAt: "2024-01-10T00:00:01Z",
    },
  ];

  // Reset at exactly 2024-01-10T00:00:00Z — the first review is at same time, excluded
  const resetAtMs = Date.parse("2024-01-10T00:00:00Z");
  const result = summarizeCopilotReviews(reviews, {
    headSha: "bbb2222",
    draftGateResetAtMs: resetAtMs,
  });

  assert.equal(result.completedCopilotReviewRounds, 1); // only the +1s review
});

test("summarizeCopilotReviews draftGateResetAtMs does not affect non-Copilot reviews", () => {
  const reviews = [
    {
      author: { login: "human-reviewer" },
      state: "APPROVED",
      commit: { oid: "aaa1111" },
      submittedAt: "2024-01-10T00:00:00Z",
    },
    {
      author: { login: "copilot-swe-agent" },
      state: "COMMENTED",
      commit: { oid: "bbb2222" },
      submittedAt: "2024-01-12T00:00:00Z",
    },
  ];

  const resetAtMs = Date.parse("2024-01-11T00:00:00Z");
  const result = summarizeCopilotReviews(reviews, {
    headSha: "bbb2222",
    draftGateResetAtMs: resetAtMs,
  });

  // Human review ignored, only Copilot after reset counts
  assert.equal(result.copilotReviewPresent, true);
  assert.equal(result.completedCopilotReviewRounds, 1);
});
