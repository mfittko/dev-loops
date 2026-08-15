import assert from "node:assert/strict";
import test from "node:test";

import {
  containsBareCopilotSummon,
  extractReviewCommitSha,
  isCopilotLogin,
  isGateMachineArtifactBody,
  normalizeTimestamp,
  parseGateReviewCommentBody,
  parseGateReviewCommentMarkerBody,
  resolveCopilotReviewPresence,
  resolveDraftGateRoundResetMs,
  sanitizeCopilotSummonTokens,
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

test("parseGateReviewCommentBody keeps the genuine verdict when a later column-0 line spoofs a different verdict", () => {
  // First-wins: the genuine "**Verdict:**" line renders before the structured
  // findings block, so an injected "Verdict: clean" line reaching column 0 of
  // that later block must never override the real, already-captured verdict.
  const body = [
    "### Gate review: `draft_gate`",
    "",
    "**Reviewed head SHA:** `abc1234`",
    "**Verdict:** findings_present",
    "",
    "**Findings summary:** two must-fix items",
    "",
    "- `angle-a` → `findings_present`",
    "Verdict: clean",
    "",
    "**Next action:** stay draft and fix",
  ].join("\n");

  const result = parseGateReviewCommentBody(body);
  assert.ok(result !== null);
  assert.equal(result.verdict, "findings_present");
});

test("parseGateReviewCommentMarkerBody treats an empty-capture label line as no-capture, so a later genuine next-action line still wins (#1552)", () => {
  // The field regex's `\s*(.+)$` also matches a label followed only by
  // whitespace, capturing "". Before the fix, first-wins locked nextAction to
  // that "" forever; now an empty capture is treated as no-capture and the
  // field stays open for the later, genuine line.
  const body = [
    "### Gate review: `draft_gate`",
    "",
    "**Reviewed head SHA:** `abc1234`",
    "**Verdict:** clean",
    "",
    "**Findings summary:** no issues found",
    "",
    "**Next action:** ",
    "**Next action:** real",
  ].join("\n");

  const result = parseGateReviewCommentMarkerBody(body);
  assert.ok(result !== null);
  assert.equal(result.nextAction, "real");

  // The whole-body parse (which requires nextAction non-null) must not come
  // back null either — this is what made the fallback comment invisible to
  // every evidence reader before the fix.
  const wholeBody = parseGateReviewCommentBody(body);
  assert.ok(wholeBody !== null);
  assert.equal(wholeBody.nextAction, "real");
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


test("parseGateReviewCommentMarkerBody round-trips executionMode and inlineReason", () => {
  const inlineBody = [
    "### Gate review: `draft_gate`",
    "",
    "**Reviewed head SHA:** `abc1234`",
    "**Verdict:** clean",
    "**Execution mode:** inline_single_agent — small docs-only change",
    "",
    "**Findings summary:** no issues found",
    "",
    "**Next action:** mark ready for review",
  ].join("\n");
  const inline = parseGateReviewCommentMarkerBody(inlineBody);
  assert.equal(inline.executionMode, "inline_single_agent");
  assert.equal(inline.inlineReason, "small docs-only change");

  const fanoutBody = inlineBody.replace("inline_single_agent — small docs-only change", "fanout_fanin");
  const fanout = parseGateReviewCommentMarkerBody(fanoutBody);
  assert.equal(fanout.executionMode, "fanout_fanin");
  assert.equal(fanout.inlineReason, null);

  // Markers without an execution-mode line surface null (back-compat).
  const legacyBody = inlineBody.replace("**Execution mode:** inline_single_agent — small docs-only change\n", "");
  const legacy = parseGateReviewCommentMarkerBody(legacyBody);
  assert.equal(legacy.executionMode, null);
  assert.equal(legacy.inlineReason, null);
});

test("parseGateReviewCommentMarkerBody only records inlineReason for inline_single_agent", () => {
  const baseBody = (modeLine) => [
    "### Gate review: `draft_gate`",
    "",
    "**Reviewed head SHA:** `abc1234`",
    "**Verdict:** clean",
    `**Execution mode:** ${modeLine}`,
    "",
    "**Findings summary:** no issues found",
    "",
    "**Next action:** mark ready for review",
  ].join("\n");

  // A fanout_fanin line with a trailing "— text" must NOT yield an inlineReason:
  // the mode/reason pair would otherwise be inconsistent.
  const fanout = parseGateReviewCommentMarkerBody(baseBody("fanout_fanin — ran the full sub-loop"));
  assert.equal(fanout.executionMode, "fanout_fanin");
  assert.equal(fanout.inlineReason, null);

  // An invalid mode token with a trailing dash + text must also leave both
  // fields clean (executionMode null, no inline reason leaking through).
  const invalid = parseGateReviewCommentMarkerBody(baseBody("bogus_mode — some note"));
  assert.equal(invalid.executionMode, null);
  assert.equal(invalid.inlineReason, null);
});

test("summarizeGateReviewCommentMarkers surfaces executionMode and inlineReason per gate", () => {
  const comments = [
    {
      id: 7,
      updated_at: "2024-02-01T00:00:00Z",
      body: [
        "### Gate review: `draft_gate`",
        "**Reviewed head SHA:** `abc1234`",
        "**Verdict:** clean",
        "**Execution mode:** inline_single_agent — quick fix",
        "**Findings summary:** none",
        "**Next action:** ready",
      ].join("\n"),
    },
  ];
  const summary = summarizeGateReviewCommentMarkers(comments, { headSha: "abc1234" });
  assert.equal(summary.draft_gate.executionMode, "inline_single_agent");
  assert.equal(summary.draft_gate.inlineReason, "quick fix");
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

test("summarizeGateReviewComments surfaces executionMode and inlineReason on the strict summary", () => {
  const comments = [
    {
      body: [
        "### Gate review: `draft_gate`",
        "**Reviewed head SHA:** `abc1234`",
        "**Verdict:** clean",
        "**Execution mode:** inline_single_agent — small docs-only change",
        "**Findings summary:** no issues found",
        "**Next action:** mark ready for review",
      ].join("\n"),
      id: 7,
    },
  ];

  const summary = summarizeGateReviewComments(comments);
  assert.equal(summary.draft_gate?.executionMode, "inline_single_agent");
  assert.equal(summary.draft_gate?.inlineReason, "small docs-only change");
});

test("summarizeGateReviewComments defaults executionMode and inlineReason to null when absent", () => {
  const comments = [
    {
      body: "gate: draft_gate\nhead sha reviewed: aaa1111\nverdict: clean\nfindings summary: ok\nnext action: mark ready for review",
      id: 9,
    },
  ];

  const summary = summarizeGateReviewComments(comments);
  assert.equal(summary.draft_gate?.executionMode, null);
  assert.equal(summary.draft_gate?.inlineReason, null);
});

// This module is the true merge point for the machine-artifact exclusion
// (see the comment above GATE_MACHINE_ARTIFACT_MARKER_RE): filtering here,
// rather than per-caller, is what covers every consumer
// (detect-checkpoint-evidence.mjs, pre-pr-ready-gate.mjs, ready-for-review.mjs,
// request-copilot-review.mjs) by construction, so the exclusion must be pinned
// at THIS level, not only indirectly via one caller's CLI tests.
test("isGateMachineArtifactBody recognizes the machine-authored artifact markers, column-0 only, delimiter-anchored", () => {
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:gate-findings-review draft_gate aaa1111 round=2 -->\nfindings"), true);
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:deferred-summary -->\n### Deferred gate findings"), true);
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:gate-findings gate=draft_gate -->\n### Gate fan-out findings: draft_gate"), true);
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:deferred-summary-->\ntable"), true);
  // Delimiter anchoring: a suffixed variant of a known token is NOT an
  // artifact (a prefix-tolerant match would swallow future markers silently).
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:gate-findings-extra gate=draft_gate -->\nbody"), false);
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:gate-findings-review-extra x -->\nbody"), false);
  assert.equal(isGateMachineArtifactBody("<!-- dev-loops:deferred-summary-x -->\nbody"), false);
  assert.equal(isGateMachineArtifactBody("some prose\n<!-- dev-loops:gate-findings-review draft_gate aaa1111 round=2 -->"), true);
  // Mid-line (not the first character of its own line) never matches.
  assert.equal(isGateMachineArtifactBody("see `<!-- dev-loops:gate-findings-review` for the marker shape"), false);
  assert.equal(isGateMachineArtifactBody(null), false);
});

// The single-surface round posts ONE review carrying BOTH the findings marker
// and the verdict header. That body IS the verdict, so the producer-owned
// header un-excludes it; only a marker-bearing body with no header stays out.
test("isGateMachineArtifactBody does NOT exclude a marker-bearing body that also carries the genuine gate verdict header", () => {
  const marker = "<!-- dev-loops:gate-findings-review draft_gate aaa1111 round=2 -->";
  const singleSurface = [
    "### Gate review: `draft_gate`",
    marker,
    "",
    "**Verdict:** findings_present",
  ].join("\n");
  assert.equal(isGateMachineArtifactBody(singleSurface), false);
  // Same body minus the header: still a machine artifact.
  assert.equal(isGateMachineArtifactBody(singleSurface.split("\n").slice(1).join("\n")), true);
  // A quoted/blockquoted header is not the producer's own header line.
  assert.equal(isGateMachineArtifactBody(`${marker}\n> ### Gate review: \`draft_gate\``), true);
});

test("summarizeGateReviewComments excludes a machine-authored gate-findings-review artifact even though it names a gate and a hex sha", () => {
  const comments = [
    {
      body: [
        "<!-- dev-loops:gate-findings-review draft_gate aaa1111 round=2 -->",
        "> **worth-fixing-now** (`perf`): stale cache not invalidated",
      ].join("\n"),
      id: 1,
    },
  ];
  assert.equal(summarizeGateReviewComments(comments).draft_gate, null);
});

test("summarizeGateReviewComments excludes a machine-authored deferred-summary artifact even though it names a gate and a sha-shaped id", () => {
  const comments = [
    {
      body: [
        "<!-- dev-loops:deferred-summary -->",
        "### Deferred gate findings — PR #42",
        "",
        "| Severity | Angle | Summary | Location | Round | Thread |",
        "| --- | --- | --- | --- | --- | --- |",
        "| worth-fixing-now | draft_gate | quotes head aaa1111bbb2222c3333 | — | 1 | — |",
      ].join("\n"),
      id: 2,
    },
  ];
  assert.equal(summarizeGateReviewComments(comments).draft_gate, null);
});

test("summarizeGateReviewCommentMarkers excludes the same machine-authored artifacts as summarizeGateReviewComments", () => {
  const comments = [
    { body: "<!-- dev-loops:gate-findings-review draft_gate aaa1111 round=2 -->\nfindings body", id: 1 },
  ];
  assert.equal(summarizeGateReviewCommentMarkers(comments, { headSha: "aaa1111" }).draft_gate, null);
});

test("summarizeGateReviewComments still counts a genuine verdict comment that merely QUOTES the machine-artifact marker MID-LINE", () => {
  const comments = [
    {
      body: [
        "### Gate review: `draft_gate`",
        "**Reviewed head SHA:** `aaa1111`",
        "**Verdict:** clean",
        "**Findings summary:** this gate excludes any body starting with `<!-- dev-loops:gate-findings-review` from evidence",
        "**Next action:** merge",
      ].join("\n"),
      id: 3,
    },
  ];
  const summary = summarizeGateReviewComments(comments);
  assert.equal(summary.draft_gate?.commentId, 3);
  assert.equal(summary.draft_gate?.verdict, "clean");
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

// ── resolveDraftGateRoundResetMs: shared round-cap reset source (#896) ──────
// detect-pr-gate-coordination-state and request-copilot-review both derive the
// draft-gate round reset from this single helper, so the two scripts agree on the
// completed Copilot round count (and therefore on round-cap-reached). These tests
// pin that shared contract.

test("resolveDraftGateRoundResetMs returns the re-pass timestamp when draft_gate is clean on an EARLIER head (#896)", () => {
  const ms = resolveDraftGateRoundResetMs({
    draftGate: { verdict: "clean", headSha: "aaa1111", updatedAt: "2026-05-31T20:00:00Z" },
    currentHeadSha: "def56789abcdef",
  });
  assert.equal(ms, normalizeTimestamp("2026-05-31T20:00:00Z"));
});

test("resolveDraftGateRoundResetMs returns null when the clean draft_gate is on the CURRENT head (no reset)", () => {
  const ms = resolveDraftGateRoundResetMs({
    draftGate: { verdict: "clean", headSha: "def5678", updatedAt: "2026-05-31T20:00:00Z" },
    currentHeadSha: "def56789abcdef",
  });
  assert.equal(ms, null);
});

test("resolveDraftGateRoundResetMs returns null when the draft_gate is not clean or absent", () => {
  assert.equal(resolveDraftGateRoundResetMs({
    draftGate: { verdict: "findings_present", headSha: "aaa1111", updatedAt: "2026-05-31T20:00:00Z" },
    currentHeadSha: "def56789abcdef",
  }), null);
  assert.equal(resolveDraftGateRoundResetMs({ draftGate: null, currentHeadSha: "def56789abcdef" }), null);
  assert.equal(resolveDraftGateRoundResetMs({}), null);
});

test("resolveDraftGateRoundResetMs + summarizeCopilotReviews agree on the reset-adjusted round count (#896 consistency)", () => {
  // Five Copilot rounds; a clean draft_gate re-passed on an earlier head at 20:00Z.
  // Both scripts apply the same reset, so only the two post-reset rounds count.
  const reviews = [
    { author: { login: "copilot[bot]" }, state: "COMMENTED", commit: { oid: "h1" }, submittedAt: "2026-05-31T18:00:00Z" },
    { author: { login: "copilot[bot]" }, state: "COMMENTED", commit: { oid: "h2" }, submittedAt: "2026-05-31T19:00:00Z" },
    { author: { login: "copilot[bot]" }, state: "COMMENTED", commit: { oid: "h3" }, submittedAt: "2026-05-31T19:30:00Z" },
    { author: { login: "copilot[bot]" }, state: "COMMENTED", commit: { oid: "h4" }, submittedAt: "2026-05-31T21:00:00Z" },
    { author: { login: "copilot[bot]" }, state: "COMMENTED", commit: { oid: "def56789abcdef" }, submittedAt: "2026-05-31T22:00:00Z" },
  ];
  const draftGate = { verdict: "clean", headSha: "aaa1111", updatedAt: "2026-05-31T20:00:00Z" };
  const currentHeadSha = "def56789abcdef";

  const resetMs = resolveDraftGateRoundResetMs({ draftGate, currentHeadSha });
  const reset = summarizeCopilotReviews(reviews, { headSha: currentHeadSha, draftGateResetAtMs: resetMs });
  const raw = summarizeCopilotReviews(reviews, { headSha: currentHeadSha });

  assert.equal(raw.completedCopilotReviewRounds, 5);
  assert.equal(reset.completedCopilotReviewRounds, 2);
});

test("sanitizeCopilotSummonTokens wraps bare @copilot and /copilot* tokens in backticks", () => {
  assert.equal(
    sanitizeCopilotSummonTokens("please @copilot re-review this"),
    "please `@copilot` re-review this",
  );
  assert.equal(
    sanitizeCopilotSummonTokens("violates the /copilot prohibition rule"),
    "violates the `/copilot` prohibition rule",
  );
  assert.equal(
    sanitizeCopilotSummonTokens("see the /copilot-review command"),
    "see the `/copilot-review` command",
  );
});

test("sanitizeCopilotSummonTokens leaves already-code-spanned tokens untouched (idempotent)", () => {
  const once = sanitizeCopilotSummonTokens("quoting the `/copilot` rule and `@copilot` login");
  assert.equal(once, "quoting the `/copilot` rule and `@copilot` login");
  const twice = sanitizeCopilotSummonTokens(once);
  assert.equal(twice, once);
});

test("sanitizeCopilotSummonTokens is idempotent for a freshly-wrapped bare token", () => {
  const once = sanitizeCopilotSummonTokens("the /copilot prohibition rule");
  const twice = sanitizeCopilotSummonTokens(once);
  assert.equal(twice, once);
});

test("sanitizeCopilotSummonTokens leaves fenced code blocks untouched", () => {
  const body = "Excerpt:\n```\n@copilot re-review\n```\nDone.";
  assert.equal(sanitizeCopilotSummonTokens(body), body);
});

test("sanitizeCopilotSummonTokens falls back to zero-width-joiner neutralization when a stray backtick defeats span-wrapping", () => {
  // A pre-existing unbalanced backtick would pair with an inserted opening
  // backtick under the guard's span-stripping, re-exposing the token.
  const probe = "uses ` oddly, violates the /copilot rule";
  const once = sanitizeCopilotSummonTokens(probe);
  assert.equal(containsBareCopilotSummon(once), false, "sanitized output must not arm the guard");
  assert.equal(sanitizeCopilotSummonTokens(once), once, "sanitizer must be idempotent for this input");
  // The fallback works on the WRAPPED line: the backtick wrap survives, with the
  // joiner neutralizing the residual token the re-paired spans left exposed.
  assert.equal(once, "uses ` oddly, violates the `/\u200Dcopilot` rule");
});

test("sanitizeCopilotSummonTokens ZWJ fallback preserves successful wraps and keeps the joiner out of legitimate code spans", () => {
  const probe = "quoting `/copilot` legit and ` stray /copilot bare";
  const once = sanitizeCopilotSummonTokens(probe);
  assert.equal(containsBareCopilotSummon(once), false, "sanitized output must not arm the guard");
  assert.equal(sanitizeCopilotSummonTokens(once), once, "sanitizer must be idempotent for this input");
  assert.ok(once.includes("`/copilot` legit"), "pre-existing legitimate code span must stay joiner-free");
  assert.match(once, /\/\u200Dcopilot/, "residual token neutralized with a zero-width joiner");
});

test("a genuine bare summon still arms the guard after sanitizer fallback changes", () => {
  assert.equal(containsBareCopilotSummon("@copilot please review"), true);
});

test("sanitizeCopilotSummonTokens stays byte-stable when adjacent code spans destabilize a backtick wrap", () => {
  // Adjacent spans re-tokenize a wrapped line differently on the next pass; an
  // unstable wrap must route to the ZWJ path instead of growing one backtick
  // per rewrite (gate comments are rewritten on every gate pass).
  const probe = "`a``b` /copilot";
  const once = sanitizeCopilotSummonTokens(probe);
  assert.equal(containsBareCopilotSummon(once), false, "sanitized output must not arm the guard");
  assert.equal(sanitizeCopilotSummonTokens(once), once, "sanitizer must be byte-identical from pass 1 on");
  assert.match(once, /\/\u200Dcopilot/, "unstable wrap neutralized with a zero-width joiner");
});

test("containsBareCopilotSummon does not rejoin fragments across a stripped code span into a phantom token", () => {
  assert.equal(containsBareCopilotSummon("@copi`x`lot"), false);
});

test("containsBareCopilotSummon arms on a summon directly abutting a code span", () => {
  assert.equal(containsBareCopilotSummon("text`x`@copilot"), true);
});

test("sanitizeCopilotSummonTokens does not mangle email-like text the guard never arms on", () => {
  const body = "contact user@copilot.example about path/copilot-adjacent naming";
  assert.equal(containsBareCopilotSummon(body), false);
  assert.equal(sanitizeCopilotSummonTokens(body), body);
});

test("sanitizeCopilotSummonTokens leaves a double-backtick GFM span untouched", () => {
  const body = "quoting `` @copilot `` inside a double-backtick span";
  assert.equal(sanitizeCopilotSummonTokens(body), body);
});

test("containsBareCopilotSummon exempts occurrences inside a double-backtick GFM span", () => {
  assert.equal(containsBareCopilotSummon("quoting `` @copilot `` inside a double-backtick span"), false);
  assert.equal(containsBareCopilotSummon("nested literal `` `/copilot` `` quoted"), false);
});

test("resolveCopilotReviewPresence: reviewer-configured repo (submitted review) reports Copilot present — never assignee-based (#1670)", () => {
  // Copilot is a REVIEWER on this repo, never an assignee. Presence must come
  // from the review surface (submitted reviews / requested reviewers), so a
  // repo with a submitted Copilot review reports PRESENT even though Copilot
  // appears in no assignee list. An assignee-based proxy would falsely report
  // absent here.
  const presence = resolveCopilotReviewPresence({
    requested: false,
    reviews: [{ author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED" }],
  });
  assert.equal(presence.present, true);
  assert.deepEqual(presence.sources, ["submitted_review"]);
  // Assignment is a disjoint surface and must never decide presence.
  const withAssignees = resolveCopilotReviewPresence({
    requested: false,
    reviews: [],
  });
  // A human-only assignee list does not fabricate Copilot presence, nor does its
  // absence erase a real submitted review already proven above.
  assert.equal(withAssignees.present, false);
});

test("resolveCopilotReviewPresence: requested reviewer reports Copilot present", () => {
  const presence = resolveCopilotReviewPresence({
    requested: true,
    reviews: [],
  });
  assert.equal(presence.present, true);
  assert.deepEqual(presence.sources, ["requested_reviewer"]);
});

test("resolveCopilotReviewPresence: no requested reviewer and no submitted review reports absent", () => {
  const presence = resolveCopilotReviewPresence({
    requested: false,
    reviews: [{ author: { login: "some-human" }, state: "APPROVED" }],
  });
  assert.equal(presence.present, false);
  assert.deepEqual(presence.sources, []);
  assert.equal(resolveCopilotReviewPresence({}).present, false);
  assert.equal(resolveCopilotReviewPresence().present, false);
});

test("resolveCopilotReviewPresence: requested reviewer AND a submitted Copilot review both report (dual source)", () => {
  // Real production combination: @copilot is a requested reviewer AND has also
  // submitted a review on the same PR. Presence stays true and both sources are
  // recorded in deterministic order (requested_reviewer, then submitted_review).
  const presence = resolveCopilotReviewPresence({
    requested: true,
    reviews: [{ author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED" }],
  });
  assert.equal(presence.present, true);
  assert.deepEqual(presence.sources, ["requested_reviewer", "submitted_review"]);
});

test("resolveCopilotReviewPresence: malformed review entries report absent without throwing", () => {
  for (const reviews of [[null], [{ author: null }], [{}], [{ author: { login: null } }]]) {
    const presence = resolveCopilotReviewPresence({ requested: false, reviews });
    assert.equal(presence.present, false);
    assert.deepEqual(presence.sources, []);
  }
  // A non-array reviews value is tolerated too.
  assert.equal(resolveCopilotReviewPresence({ requested: false, reviews: "nope" }).present, false);
});

test("containsBareCopilotSummon detects a bare-text summon literal", () => {
  assert.equal(containsBareCopilotSummon("please @copilot re-review this"), true);
  assert.equal(containsBareCopilotSummon("violates the /copilot prohibition rule"), true);
});

test("containsBareCopilotSummon exempts occurrences inside an inline code span", () => {
  assert.equal(containsBareCopilotSummon("quoting the `/copilot` rule from the guard"), false);
  assert.equal(containsBareCopilotSummon("the `@copilot` login is a bot account"), false);
});

test("containsBareCopilotSummon exempts occurrences inside a fenced code block", () => {
  const body = "Anti-summon rule excerpt:\n```\n@copilot re-review\n```\nDo not post this literally.";
  assert.equal(containsBareCopilotSummon(body), false);
});

test("containsBareCopilotSummon still detects bare text outside a fenced block sharing the same comment", () => {
  const body = "```\nsome code\n```\n@copilot please review";
  assert.equal(containsBareCopilotSummon(body), true);
});

test("round-trip: sanitizing a verdict body before posting keeps the anti-summon guard from arming on its own gate evidence", () => {
  const rawFindingsSummary = "Finding: this comment violates the /copilot prohibition rule.";
  assert.equal(containsBareCopilotSummon(rawFindingsSummary), true, "unsanitized text should still arm the guard (sanity check)");

  const sanitized = sanitizeCopilotSummonTokens(rawFindingsSummary);
  assert.equal(sanitized, "Finding: this comment violates the `/copilot` prohibition rule.");
  assert.equal(containsBareCopilotSummon(sanitized), false, "sanitized text must not arm the anti-summon guard");
});
