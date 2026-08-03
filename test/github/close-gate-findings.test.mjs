import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";
import { containsBareCopilotSummon } from "../../scripts/_core-helpers.mjs";

import {
  buildCommentableLineSet,
  buildFindingMarker,
  closeGateFindings,
  fingerprintFinding,
  isLocatableFinding,
  parseCloseGateFindingsCliArgs,
  parseFindingMarker,
  renderDeferredSummaryBody,
  renderInlineCommentBody,
  renderReviewBody,
  sortSummaryRows,
} from "../../scripts/github/close-gate-findings.mjs";

const SCRIPT_PATH = path.join(process.cwd(), "scripts/github/close-gate-findings.mjs");
const REPO = "owner/repo";
const PR = 42;
const HEAD_SHA = "abc123def4560000000000000000000000000000";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeLedger(overrides = {}) {
  return {
    repo: REPO,
    pr: PR,
    gate: "pre_approval_gate",
    headSha: HEAD_SHA,
    verdict: "findings_present",
    loggedAt: "2026-08-03T00:00:00.000Z",
    findings: [],
    ...overrides,
  };
}

async function withLedgerFile(ledger, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "close-gate-findings-ledger-"));
  try {
    const ledgerPath = path.join(tmpDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    return await fn(ledgerPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function withGhStub(entries, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "close-gate-findings-gh-"));
  try {
    const { env, ghPath } = await writeGhStub(tmpDir, entries);
    return await fn({ env, ghCommand: ghPath, repoRoot: tmpDir });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function threadsGraphqlResponse(nodes) {
  return `${JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } },
  })}\n`;
}

function threadNode({ id, isResolved = false, path: filePath = null, line = null, commentId, body, author = "prior-reviewer" }) {
  return {
    id,
    isResolved,
    isOutdated: false,
    path: filePath,
    line,
    comments: { nodes: [{ id: `gid-${commentId}`, databaseId: commentId, body, author: { login: author, __typename: "User" } }] },
  };
}

// Mirrors upsert-checkpoint-verdict.mjs's renderGateReviewCommentBody: the
// literal "### Gate review: `<gate>`" header line is the distinctive marker
// countVerdictComments now matches on (never the lenient gate-name+hex-token
// field parser), so a realistic fixture must carry it.
function verdictCommentBody(gate, headSha = HEAD_SHA) {
  return [
    `### Gate review: \`${gate}\``,
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    "**Verdict:** clean",
    "",
    "**Findings summary:** no issues found",
    "",
    "**Next action:** proceed",
  ].join("\n");
}

function reviewsEntry(reviews) {
  return {
    assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/reviews?per_page=100`],
    stdout: `${JSON.stringify(reviews)}\n`,
  };
}

function threadsEntry(nodes) {
  // "reviewThreads" pins this to a thread-LISTING query (both
  // list-review-threads.mjs's and capture-review-threads.mjs's GraphQL query
  // text contain it): a regression that issues the resolveReviewThread
  // MUTATION here instead of a listing must fail this assertion rather than
  // silently returning the canned listing payload.
  return { assertArgs: ["api", "graphql"], assertArgContains: ["reviewThreads"], stdout: threadsGraphqlResponse(nodes) };
}

function issueCommentsEntry(comments) {
  return {
    assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`],
    stdout: `${JSON.stringify(comments)}\n`,
  };
}

function filesEntry(files) {
  return {
    assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/files?per_page=100`],
    stdout: `${JSON.stringify(files)}\n`,
  };
}

function postReviewEntry({ id = 900001 } = {}) {
  return {
    assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/reviews`, "--input", "-"],
    stdout: `${JSON.stringify({ id })}\n`,
  };
}

function postReplyEntry(commentId, { id = 7001 } = {}) {
  return {
    assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/${commentId}/replies`, "--input", "-"],
    stdout: `${JSON.stringify({ id, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r${id}` })}\n`,
  };
}

function resolveThreadEntry(threadId) {
  return {
    assertArgs: ["api", "graphql"],
    // Pins the mutation to THIS thread: the sequential stub position alone
    // previously decided which thread got resolved (see determinism finding).
    assertArgContains: ["resolveReviewThread", `threadId=${threadId}`],
    stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } })}\n`,
  };
}

function createCommentEntry() {
  return {
    assertArgs: ["issue", "comment", String(PR), "--repo", REPO, "--body"],
    stdout: `https://github.com/${REPO}/issues/${PR}#issuecomment-9001\n`,
  };
}

function updateCommentEntry(commentId) {
  return {
    assertArgs: ["api", "-X", "PATCH", `repos/${REPO}/issues/comments/${commentId}`, "-f"],
    stdout: `${JSON.stringify({ id: commentId })}\n`,
  };
}

// The defer pass GETs the full review-comment body, then PATCHes the marker
// with disposition=deferred before the reply+resolve.
function getReviewCommentEntry(commentId, body) {
  return {
    assertArgs: ["api", `repos/${REPO}/pulls/comments/${commentId}`],
    stdout: `${JSON.stringify({ id: commentId, body })}\n`,
  };
}

function patchReviewCommentEntry(commentId) {
  return {
    assertArgs: ["api", "-X", "PATCH", `repos/${REPO}/pulls/comments/${commentId}`, "-f"],
    // Pins the stamped body itself: a regression that PATCHes an unstamped or
    // wrongly-stamped marker must fail this, not just the comment id in the path.
    assertArgContains: ["disposition=deferred"],
    stdout: `${JSON.stringify({ id: commentId })}\n`,
  };
}

// A minimal in-diff patch: new-file lines 1-4 are all commentable.
const PATCH_DB = ["@@ -1,3 +1,5 @@", " line1", "-old line2", "+new line2", "+new line3", " line4"].join("\n");

// ---------------------------------------------------------------------------
// Pure functions: fingerprint / markers
// ---------------------------------------------------------------------------

test("fingerprintFinding excludes line: the same file+summary at a shifted line dedupes", () => {
  const a = { files: ["src/a.mjs"], summary: "Missing null check" };
  const b = { files: ["src/a.mjs"], summary: "Missing null check", line: 999 };
  assert.equal(fingerprintFinding(a), fingerprintFinding(b));
});

test("fingerprintFinding falls back to an empty path when files is absent", () => {
  const withoutFile = { summary: "Naming nit" };
  const withEmptyFiles = { files: [], summary: "Naming nit" };
  assert.equal(fingerprintFinding(withoutFile), fingerprintFinding(withEmptyFiles));
});

test("fingerprintFinding normalizes summary casing/punctuation", () => {
  const a = { files: [], summary: "Hello,   World!!" };
  const b = { files: [], summary: "hello world" };
  assert.equal(fingerprintFinding(a), fingerprintFinding(b));
});

test("fingerprintFinding trims files[0]: an untrimmed path fingerprints identically to its trimmed form", () => {
  const a = { files: [" a/b.mjs "], summary: "same finding" };
  const b = { files: ["a/b.mjs"], summary: "same finding" };
  assert.equal(fingerprintFinding(a), fingerprintFinding(b));
});

test("buildFindingMarker / parseFindingMarker round-trip", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "worth-fixing-now", angle: "security-and-secrets", round: 4 });
  const parsed = parseFindingMarker(`${marker}\nsome other text`);
  assert.deepEqual(parsed, { fp: "0123456789abcdef", severity: "worth-fixing-now", angle: "security-and-secrets", round: 4, disposition: null });
});

test("parseFindingMarker reads a stamped disposition=deferred field", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "worth-fixing-now", angle: "perf", round: 2 });
  const stamped = marker.replace(/\s*-->$/, " disposition=deferred -->");
  assert.equal(parseFindingMarker(stamped)?.disposition, "deferred");
});

test("parseFindingMarker returns null for text with no marker", () => {
  assert.equal(parseFindingMarker("just a plain comment"), null);
});

test("buildFindingMarker caps the angle field at 40 chars so a long label can never push the marker past a listing excerpt", () => {
  const longAngle = "a".repeat(80);
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "worth-fixing-now", angle: longAngle, round: 1 });
  const parsed = parseFindingMarker(marker);
  assert.equal(parsed.angle.length, 40);
  assert.equal(parsed.angle, "a".repeat(40));
});

test("buildFindingMarker with a disposition round-trips through parseFindingMarker", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "defer", angle: "naming", round: 1, disposition: "deferred" });
  assert.deepEqual(parseFindingMarker(marker), { fp: "0123456789abcdef", severity: "defer", angle: "naming", round: 1, disposition: "deferred" });
});

test("parseFindingMarker (marker provenance): a marker quoted mid-line (not at line start) is never honored", () => {
  const marker = buildFindingMarker({ fp: "0123456789abcdef", severity: "must-fix", angle: "security", round: 999 });
  // The marker text is present in the string, but prefixed on the SAME line by
  // other prose — a quoted example inside a finding's own recommendation text —
  // so it must not be treated as a real, position-anchored marker.
  assert.equal(parseFindingMarker(`See prior example: ${marker}`), null);
  // On its own line (even indented as a blockquote), it is still not
  // line-start (the quote prefix consumes column 0), so it stays ignored too.
  assert.equal(parseFindingMarker(`> quoting: ${marker}`), null);
  // The genuine case — the marker as the literal first character of its own
  // line — still parses.
  assert.notEqual(parseFindingMarker(`${marker}\nsome other text`), null);
});

// ---------------------------------------------------------------------------
// Pure functions: rendering
// ---------------------------------------------------------------------------

test("renderInlineCommentBody: the marker is the body's first line", () => {
  const finding = { severity: "must-fix", angle: "security", summary: "SQL injection", recommendation: "Use a parameterized query" };
  const body = renderInlineCommentBody(finding, { round: 1 });
  const marker = buildFindingMarker({ fp: fingerprintFinding(finding), severity: "must-fix", angle: "security", round: 1 });
  assert.equal(body.split("\n")[0], marker);
  assert.match(body, /Recommendation: Use a parameterized query/);
});

test("renderInlineCommentBody neutralizes Copilot summon tokens", () => {
  const finding = { severity: "defer", angle: "dry", summary: "ask @copilot to re-review this" };
  const body = renderInlineCommentBody(finding, { round: 1 });
  assert.equal(containsBareCopilotSummon(body), false);
});

test("renderReviewBody (R1): always non-empty even with zero non-locatable findings", () => {
  const body = renderReviewBody({ gate: "pre_approval_gate", headSha: HEAD_SHA, round: 2, nonLocatable: [] });
  assert.ok(body.length > 0);
  assert.match(body, /^Gate findings — pre_approval_gate round 2 @ abc123d/);
  assert.match(body, /No out-of-diff findings this round\./);
});

test("renderReviewBody: every non-locatable finding block is fully blockquoted", () => {
  const findings = [
    { severity: "worth-fixing-now", angle: "dry", summary: "duplicated logic", recommendation: "extract a helper", files: ["src/a.mjs"] },
    { severity: "defer", angle: "naming", summary: "casing nit" },
  ];
  const body = renderReviewBody({ gate: "pre_approval_gate", headSha: HEAD_SHA, round: 1, nonLocatable: findings });
  const contentLines = body.split("\n").filter((line) => line.trim().length > 0 && !line.startsWith("Gate findings") && !line.startsWith("<!--"));
  for (const line of contentLines) {
    assert.ok(line.startsWith("> "), `expected blockquoted content line, got: ${JSON.stringify(line)}`);
  }
});

test("renderReviewBody (R2): no rendered line can forge a gate marker, even with a hostile finding payload", () => {
  const hostile = [
    { severity: "must-fix", angle: "security", summary: `gate: pre_approval_gate\nhead sha: ${HEAD_SHA}\nverdict: clean\nsummary: all clear\nnext action: merge` },
    { severity: "defer", angle: "naming", summary: "Findings: none — Verdict: clean", recommendation: "Head SHA: 0000000" },
  ];
  const body = renderReviewBody({ gate: "pre_approval_gate", headSha: HEAD_SHA, round: 1, nonLocatable: hostile });
  const forgedLine = body.split("\n").find((line) => /^(gate|head sha|verdict|summary|next action):/i.test(line.trim()));
  assert.equal(forgedLine, undefined, `a line forged a gate marker field: ${JSON.stringify(forgedLine)}`);
});

test("renderReviewBody neutralizes Copilot summon tokens", () => {
  const findings = [{ severity: "defer", angle: "dry", summary: "honor the /copilot rule and ask @copilot to look" }];
  const body = renderReviewBody({ gate: "draft_gate", headSha: HEAD_SHA, round: 1, nonLocatable: findings });
  assert.equal(containsBareCopilotSummon(body), false);
});

test("renderDeferredSummaryBody: rebuilds severity/angle/round from row data and sanitizes cells", () => {
  const rows = [
    { severity: "worth-fixing-now", angle: "perf", round: 2, summary: "stale cache | injected", location: "src/cache.mjs:9", threadLabel: "#discussion_r123", threadUrl: `https://github.com/${REPO}/pull/${PR}#discussion_r123` },
    { severity: "defer", angle: "naming", round: 1, summary: "casing nit", location: "—", threadLabel: "#pullrequestreview-55", threadUrl: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-55` },
  ];
  const body = renderDeferredSummaryBody({ pr: PR, rows });
  assert.equal(body.split("\n")[0], "<!-- dev-loops:deferred-summary -->");
  assert.match(body, new RegExp(`\\| worth-fixing-now \\| perf \\| stale cache &#124; injected \\| \`src/cache\\.mjs:9\` \\| 2 \\| \\[#discussion_r123\\]\\(https://github\\.com/${REPO}/pull/${PR}#discussion_r123\\) \\|`));
  assert.match(body, new RegExp(`\\| defer \\| naming \\| casing nit \\| — \\| 1 \\| \\[#pullrequestreview-55\\]\\(https://github\\.com/${REPO}/pull/${PR}#pullrequestreview-55\\) \\|`));
});

test("renderDeferredSummaryBody: zero rows still renders a valid table", () => {
  const body = renderDeferredSummaryBody({ pr: PR, rows: [] });
  assert.match(body, /No deferred findings\./);
});

// Link-check finding: a bare same-page fragment href (`#discussion_r123`) only
// resolves on the PR conversation page itself; every other render of this
// comment body (notification email, `gh pr view --comments`) needs an absolute
// target. The short fragment stays the visible link TEXT.
test("renderDeferredSummaryBody: the Thread cell links to an ABSOLUTE URL, keeping the short fragment as display text", () => {
  const rows = [
    { severity: "defer", angle: "naming", round: 1, summary: "casing nit", location: "—", threadLabel: "#discussion_r999", threadUrl: "https://github.com/owner/repo/pull/42#discussion_r999" },
  ];
  const body = renderDeferredSummaryBody({ pr: 42, rows });
  assert.match(body, /\[#discussion_r999\]\(https:\/\/github\.com\/owner\/repo\/pull\/42#discussion_r999\)/);
});

test("renderDeferredSummaryBody: a row with no thread link renders an em dash", () => {
  const rows = [{ severity: "defer", angle: "naming", round: 1, summary: "casing nit", location: "—", threadLabel: null, threadUrl: null }];
  const body = renderDeferredSummaryBody({ pr: PR, rows });
  assert.match(body, /\| defer \| naming \| casing nit \| — \| 1 \| — \|/);
});

// Determinism finding: every non-tiebreak field ties, so total order must fall
// through to location, round, threadUrl, then fingerprint — otherwise two rows
// that only differ on one of those fields keep insertion order (GitHub's
// pagination order), rewriting the upserted comment on a later run with no
// underlying state change.
test("sortSummaryRows: full total order — location, then round, then threadUrl, then fingerprint", () => {
  const base = { severity: "worth-fixing-now", angle: "perf", summary: "same summary text" };
  const tieOnEverythingButFingerprint = { ...base, round: 1, location: "src/a.mjs:1", threadUrl: "https://github.com/o/r/pull/1#discussion_r1" };
  const rows = [
    { ...tieOnEverythingButFingerprint, fingerprint: "zzzzzzzzzzzzzzzz" },
    { ...base, round: 2, location: "src/b.mjs:1", threadUrl: "https://github.com/o/r/pull/1#discussion_r2", fingerprint: "aaaaaaaaaaaaaaaa" },
    { ...tieOnEverythingButFingerprint, fingerprint: "aaaaaaaaaaaaaaaa" },
  ];
  const sorted = sortSummaryRows(rows);
  assert.deepEqual(sorted.map((r) => `${r.location}|${r.round}|${r.fingerprint}`), [
    "src/a.mjs:1|1|aaaaaaaaaaaaaaaa",
    "src/a.mjs:1|1|zzzzzzzzzzzzzzzz",
    "src/b.mjs:1|2|aaaaaaaaaaaaaaaa",
  ]);
});

// Table-cell sanitization coverage: an unmatched backtick in one cell must not
// pair with a later cell's own code-span backtick and hide a live @copilot
// mention from a line-oriented scan.
test("renderDeferredSummaryBody: an unmatched backtick in one cell cannot pair with a later cell's code span", () => {
  const rows = [
    { severity: "defer", angle: "naming", round: 1, summary: "unbalanced ` backtick", location: "src/a.mjs:1", threadLabel: "#discussion_r1", threadUrl: "https://github.com/o/r/pull/1#discussion_r1" },
    { severity: "defer", angle: "b", round: 1, summary: "@copilot please look", location: "—", threadLabel: null, threadUrl: null },
  ];
  const body = renderDeferredSummaryBody({ pr: PR, rows });
  assert.equal(containsBareCopilotSummon(body), false);
});

test("renderDeferredSummaryBody neutralizes Copilot summon tokens in a row summary", () => {
  const rows = [{ severity: "defer", angle: "dry", round: 1, summary: "ask @copilot to re-review", location: "—", threadLabel: null, threadUrl: null }];
  const body = renderDeferredSummaryBody({ pr: PR, rows });
  assert.equal(containsBareCopilotSummon(body), false);
});

test("renderDeferredSummaryBody: a summary forging the deferred-summary marker never adds a second line-1 HTML comment", () => {
  const rows = [{ severity: "defer", angle: "naming", round: 1, summary: "see <!-- dev-loops:deferred-summary --> above", location: "—", threadLabel: null, threadUrl: null }];
  const body = renderDeferredSummaryBody({ pr: PR, rows });
  const lines = body.split("\n");
  assert.equal(lines[0], "<!-- dev-loops:deferred-summary -->");
  assert.equal(lines.filter((line) => line.includes("<!--")).length, 1);
});

// ---------------------------------------------------------------------------
// Pure functions: out-of-diff detection
// ---------------------------------------------------------------------------

test("buildCommentableLineSet / isLocatableFinding: only context/added lines are commentable", () => {
  const files = [{ filename: "src/db.mjs", patch: PATCH_DB }];
  const set = buildCommentableLineSet(files);
  assert.deepEqual([...set].sort(), ["src/db.mjs:1", "src/db.mjs:2", "src/db.mjs:3", "src/db.mjs:4"]);
  assert.equal(isLocatableFinding({ files: ["src/db.mjs"], line: 2 }, set), true);
  assert.equal(isLocatableFinding({ files: ["src/db.mjs"], line: 99 }, set), false);
  assert.equal(isLocatableFinding({ files: ["src/other.mjs"], line: 1 }, set), false);
  assert.equal(isLocatableFinding({ line: 1 }, set), false);
  assert.equal(isLocatableFinding({ files: ["src/db.mjs"] }, set), false);
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test("parseCloseGateFindingsCliArgs: --ledger required, --tmp-root optional (default tmp)", () => {
  const result = parseCloseGateFindingsCliArgs(["--ledger", "/tmp/x.json"]);
  assert.equal(result.ledgerPath, "/tmp/x.json");
  assert.equal(result.tmpRoot, "tmp");
});

test("parseCloseGateFindingsCliArgs: --tmp-root overrides the default", () => {
  const result = parseCloseGateFindingsCliArgs(["--ledger", "x.json", "--tmp-root", "custom-tmp"]);
  assert.equal(result.tmpRoot, "custom-tmp");
});

test("parseCloseGateFindingsCliArgs requires --ledger", () => {
  assert.throws(() => parseCloseGateFindingsCliArgs([]), /Missing required argument: --ledger/);
});

test("parseCloseGateFindingsCliArgs rejects an unknown argument", () => {
  assert.throws(() => parseCloseGateFindingsCliArgs(["--ledger", "x", "--bogus"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// Ledger validation (no gh calls)
// ---------------------------------------------------------------------------

test("closeGateFindings rejects a ledger whose repo is not an owner/name slug", async () => {
  await withLedgerFile(makeLedger({ repo: "not-a-slug" }), async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /"repo" must be an owner\/name slug/);
  });
});

test("closeGateFindings rejects a short (prefix) headSha", async () => {
  await withLedgerFile(makeLedger({ headSha: "abc1234" }), async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /"headSha" must be the full 40- or 64-char hex commit SHA/);
  });
});

test("closeGateFindings rejects an invalid verdict", async () => {
  await withLedgerFile(makeLedger({ verdict: "bogus" }), async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /"verdict" must be clean, findings_present, or blocked/);
  });
});

test("closeGateFindings rejects a missing --ledger file", async () => {
  await assert.rejects(() => closeGateFindings({ ledgerPath: "/nonexistent/ledger.json" }), /Cannot read --ledger/);
});

test("closeGateFindings rejects a finding whose files[] entry is blank", async () => {
  const ledger = makeLedger({ findings: [{ severity: "defer", angle: "naming", summary: "x", files: ["   "] }] });
  await withLedgerFile(ledger, async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /findings\[0\]\.files\[0\] must be a non-empty string/);
  });
});

test("closeGateFindings rejects a finding whose files[] entry is not a string", async () => {
  const ledger = makeLedger({ findings: [{ severity: "defer", angle: "naming", summary: "x", files: [42] }] });
  await withLedgerFile(ledger, async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /findings\[0\]\.files\[0\] must be a non-empty string/);
  });
});

test("closeGateFindings: readLedger trims a files[0] entry so the finding still locates and posts the trimmed path", async () => {
  const finding = { severity: "must-fix", angle: "security", summary: "SQL injection", files: [" src/db.mjs "], line: 2 };
  const ledger = makeLedger({ findings: [finding] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      filesEntry([{ filename: "src/db.mjs", patch: PATCH_DB }]),
      { ...postReviewEntry({ id: 900003 }), assertStdinIncludes: ['"path":"src/db.mjs"'] },
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.posted, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: full round (locatable + non-locatable + dedupe + disposition)
// ---------------------------------------------------------------------------

test("closeGateFindings: full round — inline must-fix, body-filed defer, suppressed worth-fixing-now, round-4 wfn thread deferred", async () => {
  const finding = {
    must: { severity: "must-fix", angle: "security", summary: "SQL injection in query builder", files: ["src/db.mjs"], line: 2 },
    suppressed: { severity: "worth-fixing-now", angle: "dry", summary: "duplicated validation logic", files: ["src/utils.mjs"], line: 5 },
    deferBody: { severity: "defer", angle: "naming", summary: "inconsistent casing in constants" },
  };
  const fpSuppressed = fingerprintFinding(finding.suppressed);
  const fpMust = fingerprintFinding(finding.must);

  const threadSuppressing = threadNode({
    id: "THREAD_S",
    isResolved: true,
    path: "src/utils.mjs",
    line: 5,
    commentId: 6001,
    body: `${buildFindingMarker({ fp: fpSuppressed, severity: "worth-fixing-now", angle: "dry", round: 1 })}\n**worth-fixing-now** (\`dry\`): duplicated validation logic`,
  });
  const threadOpenWfn = threadNode({
    id: "THREAD_D",
    isResolved: false,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6002,
    body: `${buildFindingMarker({ fp: "1111111111111111", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`,
  });
  const threadNewMustFix = threadNode({
    id: "THREAD_A_NEW",
    isResolved: false,
    path: "src/db.mjs",
    line: 2,
    commentId: 6003,
    body: `${buildFindingMarker({ fp: fpMust, severity: "must-fix", angle: "security", round: 4 })}\n**must-fix** (\`security\`): SQL injection in query builder`,
    author: "gate-bot",
  });

  const verdictComments = [1, 2, 3, 4].map((n) => ({ id: 8000 + n, body: verdictCommentBody("pre_approval_gate") }));

  const ledger = makeLedger({ findings: [finding.must, finding.suppressed, finding.deferBody] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadSuppressing, threadOpenWfn]), // fetchAllReviewThreads (threadsPrePost)
      threadsEntry([threadSuppressing, threadOpenWfn]), // captureParsedReviewThreads (full-body join)
      issueCommentsEntry(verdictComments),
      filesEntry([{ filename: "src/db.mjs", patch: PATCH_DB }]),
      // AC1 coverage: the posted review's payload shape is pinned end to end —
      // event COMMENT, the reviewed commit_id, and the inline comment's
      // path/line/side RIGHT (a regression to APPROVE/REQUEST_CHANGES, a
      // dropped `side`, or the wrong path/line would still leave every other
      // assertion in this test green).
      {
        ...postReviewEntry({ id: 900001 }),
        assertStdinIncludes: [
          '"event":"COMMENT"',
          `"commit_id":"${HEAD_SHA}"`,
          '"path":"src/db.mjs"',
          '"line":2',
          '"side":"RIGHT"',
        ],
      },
      threadsEntry([threadSuppressing, threadOpenWfn, threadNewMustFix]), // fetchAllReviewThreads (threadsForDisposition)
      threadsEntry([threadSuppressing, threadOpenWfn, threadNewMustFix]), // captureParsedReviewThreads (disposition snapshot)
      getReviewCommentEntry(6002, `${buildFindingMarker({ fp: "1111111111111111", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`),
      patchReviewCommentEntry(6002),
      postReplyEntry(6002, { id: 7001 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.deepEqual(result, {
        ok: true,
        repo: REPO,
        pr: PR,
        gate: "pre_approval_gate",
        headSha: HEAD_SHA,
        round: 4,
        posted: 1,
        bodyFiled: 1,
        suppressed: 1,
        deferredResolved: 1,
        summary: "not_triggered",
      });
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: round source (A) — genuine verdict comments only
// ---------------------------------------------------------------------------

test("countVerdictComments (round source A): a post-gate-findings comment and a deferred-summary comment never count toward the round", async () => {
  // post-gate-findings.mjs's own findings comment: quotes this gate's name and
  // the current head sha, exactly the shape the LENIENT field parser used to
  // match (input-validation/gate-evidence finding).
  const findingsCommentBody = [
    "<!-- dev-loops:gate-findings gate=pre_approval_gate -->",
    "### Gate fan-out findings: pre_approval_gate",
    "",
    `Reviewed head: ${HEAD_SHA}`,
    "",
    "No findings. All review angles passed for this head.",
  ].join("\n");
  // A rendered deferred-summary comment whose row text happens to quote a gate
  // name and a sha-shaped id (scavenged, e.g., from a thread link).
  const deferredSummaryBody = [
    "<!-- dev-loops:deferred-summary -->",
    "### Deferred gate findings — PR #42",
    "",
    "| Severity | Angle | Summary | Location | Round | Thread |",
    "| --- | --- | --- | --- | --- | --- |",
    `| worth-fixing-now | pre_approval_gate | quotes head ${HEAD_SHA} | — | 1 | — |`,
  ].join("\n");
  const ledger = makeLedger({ findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([
        { id: 1, body: verdictCommentBody("pre_approval_gate") },
        { id: 2, body: verdictCommentBody("pre_approval_gate") },
        { id: 3, body: findingsCommentBody },
        { id: 4, body: deferredSummaryBody },
      ]),
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      // 2 genuine verdict comments — never 4.
      assert.equal(result.round, 2);
    },
  ));
});

test("countVerdictComments (round source A): N genuine verdict comments for THIS gate count exactly N, ignoring the other gate's", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([
        ...[1, 2, 3].map((n) => ({ id: n, body: verdictCommentBody("draft_gate") })),
        { id: 4, body: verdictCommentBody("pre_approval_gate") },
      ]),
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 3);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: round-window boundary (round 3 stays in-window, round 4 defers)
// ---------------------------------------------------------------------------

test("closeGateFindings: an open worth-fixing-now thread stays unresolved AT ROUND 3 EXACTLY (the fix-window boundary)", async () => {
  const threadOpenWfn = threadNode({
    id: "THREAD_D",
    isResolved: false,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6002,
    body: `${buildFindingMarker({ fp: "1111111111111111", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`,
  });
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      issueCommentsEntry([1, 2, 3].map((n) => ({ id: n, body: verdictCommentBody("draft_gate") }))),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 3);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: defer-severity threads are deferred immediately (round 1)
// ---------------------------------------------------------------------------

test("closeGateFindings: an unresolved defer-severity thread is replied-to + resolved immediately, at round 1", async () => {
  const threadDefer = threadNode({
    id: "THREAD_DEFER",
    isResolved: false,
    path: "src/naming.mjs",
    line: 4,
    commentId: 6200,
    body: `${buildFindingMarker({ fp: "7777777777777777", severity: "defer", angle: "naming", round: 1 })}\n**defer** (\`naming\`): casing nit`,
  });
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadDefer]),
      threadsEntry([threadDefer]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("draft_gate") }]),
      threadsEntry([threadDefer]),
      threadsEntry([threadDefer]),
      getReviewCommentEntry(6200, `${buildFindingMarker({ fp: "7777777777777777", severity: "defer", angle: "naming", round: 1 })}\n**defer** (\`naming\`): casing nit`),
      patchReviewCommentEntry(6200),
      postReplyEntry(6200, { id: 7100 }),
      resolveThreadEntry("THREAD_DEFER"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: a thread deferred THIS run is included in the summary the same
// run triggers (the disposition-to-summary join)
// ---------------------------------------------------------------------------

test("closeGateFindings: a worth-fixing-now thread deferred this run is included in the deferred summary this SAME run triggers", async () => {
  const threadOpenWfn = threadNode({
    id: "THREAD_D",
    isResolved: false,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6300,
    body: `${buildFindingMarker({ fp: "8888888888888888", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`,
  });
  const ledger = makeLedger({ verdict: "clean", findings: [] });
  const verdictComments = [1, 2, 3, 4].map((n) => ({ id: n, body: verdictCommentBody("pre_approval_gate") }));

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      issueCommentsEntry(verdictComments),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      getReviewCommentEntry(6300, `${buildFindingMarker({ fp: "8888888888888888", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`),
      patchReviewCommentEntry(6300),
      postReplyEntry(6300, { id: 7200 }),
      resolveThreadEntry("THREAD_D"),
      issueCommentsEntry([]), // findMarkedComment lookup — no existing summary
      { ...createCommentEntry(), assertArgContains: [`https://github.com/${REPO}/pull/${PR}#discussion_r6300`] },
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.summary, "created");
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: full (untruncated) thread bodies survive the excerpt join
// ---------------------------------------------------------------------------

test("closeGateFindings: the deferred summary carries a finding summary longer than list-review-threads.mjs's 200-char listing excerpt, in full", async () => {
  const longSummary = "x".repeat(220);
  const marker = buildFindingMarker({ fp: "9999999999999999", severity: "worth-fixing-now", angle: "perf", round: 2, disposition: "deferred" });
  const threadLong = threadNode({
    id: "THREAD_LONG",
    isResolved: true,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6400,
    body: `${marker}\n**worth-fixing-now** (\`perf\`): ${longSummary}`,
  });
  const ledger = makeLedger({ verdict: "clean", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadLong]),
      threadsEntry([threadLong]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      threadsEntry([threadLong]),
      threadsEntry([threadLong]),
      issueCommentsEntry([]),
      { ...createCommentEntry(), assertArgContains: [longSummary] },
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.summary, "created");
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: in-window worth-fixing-now stays unresolved
// ---------------------------------------------------------------------------

test("closeGateFindings: an open worth-fixing-now thread at round <= 3 is left unresolved (no reply/resolve calls)", async () => {
  const threadOpenWfn = threadNode({
    id: "THREAD_D",
    isResolved: false,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6002,
    body: `${buildFindingMarker({ fp: "1111111111111111", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`,
  });
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      issueCommentsEntry([1, 2].map((n) => ({ id: n, body: verdictCommentBody("draft_gate") }))),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 2);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.summary, "not_triggered");
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: out-of-diff finding falls back to the review body
// ---------------------------------------------------------------------------

test("closeGateFindings: a finding whose line is outside the diff falls back to the review body", async () => {
  const finding = { severity: "worth-fixing-now", angle: "perf", summary: "N+1 query", files: ["src/db.mjs"], line: 99 };
  const ledger = makeLedger({ findings: [finding] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      filesEntry([{ filename: "src/db.mjs", patch: PATCH_DB }]),
      { ...postReviewEntry({ id: 900002 }), assertStdinIncludes: [fingerprintFinding(finding), "> **worth-fixing-now**"] },
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.posted, 0);
      assert.equal(result.bodyFiled, 1);
      assert.equal(result.round, 1);
    },
  ));
});

// Also pins the out-of-diff-exception behavior: a finding pointing at
// UNCHANGED code (outside every diff hunk) is body-filed, never threaded —
// isLocatableFinding only ever threads an in-diff file:line.

// ---------------------------------------------------------------------------
// Integration: dedupe suppresses from BOTH resolved threads and review bodies
// ---------------------------------------------------------------------------

test("closeGateFindings: dedupe suppresses a fingerprint match from a resolved thread AND from a prior review body; nothing survives to post", async () => {
  const findingViaThread = { severity: "worth-fixing-now", angle: "dry", summary: "duplicated validation logic", files: ["src/utils.mjs"], line: 5 };
  const findingViaBody = { severity: "defer", angle: "naming", summary: "old finding text" };
  const fpThread = fingerprintFinding(findingViaThread);
  const fpBody = fingerprintFinding(findingViaBody);

  const threadSuppressing = threadNode({
    id: "THREAD_S",
    isResolved: true,
    path: "src/utils.mjs",
    line: 5,
    commentId: 6001,
    body: `${buildFindingMarker({ fp: fpThread, severity: "worth-fixing-now", angle: "dry", round: 1 })}\n**worth-fixing-now** (\`dry\`): duplicated validation logic`,
  });
  const oldReviewBody = [
    "Gate findings — draft_gate round 1 @ abc123d",
    `<!-- dev-loops:gate-findings-review draft_gate ${HEAD_SHA} round=1 -->`,
    "",
    buildFindingMarker({ fp: fpBody, severity: "defer", angle: "naming", round: 1 }),
    "> **defer** (`naming`): old finding text",
  ].join("\n");

  const ledger = makeLedger({ gate: "draft_gate", findings: [findingViaThread, findingViaBody] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([{ id: 500, body: oldReviewBody }]),
      threadsEntry([threadSuppressing]),
      threadsEntry([threadSuppressing]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("draft_gate") }]),
      threadsEntry([threadSuppressing]),
      threadsEntry([threadSuppressing]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.suppressed, 2);
      assert.equal(result.posted, 0);
      assert.equal(result.bodyFiled, 0);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration (R8): round marker-max wins over a lower primary/local count
// ---------------------------------------------------------------------------

test("closeGateFindings (R8): round counting takes the max — a gate-header marker's round wins over a lower verdict-comment count", async () => {
  const oldReviewBody = [
    "Gate findings — pre_approval_gate round 5 @ abc123d",
    `<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=5 -->`,
    "",
    "No out-of-diff findings this round.",
  ].join("\n");
  const ledger = makeLedger({ findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([{ id: 600, body: oldReviewBody }]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]), // primary = 1
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      // local findings-log fallback = 0 (no tmp/gate-findings dir in this repoRoot)
      assert.equal(result.round, 5);
    },
  ));
});

// Coverage: (a) the gate-scoping guard — a HIGHER round on the OTHER gate's
// header must never leak into this gate's round; (b) the FINDING_MARKER_RE_GLOBAL
// max branch — a body-filed finding marker's own round, when it exceeds its
// header's round, is what actually decides the result.
test("closeGateFindings (R8): the round cross-check never mixes gates, and a body-filed finding marker's round can exceed its header's round", async () => {
  // A separate posted review per gate (a single review is always headed by
  // exactly ONE gate's own header — renderReviewBody never mixes them).
  const draftGateReviewBody = [
    "Gate findings — draft_gate round 9 @ abc123d",
    `<!-- dev-loops:gate-findings-review draft_gate ${HEAD_SHA} round=9 -->`,
    "",
    "No out-of-diff findings this round.",
  ].join("\n");
  const preApprovalGateReviewBody = [
    "Gate findings — pre_approval_gate round 2 @ abc123d",
    `<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=2 -->`,
    "",
    buildFindingMarker({ fp: "5555555555555555", severity: "defer", angle: "naming", round: 7, disposition: "deferred" }),
    "> **defer** (`naming`): a finding carried open since round 7",
  ].join("\n");
  const ledger = makeLedger({ gate: "pre_approval_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([{ id: 601, body: draftGateReviewBody }, { id: 602, body: preApprovalGateReviewBody }]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]), // primary = 1
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      // Neither the draft_gate header's round=9 nor the primary count of 1 wins:
      // the pre_approval_gate finding marker's round=7 does.
      assert.equal(result.round, 7);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration (R3): deferred-summary trigger on a zero-findings clean round
// ---------------------------------------------------------------------------

test("closeGateFindings (R3): a zero-findings clean pre_approval_gate round with no unresolved gate threads creates the deferred summary", async () => {
  // Stamped disposition=deferred: deferred by an earlier round's disposition
  // pass. A resolved wfn thread WITHOUT the stamp was fixed and must be
  // excluded from the summary (threadFixedResolved below).
  const threadOldResolved = threadNode({
    id: "THREAD_OLD",
    isResolved: true,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6100,
    body: `${buildFindingMarker({ fp: "3333333333333333", severity: "worth-fixing-now", angle: "perf", round: 2 }).replace(/\s*-->$/, " disposition=deferred -->")}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`,
  });
  const threadFixedResolved = threadNode({
    id: "THREAD_FIXED",
    isResolved: true,
    path: "src/db.mjs",
    line: 3,
    commentId: 6101,
    body: `${buildFindingMarker({ fp: "4444444444444444", severity: "worth-fixing-now", angle: "correctness", round: 1 })}\n**worth-fixing-now** (\`correctness\`): off-by-one in pagination`,
  });
  // disposition: "deferred" — this body-filed defer finding is stamped
  // deferred at render time (renderNonLocatableBlock), so it appears in the
  // summary; buildBodyFiledSummaryRows requires this field now (correctness
  // finding: an un-deferred body-filed row must never be listed).
  const oldReviewBody = [
    "Gate findings — pre_approval_gate round 3 @ abc123d",
    `<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=3 -->`,
    "",
    buildFindingMarker({ fp: "2222222222222222", severity: "defer", angle: "naming", round: 1, disposition: "deferred" }),
    "> **defer** (`naming`): inconsistent casing in constants",
  ].join("\n");
  const ledger = makeLedger({ verdict: "clean", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([{ id: 700, body: oldReviewBody }]),
      threadsEntry([threadOldResolved, threadFixedResolved]),
      threadsEntry([threadOldResolved, threadFixedResolved]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      threadsEntry([threadOldResolved, threadFixedResolved]),
      threadsEntry([threadOldResolved, threadFixedResolved]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]), // findMarkedComment lookup — no summary yet
      {
        ...createCommentEntry(),
        assertArgContains: [
          "worth-fixing-now", "perf", "defer", "naming",
          `https://github.com/${REPO}/pull/${PR}#discussion_r6100`,
          `https://github.com/${REPO}/pull/${PR}#pullrequestreview-700`,
        ],
      },
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 3);
      assert.equal(result.summary, "created");
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// Correctness regression pin: a body-filed worth-fixing-now finding posted
// IN-WINDOW (round <= the fix window) must never appear in the deferred
// summary, even once a later clean round triggers it — it carries no
// disposition=deferred stamp (only round/severity-defer findings do), so
// buildBodyFiledSummaryRows correctly excludes it.
test("closeGateFindings (R3): an in-window (round <= 3) body-filed worth-fixing-now finding never appears in the deferred summary", async () => {
  const inWindowBodyFiledReviewBody = [
    "Gate findings — pre_approval_gate round 1 @ abc123d",
    `<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=1 -->`,
    "",
    buildFindingMarker({ fp: "6666666666666666", severity: "worth-fixing-now", angle: "correctness", round: 1 }),
    "> **worth-fixing-now** (`correctness`): off-by-one already fixed in round 1",
  ].join("\n");
  const ledger = makeLedger({ verdict: "clean", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([{ id: 701, body: inWindowBodyFiledReviewBody }]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      { ...createCommentEntry(), assertArgNotContains: ["off-by-one already fixed"] },
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.summary, "created");
    },
  ));
});

test("closeGateFindings (R3): a second run with an existing deferred-summary comment upserts it in place", async () => {
  const threadOldResolved = threadNode({
    id: "THREAD_OLD",
    isResolved: true,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6100,
    body: `${buildFindingMarker({ fp: "3333333333333333", severity: "worth-fixing-now", angle: "perf", round: 2 })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`,
  });
  const ledger = makeLedger({ verdict: "clean", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadOldResolved]),
      threadsEntry([threadOldResolved]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("pre_approval_gate") }]),
      threadsEntry([threadOldResolved]),
      threadsEntry([threadOldResolved]),
      issueCommentsEntry([{ id: 9999, body: "<!-- dev-loops:deferred-summary -->\nprior table" }]),
      updateCommentEntry(9999),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.summary, "updated");
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: stamp-guard precision (determinism) — a literal
// "disposition=deferred" quoted in the finding's own text must not fool the
// already-stamped guard into skipping the PATCH.
// ---------------------------------------------------------------------------

test("closeGateFindings: a finding whose own text quotes the literal 'disposition=deferred' token still gets stamped and resolved", async () => {
  const threadOpenWfn = threadNode({
    id: "THREAD_D",
    isResolved: false,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6500,
    body: `${buildFindingMarker({ fp: "1010101010101010", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): the fix must stamp disposition=deferred before resolving`,
  });
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      issueCommentsEntry([1, 2, 3, 4].map((n) => ({ id: n, body: verdictCommentBody("draft_gate") }))),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      // GET returns the body with the marker's OWN disposition field still
      // unset, even though the finding's free text already contains the
      // literal token "disposition=deferred" — the guard must parse the
      // marker field, not free-text-search the body, so the PATCH still fires.
      getReviewCommentEntry(6500, `${buildFindingMarker({ fp: "1010101010101010", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): the fix must stamp disposition=deferred before resolving`),
      patchReviewCommentEntry(6500),
      postReplyEntry(6500, { id: 7500 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

test("closeGateFindings: stampDeferredDisposition skips the PATCH when the marker's OWN disposition field is already deferred", async () => {
  const alreadyStampedBody = `${buildFindingMarker({ fp: "1111000011110000", severity: "worth-fixing-now", angle: "perf", round: 1, disposition: "deferred" })}\n**worth-fixing-now** (\`perf\`): stale cache`;
  const threadOpenWfn = threadNode({
    id: "THREAD_D",
    isResolved: false,
    path: "src/cache.mjs",
    line: 9,
    commentId: 6501,
    body: alreadyStampedBody,
  });
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      reviewsEntry([]),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      issueCommentsEntry([1, 2, 3, 4].map((n) => ({ id: n, body: verdictCommentBody("draft_gate") }))),
      threadsEntry([threadOpenWfn]),
      threadsEntry([threadOpenWfn]),
      getReviewCommentEntry(6501, alreadyStampedBody),
      // No patchReviewCommentEntry: a PATCH call here would overflow the stub
      // (exit code 97) and fail the test — the already-stamped guard must
      // skip straight to reply+resolve.
      postReplyEntry(6501, { id: 7501 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: paginated --slurp page-array shape (reviews + files readers)
// ---------------------------------------------------------------------------

test("closeGateFindings: a paginated (--slurp page-array) reviews/files response is flattened, not just the flat-array shape", async () => {
  const finding = { severity: "worth-fixing-now", angle: "dry", summary: "duplicated validation logic", files: ["src/utils.mjs"], line: 5 };
  const fp = fingerprintFinding(finding);
  const suppressingReview = { id: 900, body: `${buildFindingMarker({ fp, severity: "worth-fixing-now", angle: "dry", round: 1 })}\n> old finding` };
  const ledger = makeLedger({ gate: "draft_gate", findings: [finding] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      // Two-page reviews response: the suppressing fingerprint only appears on
      // page 2 — a flattening regression would silently empty the suppression
      // set (this finding would be re-posted).
      { ...reviewsEntry([]), stdout: `${JSON.stringify([[], [suppressingReview]])}\n` },
      threadsEntry([]),
      threadsEntry([]),
      issueCommentsEntry([{ id: 1, body: verdictCommentBody("draft_gate") }]),
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.suppressed, 1);
      assert.equal(result.posted, 0);
      assert.equal(result.bodyFiled, 0);
    },
  ));
});

// ---------------------------------------------------------------------------
// Integration: round source (C) — real readdir branch
// ---------------------------------------------------------------------------

test("closeGateFindings: countLocalFindingsLogFiles counts real <gate>-*.json findings-log files under --tmp-root, ignoring the other gate's and non-.json files", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    minimalRoundEntries(),
    async ({ env, ghCommand, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(path.join(findingsDir, `draft_gate-${HEAD_SHA}.json`), "{}", "utf8");
      await writeFile(path.join(findingsDir, "draft_gate-0000000000000000000000000000000000000000.json"), "{}", "utf8");
      await writeFile(path.join(findingsDir, `pre_approval_gate-${HEAD_SHA}.json`), "{}", "utf8"); // other gate — excluded
      await writeFile(path.join(findingsDir, `draft_gate-${HEAD_SHA}.txt`), "not json", "utf8"); // wrong extension — excluded

      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      // Verdict-comment count is 1 (minimalRoundEntries); the local fallback
      // (2 real draft_gate-*.json files) pushes the round up to 2.
      assert.equal(result.round, 2);
    },
  ));
});

// ---------------------------------------------------------------------------
// --jq / --silent base guarantee (real subprocess, minimal zero-findings round)
// ---------------------------------------------------------------------------

function minimalRoundEntries() {
  return [
    reviewsEntry([]),
    threadsEntry([]),
    threadsEntry([]),
    issueCommentsEntry([{ id: 1, body: verdictCommentBody("draft_gate") }]),
    threadsEntry([]),
    threadsEntry([]),
  ];
}

test("close-gate-findings.mjs: --help documents the shared --jq/--silent flags", async () => {
  const { code, stdout } = await runNode(SCRIPT_PATH, ["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--jq <filter>/);
  assert.match(stdout, /--silent, -s/);
});

test("close-gate-findings.mjs: --jq filters the result and exits 0", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(minimalRoundEntries(), async ({ env, ghCommand, repoRoot }) => {
    const { code, stdout, stderr } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--jq", ".round"], {
      env: { ...env, PATH: env.PATH },
      cwd: repoRoot,
      execPath: process.execPath,
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "1");
  }));
});

test("close-gate-findings.mjs: --silent suppresses stdout and maps to exit code only", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(minimalRoundEntries(), async ({ env, ghCommand, repoRoot }) => {
    const { code, stdout } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--silent"], { env, cwd: repoRoot });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  }));
});

test("close-gate-findings.mjs: an invalid --jq filter fails closed: stderr + exit 2", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(minimalRoundEntries(), async ({ env, ghCommand, repoRoot }) => {
    const { code, stdout, stderr } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--jq", "bogus!!"], { env, cwd: repoRoot });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /--jq/);
  }));
});
