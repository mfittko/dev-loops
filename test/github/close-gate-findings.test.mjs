import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { makeGhMock, runIdFreeEnv, runNode, writeGhStub } from "../_helpers.mjs";

import {
  buildMeritRationale,
  closeGateFindings,
  parseCloseGateFindingsCliArgs,
} from "../../scripts/github/close-gate-findings.mjs";
import { buildFindingMarker, fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { loadDevLoopConfig, resolveTrackerProvider } from "@dev-loops/core/config";

// #1592: several fixtures below deliberately keep pre-rename severity
// spellings ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.
const SCRIPT_PATH = path.join(process.cwd(), "scripts/github/close-gate-findings.mjs");
const REPO = "owner/repo";
const PR = 42;
const HEAD_SHA = "abc123def4560000000000000000000000000000";

// The `gh api user` login closeGateFindings resolves once and uses as the sole
// trust boundary for gate-authored provenance (selectDispositionTargets' author
// check). Every thread fixture defaults to it; a test proving FOREIGN authorship
// is rejected passes an explicit, different author instead.
const AUTHENTICATED_LOGIN = "gate-bot";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userEntry({ login = AUTHENTICATED_LOGIN } = {}) {
  return { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login })}\n` };
}

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
    const { runChild } = makeGhMock(entries);
    return await fn({ env: runIdFreeEnv(), ghCommand: "gh", runChild, repoRoot: tmpDir });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function withCliGhStub(entries, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "close-gate-findings-gh-cli-"));
  try {
    const { env } = await writeGhStub(tmpDir, entries);
    return await fn({ env, repoRoot: tmpDir });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function threadsGraphqlResponse(nodes) {
  return `${JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } },
  })}\n`;
}

// `replies` (default []) models comments AFTER the thread's own first
// (marker) comment — captureParsedReviewThreads' full-comments walk (the
// reject-close answer-reply detection) sees these; the LISTING walk
// (fetchAllReviewThreads, comments(first: 1)) only ever reads index 0, so
// adding replies here never changes existing listing-only fixtures.
function threadNode({ id, isResolved = false, path: filePath = null, line = null, commentId, body, author = AUTHENTICATED_LOGIN, replies = [] }) {
  return {
    id,
    isResolved,
    isOutdated: false,
    path: filePath,
    line,
    comments: {
      nodes: [
        { id: `gid-${commentId}`, databaseId: commentId, body, author: { login: author, __typename: "User" } },
        ...replies.map((r, i) => ({
          id: `gid-${commentId}-reply-${i}`,
          databaseId: r.commentId ?? `${commentId}-reply-${i}`,
          body: r.body,
          author: { login: r.author ?? "operator", __typename: "User" },
        })),
      ],
    },
  };
}

// Rendered through the real producer (upsert-checkpoint-verdict.mjs's
// renderGateReviewCommentBody) rather than restating its header literal, so
// this fixture can never drift from what round source (A)'s
// matchGateReviewCommentHeader/reviewed-head-SHA parsing actually recognizes.
function verdictBody(gate, headSha = HEAD_SHA) {
  return renderGateReviewCommentBody({
    gate,
    headSha,
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "proceed",
  });
}

// A distinct-but-valid 40-hex "reviewed head sha" for round-history fixtures.
// Round source (A) counts DISTINCT reviewed-head SHAs UNIONED with the ledger's
// own head, so N completed rounds are modelled by N-1 older heads plus the
// ledger head — the way production data (a new head per fix round) actually is.
function nthHeadSha(n) {
  return `${HEAD_SHA.slice(0, -2)}${String(n).padStart(2, "0")}`;
}

// N completed rounds' verdict surfaces for `gate`: N-1 older heads plus this
// round's own head (already posted by upsert-checkpoint-verdict.mjs).
function roundHistory(gate, rounds) {
  const bodies = [];
  for (let n = 1; n < rounds; n += 1) bodies.push(verdictBody(gate, nthHeadSha(n)));
  bodies.push(verdictBody(gate, HEAD_SHA));
  return bodies.map((body, i) => ({ id: 8000 + i, body }));
}

function reviewsEntry(reviews) {
  // Fixtures model SUBMITTED reviews; listPrReviews filters out anything
  // without a real submitted_at (same predicate as normalizePrReviewsPayload).
  const submitted = reviews.map((r) => ({ state: "COMMENTED", submitted_at: "2026-08-03T10:00:00Z", ...r }));
  return {
    assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/reviews?per_page=100`],
    stdout: `${JSON.stringify(submitted)}\n`,
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
    // previously decided which thread got resolved.
    assertArgContains: ["resolveReviewThread", `threadId=${threadId}`],
    stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } })}\n`,
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

// The deferral comment target lookup: `gh pr view --json closingIssuesReferences`.
// `closing` lists the PR's closing issue numbers.
function prViewEntry(closing = []) {
  return {
    assertArgs: ["pr", "view", String(PR), "--repo", REPO, "--json", "closingIssuesReferences"],
    stdout: `${JSON.stringify({ closingIssuesReferences: closing.map((number) => ({ number, repository: { name: "repo", owner: { login: "owner" } } })) })}\n`,
  };
}

// The target's existing comments, read for already-listed fingerprints.
function targetCommentsEntry(target, comments = []) {
  return {
    assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/issues/${target}/comments?per_page=100`],
    stdout: `${JSON.stringify(comments)}\n`,
  };
}

// The ONE batched deferral comment: `gh issue comment` prints the new
// comment's URL on stdout.
function appendFollowUpIssueEntry(issueNumber, { contains = [], notContains = [] } = {}) {
  return {
    assertArgs: ["issue", "comment", String(issueNumber), "--repo", REPO],
    assertArgContains: contains,
    assertArgNotContains: notContains,
    stdout: `https://github.com/${REPO}/issues/${issueNumber}#issuecomment-1\n`,
  };
}

// The full deferral comment sequence when the PR has exactly one closing
// reference (`target`): target lookup, listed-fingerprint read, one comment.
// No `gh issue create` fixture exists: any issue-create call overflows the
// sequential stub and fails the run.
function deferralCommentEntries(target, { listed = [], contains = [], notContains = [] } = {}) {
  return [prViewEntry([target]), targetCommentsEntry(target, listed), appendFollowUpIssueEntry(target, { contains, notContains })];
}

// closeGateFindings' fixed gh call order: `api user`, reviews, issue comments,
// then the thread listing + full-body walk that feed the disposition pass.
function roundEntries({ reviews = [], issueComments = [{ id: 1, body: verdictBody("draft_gate") }], threads = [], fullBodyThreads = threads } = {}) {
  return [
    userEntry(),
    reviewsEntry(reviews),
    issueCommentsEntry(issueComments),
    threadsEntry(threads),
    threadsEntry(fullBodyThreads),
  ];
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test("parseCloseGateFindingsCliArgs: --ledger required, --tmp-root optional (default undefined -> main-worktree ledger anchor)", () => {
  const result = parseCloseGateFindingsCliArgs(["--ledger", "/tmp/x.json"]);
  assert.equal(result.ledgerPath, "/tmp/x.json");
  // Undefined (not "tmp") so an omitted --tmp-root reaches the main-worktree
  // ledger anchor in closeGateFindings; an explicit --tmp-root wins.
  assert.equal(result.tmpRoot, undefined);
});

test("parseCloseGateFindingsCliArgs: --tmp-root overrides the default", () => {
  assert.equal(parseCloseGateFindingsCliArgs(["--ledger", "x.json", "--tmp-root", "custom-tmp"]).tmpRoot, "custom-tmp");
});

test("parseCloseGateFindingsCliArgs: --allowed-refs parses to a deduped positive-int id list (default [])", () => {
  assert.deepEqual(parseCloseGateFindingsCliArgs(["--ledger", "x.json"]).allowedRefs, []);
  assert.deepEqual(parseCloseGateFindingsCliArgs(["--ledger", "x.json", "--allowed-refs", "1951, 1951, 42"]).allowedRefs, ["1951", "42"]);
});

test("parseCloseGateFindingsCliArgs: --allowed-refs rejects a non-positive-integer id", () => {
  assert.throws(() => parseCloseGateFindingsCliArgs(["--ledger", "x.json", "--allowed-refs", "abc"]), /--allowed-refs must be a comma-separated list of positive integers/);
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
  await assert.rejects(() => closeGateFindings({ ledgerPath: "/nonexistent/ledger.json" }), /Cannot read gate findings ledger/);
});

test("closeGateFindings rejects a finding whose files[] entry is blank", async () => {
  const ledger = makeLedger({ findings: [{ severity: "nice-to-have", angle: "naming", summary: "x", files: ["   "] }] });
  await withLedgerFile(ledger, async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /findings\[0\]\.files\[0\] must be a non-empty string/);
  });
});

test("closeGateFindings rejects a finding whose files[] entry is not a string", async () => {
  const ledger = makeLedger({ findings: [{ severity: "nice-to-have", angle: "naming", summary: "x", files: [42] }] });
  await withLedgerFile(ledger, async (ledgerPath) => {
    await assert.rejects(() => closeGateFindings({ ledgerPath }), /findings\[0\]\.files\[0\] must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// AC1: this helper posts NOTHING of its own — no review, no summary comment
// ---------------------------------------------------------------------------

test("closeGateFindings posts no review and no comment of its own: a round with findings makes only read calls plus thread disposition", async () => {
  const finding = { severity: "must-fix", angle: "security", summary: "SQL injection", files: ["src/db.mjs"], line: 2 };
  const ledger = makeLedger({ findings: [finding] });

  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    // Exactly the five read calls: a POST review / issue comment / files fetch
    // would overflow the stub (exit 97) and fail this run.
    roundEntries({ issueComments: [{ id: 1, body: verdictBody("pre_approval_gate") }] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.deepEqual(result, {
        ok: true,
        repo: REPO,
        pr: PR,
        gate: "pre_approval_gate",
        headSha: HEAD_SHA,
        round: 1,
        deferredResolved: 0,
        rejectClosed: 0,
        evidenceOnlyClosed: 0,
        unresolvedGateThreadCount: 0,
        foldedFiled: 0,
      });
    },
  ));
});

// ---------------------------------------------------------------------------
// Round source (A): distinct reviewed heads across both verdict surfaces
// ---------------------------------------------------------------------------

test("round source (A): a findings-review artifact and a deferred-summary comment never count toward the round", async () => {
  // A historical standalone findings review that quotes this gate's name and
  // the current head sha — exactly the shape the LENIENT field parser would
  // match — plus a historical deferred-summary comment doing the same.
  const legacyFindingsReview = [
    "Gate findings — pre_approval_gate round 1 @ abc123d",
    `<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=1 -->`,
    "",
    "No out-of-diff findings this round.",
  ].join("\n");
  const legacyDeferredSummary = [
    "<!-- dev-loops:deferred-summary -->",
    "### Deferred gate findings — PR #42",
    "",
    `| worth-fixing-now | pre_approval_gate | quotes head ${HEAD_SHA} | — | 1 | — |`,
  ].join("\n");

  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      issueComments: [
        ...roundHistory("pre_approval_gate", 2),
        { id: 3, body: legacyFindingsReview },
        { id: 4, body: legacyDeferredSummary },
      ],
    }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      // 2 genuine verdict surfaces (distinct reviewed heads) — never 4.
      assert.equal(result.round, 2);
    },
  ));
});

test("round source (A): N genuine verdict surfaces for THIS gate count exactly N, ignoring the other gate's", async () => {
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      issueComments: [...roundHistory("draft_gate", 3), { id: 4, body: verdictBody("pre_approval_gate", nthHeadSha(9)) }],
    }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 3);
    },
  ));
});

test("round source (A): a comment merely QUOTING the verdict header (a blockquoted reply) never counts toward the round", async () => {
  const quotedHeaderReply = `> ${verdictBody("draft_gate").split("\n")[0]}\nAgreed, looks good.`;
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: [{ id: 1, body: verdictBody("draft_gate") }, { id: 2, body: quotedHeaderReply }] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 1);
    },
  ));
});

// The verdict now lives on the PR-REVIEW stream, with the issue-comment stream
// kept as the legacy/back-compat source. Round is the SIZE of the SET of
// distinct reviewed heads across BOTH, so the same head on both counts ONCE — a
// raw per-stream count would inflate the round and end the fix window early.
test("round source (A): the SAME reviewed head's verdict on BOTH the review and issue-comment streams counts ONCE", async () => {
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      reviews: [{ id: 501, body: verdictBody("pre_approval_gate") }],
      issueComments: [{ id: 1, body: verdictBody("pre_approval_gate") }],
    }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 1);
    },
  ));
});

test("round source (A): DISTINCT reviewed heads across the review and issue-comment streams count distinctly", async () => {
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      reviews: [{ id: 501, body: verdictBody("pre_approval_gate", HEAD_SHA) }],
      issueComments: [{ id: 1, body: verdictBody("pre_approval_gate", nthHeadSha(1)) }],
    }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 2);
    },
  ));
});

test("round source (A): a PR review merely quoting the verdict header, with no parseable reviewed-head line, does not count", async () => {
  const headerOnlyNoHeadSha = "### Gate review: `pre_approval_gate`\n\nThis PR follows the standard gate-review comment format.";
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      reviews: [{ id: 501, body: headerOnlyNoHeadSha }],
      issueComments: [{ id: 1, body: verdictBody("pre_approval_gate") }],
    }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// Round sources (B) and (C): cross-checks can only push the round UP
// ---------------------------------------------------------------------------

test("round source (B): a gate-header marker's round wins over a lower verdict-surface count", async () => {
  const priorReview = [
    "### Gate review: `pre_approval_gate`",
    `<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=5 -->`,
    "",
    `**Reviewed head SHA:** \`${HEAD_SHA}\``,
  ].join("\n");
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ reviews: [{ id: 600, body: priorReview }], issueComments: [{ id: 1, body: verdictBody("pre_approval_gate") }] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 5);
    },
  ));
});

test("round source (B): the cross-check never mixes gates — a HIGHER round on the OTHER gate's header must never leak in", async () => {
  const draftGateReview = `### Gate review: \`draft_gate\`\n<!-- dev-loops:gate-findings-review draft_gate ${HEAD_SHA} round=9 -->\n\n**Reviewed head SHA:** \`${nthHeadSha(1)}\``;
  const preApprovalReview = `### Gate review: \`pre_approval_gate\`\n<!-- dev-loops:gate-findings-review pre_approval_gate ${HEAD_SHA} round=2 -->\n\n**Reviewed head SHA:** \`${HEAD_SHA}\``;
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      reviews: [{ id: 601, body: draftGateReview }, { id: 602, body: preApprovalReview }],
      issueComments: [],
    }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 2);
    },
  ));
});

test("round source (C): real <gate>-*.json findings-log files under --tmp-root count, ignoring the other gate's and non-.json files", async () => {
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries(),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(path.join(findingsDir, `draft_gate-${HEAD_SHA}.json`), "{}", "utf8");
      await writeFile(path.join(findingsDir, "draft_gate-0000000000000000000000000000000000000000.json"), "{}", "utf8");
      await writeFile(path.join(findingsDir, `pre_approval_gate-${HEAD_SHA}.json`), "{}", "utf8"); // other gate — excluded
      await writeFile(path.join(findingsDir, `draft_gate-${HEAD_SHA}.txt`), "not json", "utf8"); // wrong extension — excluded

      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      // Verdict-surface count is 1; the local fallback (2 real draft_gate-*.json
      // files) pushes the round up to 2.
      assert.equal(result.round, 2);
    },
  ));
});

// ---------------------------------------------------------------------------
// Disposition pass: the round window
// ---------------------------------------------------------------------------

test("buildMeritRationale requires per-finding engagement, not severity-only closure text", () => {
  const body = `${buildFindingMarker({ fp: "aaaaaaaaaaaaaaaa", severity: "low", angle: "correctness", round: 1 })}\n**low** (\`correctness\`): wrong guidance reaches operators`;
  const rationale = buildMeritRationale({ body, judgeReason: "Out of scope for this PR." });
  assert.match(rationale, /^Examined on merits:/);
  assert.match(rationale, /wrong guidance reaches operators/);
  assert.match(rationale, /scope and acceptance criteria/);
  assert.throws(
    () => buildMeritRationale({ body: "<!-- dev-loops:finding aaaaaaaaaaaaaaaa severity=low angle=correctness round=1 -->", judgeReason: "x" }),
    /finding summary/,
  );
});

test("buildMeritRationale states the judge's reason, else its rationale, never a severity or round text", () => {
  const bodyFor = (severity) =>
    `${buildFindingMarker({ fp: "aaaaaaaaaaaaaaaa", severity, angle: "correctness", round: 1 })}\n**${severity}** (\`correctness\`): wrong guidance reaches operators`;
  for (const severity of ["medium", "low", "nit"]) {
    assert.match(buildMeritRationale({ body: bodyFor(severity), judgeReason: "Belongs to the follow-up.", judgeRationale: "ignored" }), /; Belongs to the follow-up\.$/);
    assert.match(buildMeritRationale({ body: bodyFor(severity), judgeRationale: "Only the rationale." }), /; Only the rationale\.$/);
    assert.match(buildMeritRationale({ body: bodyFor(severity) }), /the judge recorded no reason text/);
  }
  assert.doesNotMatch(buildMeritRationale({ body: bodyFor("medium"), judgeReason: "r" }), /fix window|cosmetic|filing bar/);
});

test("buildMeritRationale collapses embedded double quotes so the wrapped summary stays legible (#1882)", () => {
  const body = `${buildFindingMarker({ fp: "aaaaaaaaaaaaaaaa", severity: "low", angle: "correctness", round: 1 })}\n**low** (\`correctness\`): the "foo" bug bites`;
  const rationale = buildMeritRationale({ body, judgeReason: "r" });
  assert.match(rationale, /"the 'foo' bug bites"/);
  assert.doesNotMatch(rationale, /"foo"/);
});

// A judge defer is authorized by ledger evidence only (the rendered suffix ends the untrusted summary line), so a deferred fixture carries a ledger finding and uses its real fingerprint.
function deferEvidence(summary, severity = "high") {
  const finding = { severity, angle: "perf", summary, judgeDisposition: "defer", followUpDraft: { title: "t", body: "b" } };
  return { finding, fp: fingerprintFinding(finding) };
}
const WFN = deferEvidence("stale cache not invalidated");
const VLOW = deferEvidence("wrong guidance a conductor executes");
const GOVREF = deferEvidence("mirror the guard fix for #1951 governing issue");
const MEDCFG = deferEvidence("missing schema validation");
const BAD = deferEvidence("malformed target");
const CASING = deferEvidence("casing nit");
const CASING_B = deferEvidence("casing nit B");
const QUOTE = deferEvidence("the fix must stamp disposition=deferred before resolving");
const STALE = deferEvidence("stale cache");
const STALE_A = deferEvidence("stale cache A");
const STALE_C = deferEvidence("stale cache C");
const SHORT = deferEvidence("short body");
const NPLUS1 = deferEvidence("n+1 query");
const LONG = deferEvidence(`${"x".repeat(220)}`);
const wfnBody = (fp = WFN.fp, round = 1, judgeDisposition = "defer") => `${buildFindingMarker({ fp, severity: "worth-fixing-now", angle: "perf", round })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated${judgeDisposition ? ` — judge: ${judgeDisposition}` : ""}`;

function openWfnThread({ commentId, fp = WFN.fp, id = "THREAD_D", author = AUTHENTICATED_LOGIN, judgeDisposition = "defer" } = {}) {
  return threadNode({ id, isResolved: false, path: "src/cache.mjs", line: 9, commentId, body: wfnBody(fp, 1, judgeDisposition), author });
}

// AC21: no deferral is stamped from severity or round alone. At round 4, past
// the default medium fix window, an unjudged medium stays open and a judge
// `act` medium stays an open act thread; only a judge `defer` is deferred.
for (const judgeDisposition of [null, "act"]) {
  test(`a round-4 medium thread with judgeDisposition ${judgeDisposition ?? "unjudged"} is never deferred`, async () => {
    const thread = openWfnThread({ commentId: 6002, judgeDisposition });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
      roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.round, 4);
        assert.equal(result.deferredResolved, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
      },
    ));
  });
}

test("a judge-defer thread is replied-to + resolved (round 4 here, though the round never decides)", async () => {
  const thread = openWfnThread({ commentId: 6002 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [WFN.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6002, wfnBody()),
      patchReviewCommentEntry(6002),
      postReplyEntry(6002, { id: 7001 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// #1846: an OPERATOR-VISIBLE low (operatorVisible: true on the finding, ov=1
// on the marker) is unchanged from the pre-#1846 low behavior — it still
// files to the round's ONE batched deferral comment.
test("an unresolved OPERATOR-VISIBLE low thread is replied-to + resolved AND filed to the deferral comment", async () => {
  const visibleLowBody = `${buildFindingMarker({ fp: VLOW.fp, severity: "low", angle: "correctness", round: 1, operatorVisible: true })}\n**low** (\`correctness\`): wrong guidance a conductor executes — judge: defer`;
  const thread = threadNode({ id: "THREAD_VISIBLE_LOW", path: "src/x.mjs", line: 4, commentId: 6210, body: visibleLowBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [VLOW.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6210, visibleLowBody),
      patchReviewCommentEntry(6210),
      postReplyEntry(6210, { id: 7110 }),
      resolveThreadEntry("THREAD_VISIBLE_LOW"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// #1882: a fileable target whose SECOND line is malformed (valid marker, so it
// is still selected, but no parseable finding summary) must NOT deadlock the
// batch. buildMeritRationale throws for it, so the disposition pass records it in
// dispositionFailures and skips it BEFORE any GitHub mutation (no follow-up-issue
// append, no marker stamp, no reply) — while the well-formed fileable target in
// the SAME batch is still stamped, replied, and resolved. The malformed target
// stays unresolved (unresolvedGateThreadCount stays non-zero), which keeps the
// gate blocked rather than leaving a stamped-but-unresolved thread that would
// re-throw on every retry. The stub deliberately provides NO get/patch/reply for
// the malformed comment id 9301: a regression that mutates it first would fail.
test("#1882: a malformed fileable target is isolated (no partial stamp) and does not abort the well-formed batch", async () => {
  const okBody = `${buildFindingMarker({ fp: VLOW.fp, severity: "low", angle: "correctness", round: 1, operatorVisible: true })}\n**low** (\`correctness\`): wrong guidance a conductor executes — judge: defer`;
  const badBody = `${buildFindingMarker({ fp: BAD.fp, severity: "low", angle: "correctness", round: 1, operatorVisible: true })}\n**low** · correctness · judge: defer\nthis line carries no parseable finding shape at all`;
  const okThread = threadNode({ id: "THREAD_OK", path: "src/x.mjs", line: 4, commentId: 9300, body: okBody });
  const badThread = threadNode({ id: "THREAD_BAD", path: "src/y.mjs", line: 4, commentId: 9301, body: badBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [VLOW.finding, BAD.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [okThread, badThread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(9300, okBody),
      patchReviewCommentEntry(9300),
      postReplyEntry(9300, { id: 7300 }),
      resolveThreadEntry("THREAD_OK"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1, "the well-formed target still resolves");
      assert.equal(result.unresolvedGateThreadCount, 1, "the malformed target stays unresolved, keeping the gate blocked");
      assert.equal(result.followUpIssueNumber, 9500);
      assert.ok(Array.isArray(result.dispositionFailures), "malformed target is surfaced");
      assert.equal(result.dispositionFailures.length, 1);
      assert.equal(result.dispositionFailures[0].commentId, 9301);
      assert.match(result.dispositionFailures[0].error, /finding summary/);
    },
  ));
});

// #1973: the disposition reply body embeds the finding's own summary
// (buildMeritRationale), so a finding that legitimately cites the PR's own
// governing issue as a bare `#N` trips the comment-id guard when the reply is
// posted. Without --allowed-refs, that bare ref stays fail-closed: the reply is
// refused, the target is recorded in dispositionFailures, and the thread stays
// unresolved (mirroring reply-resolve-review-thread's no-ids rule).
test("#1973: a bare governing-issue ref in a finding summary is fail-closed without --allowed-refs", async () => {
  const govRefBody = `${buildFindingMarker({ fp: GOVREF.fp, severity: "low", angle: "naming", round: 1, operatorVisible: true })}\n**low** (\`naming\`): mirror the guard fix for #1951 governing issue — judge: defer`;
  const thread = threadNode({ id: "THREAD_GOVREF", path: "src/x.mjs", line: 4, commentId: 6270, body: govRefBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [GOVREF.finding] }), (ledgerPath) => withGhStub(
    // No POST/resolve entries: the guard refuses the reply, so the thread stays unresolved.
    [
      ...roundEntries({ threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6270, govRefBody),
      patchReviewCommentEntry(6270),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures.length, 1);
      assert.equal(result.dispositionFailures[0].commentId, 6270);
      assert.match(result.dispositionFailures[0].error, /comment-id-guard refused/);
    },
  ));
});

// #1973: the FILEABLE reply site (operator-visible low -> follow-up issue) also
// threads --allowed-refs. Same governing-issue ref, but now the disposition
// reply that names the follow-up issue also embeds the finding summary's bare
// ref; --allowed-refs must open the guard for the filed path, so the
// unfiled one, so the stamp+file+reply+resolve completes.
test("#1973: --allowed-refs also opens the guard on the fileable (filed-to-follow-up) reply path", async () => {
  const visibleLowBody = `${buildFindingMarker({ fp: GOVREF.fp, severity: "low", angle: "correctness", round: 1, operatorVisible: true })}\n**low** (\`correctness\`): mirror the guard fix for #1951 governing issue — judge: defer`;
  const thread = threadNode({ id: "THREAD_GOVREF_FILE", path: "src/x.mjs", line: 4, commentId: 6290, body: visibleLowBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [GOVREF.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6290, visibleLowBody),
      patchReviewCommentEntry(6290),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6290/replies`, "--input", "-"],
        assertStdinIncludes: ["#1951"],
        stdout: `${JSON.stringify({ id: 7170, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7170` })}\n`,
      },
      resolveThreadEntry("THREAD_GOVREF_FILE"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath, allowedRefs: ["1951"] }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
      assert.equal(result.followUpIssueNumber, 9500);
      assert.equal(result.dispositionFailures, undefined);
    },
  ));
});

// A MIXED round: a judge-deferred medium and a judge-deferred low are filed in
// ONE deferral comment. An unjudged nit and an unjudged low are never deferred:
// they stay open and never reach the comment, whatever their severity.
test("a mixed round files ONLY the judge-deferred subset into ONE deferral comment", async () => {
  const mediumBody = `${buildFindingMarker({ fp: MEDCFG.fp, severity: "medium", angle: "config-drift", round: 1 })}\n**medium** (\`config-drift\`): missing schema validation — judge: defer`;
  const visibleLowBody = `${buildFindingMarker({ fp: VLOW.fp, severity: "low", angle: "correctness", round: 1, operatorVisible: true })}\n**low** (\`correctness\`): wrong guidance a conductor executes — judge: defer`;
  const nitBody = `${buildFindingMarker({ fp: "cccc0000cccc0000", severity: "nit", angle: "naming", round: 1 })}\n**nit** (\`naming\`): casing nit`;
  const invisibleLowBody = `${buildFindingMarker({ fp: "dddd0000dddd0000", severity: "low", angle: "naming", round: 1 })}\n**low** (\`naming\`): unused local variable`;
  const mediumThread = threadNode({ id: "THREAD_MIX_MED", path: "src/config.mjs", line: 4, commentId: 9101, body: mediumBody });
  const visibleLowThread = threadNode({ id: "THREAD_MIX_VLOW", path: "src/x.mjs", line: 4, commentId: 9102, body: visibleLowBody });
  const nitThread = threadNode({ id: "THREAD_MIX_NIT", path: "src/naming.mjs", line: 4, commentId: 9103, body: nitBody });
  const invisibleLowThread = threadNode({ id: "THREAD_MIX_ILOW", path: "src/naming.mjs", line: 9, commentId: 9104, body: invisibleLowBody });

  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [MEDCFG.finding, VLOW.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({
        issueComments: roundHistory("draft_gate", 4),
        threads: [mediumThread, visibleLowThread, nitThread, invisibleLowThread],
      }),
      ...deferralCommentEntries(9500, { contains: [MEDCFG.fp, VLOW.fp], notContains: ["cccc0000cccc0000", "dddd0000dddd0000"] }),
      getReviewCommentEntry(9101, mediumBody),
      patchReviewCommentEntry(9101),
      postReplyEntry(9101, { id: 9201 }),
      resolveThreadEntry("THREAD_MIX_MED"),
      getReviewCommentEntry(9102, visibleLowBody),
      patchReviewCommentEntry(9102),
      postReplyEntry(9102, { id: 9202 }),
      resolveThreadEntry("THREAD_MIX_VLOW"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 2);
      assert.equal(result.unresolvedGateThreadCount, 2);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// #1592: a question thread is NEVER auto-defer-closed — it is answered, never
// deferred — so it must still count as unresolved after the disposition pass
// runs (isDeferredAtRound never selects it as a target).
test("an unresolved question thread is never auto-defer-closed (still blocks gate-close)", async () => {
  const questionBody = `${buildFindingMarker({ fp: "aaaaaaaaaaaaaaaa", severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({ id: "THREAD_QUESTION", path: "src/scope.mjs", line: 4, commentId: 6260, body: questionBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries stubbed: the disposition pass must never call
    // them for a question thread — withGhStub fails the test if an
    // unexpected gh invocation is made.
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// #2381: reject-close for an ANSWERED, judge-REJECTED question thread
// ---------------------------------------------------------------------------

test("an answered, judge-rejected question thread is reject-closed, citing the judge's rationale (tier 1: current ledger)", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "This was already decided in the linked issue; no new information changes that." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({
    id: "THREAD_Q_REJECTED",
    commentId: 6270,
    body: questionBody,
    replies: [{ body: "Here is my answer: see the linked issue's discussion.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6270/replies`, "--input", "-"],
        assertStdinIncludes: ["this question was answered, and the judge rejected the finding", "already decided in the linked issue"],
        stdout: `${JSON.stringify({ id: 7270, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7270` })}\n`,
      },
      resolveThreadEntry("THREAD_Q_REJECTED"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

// #2381: judgeRationale is untrusted free text, same trust boundary as a
// finding's summary/angle (formatDeferredFindingEntry) — a rationale citing a
// bare `#123` must not throw inside replyAndMaybeResolve's own
// guardCommentBodyNoIssuePrIds call (which would otherwise leave the thread
// unresolved and re-deadlock on every rerun). rejectCloseMessage
// neutralizes it (`#123` -> `123`) before sanitizeInline, same as the
// defer-pass reply builders already do.
test("a judge rationale citing a bare #123 is neutralized, not guard-rejected: the thread still reject-closes", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Already discussed and settled in #123; no new information changes that." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({
    id: "THREAD_Q_REJECTED_BARE_REF",
    commentId: 6279,
    body: questionBody,
    replies: [{ body: "Here is my answer.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6279/replies`, "--input", "-"],
        assertStdinIncludes: ["Already discussed and settled in 123"],
        assertStdinNotIncludes: ["#123"],
        stdout: `${JSON.stringify({ id: 7279, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7279` })}\n`,
      },
      resolveThreadEntry("THREAD_Q_REJECTED_BARE_REF"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

test("an UNANSWERED, judge-rejected question thread stays open (no reply/resolve call is made)", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Already decided elsewhere." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  // No `replies` — hasAnswerReply must be false, so the pass never reaches
  // resolveJudgeRejection at all; a reply/resolve stub would overflow.
  const thread = threadNode({ id: "THREAD_Q_UNANSWERED", commentId: 6271, body: questionBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// hasAnswerReply's exclusion branches (ADR 0088): each of these replies is
// NOT a genuine answer, so the reject-close pass must never reach
// resolveJudgeRejection for any of them (a reply/resolve stub in the gh
// queue would overflow if it did) — the thread stays open exactly like the
// fully-unanswered case above. A regression in any one of these exclusions
// would let an UNANSWERED (on the merits) judge-rejected question get
// reject-closed, which ng:0 forbids.
for (const [label, reply] of [
  ["a [bot]-login reply", { body: "Looks fine to me.", author: "some-ci[bot]" }],
  ["a whitespace-only reply body", { body: "   \n\t  ", author: "operator" }],
  ["a reply carrying a finding marker", { body: `${buildFindingMarker({ fp: "f".repeat(16), severity: "low", angle: "naming", round: 1 })}\n**low** (\`naming\`): unrelated finding`, author: "operator" }],
  ["a prior gate automation reply ('Closed at gate close (')", { body: "Closed at gate close (round 1, fingerprint aaaaaaaaaaaaaaaa, severity question, angle scope): already handled.", author: "operator" }],
  ["a reply mixed with a bare @copilot summon", { body: "Answering now: see the design doc. @copilot please re-review.", author: "operator" }],
]) {
  test(`hasAnswerReply exclusion: ${label} does not count as an answer — the thread stays open`, async () => {
    const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Already decided elsewhere." };
    const fp = fingerprintFinding(finding);
    const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
    const thread = threadNode({
      id: "THREAD_Q_EXCLUDED_REPLY",
      commentId: 6273,
      body: questionBody,
      replies: [reply],
    });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
      // No reply/resolve stub: if hasAnswerReply wrongly treats this as an
      // answer, the pass would call a gh entry past the end of this queue
      // and the mock would throw "Unexpected gh call".
      roundEntries({ threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.rejectClosed, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
      },
    ));
  });
}

// The reject-close pass's per-candidate failure path (runRejectClosePass,
// mirrors runDispositionPass's own #1973/#1882 fail-closed handling): when
// the reply POST itself fails (a transient gh/API error, not a guard
// refusal), the candidate is recorded in dispositionFailures with severity
// "question" and the thread stays unresolved — not deadlocking the rest of
// the batch, and merged (combinedDispositionFailures) alongside any
// defer-pass failures from the same round.
test("a reject-close reply POST failure is recorded in dispositionFailures (severity question) and the thread stays open", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Already decided elsewhere." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  const answeredThread = threadNode({
    id: "THREAD_Q_REPLY_FAILS",
    commentId: 6274,
    body: questionBody,
    replies: [{ body: "Answering now: see the design doc.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [answeredThread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6274/replies`, "--input", "-"],
        stdout: "",
        stderr: "HTTP 500",
        exitCode: 1,
      },
      // No resolveThreadEntry: the POST failure must short-circuit before resolve.
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.ok(Array.isArray(result.dispositionFailures), "the failed candidate is surfaced");
      assert.equal(result.dispositionFailures.length, 1);
      assert.equal(result.dispositionFailures[0].commentId, 6274);
      assert.equal(result.dispositionFailures[0].severity, "question");
      assert.match(result.dispositionFailures[0].error, /gh command failed/);
    },
  ));
});

// Models the actual unanswered-to-answered TRANSITION dod:1 asks for: the
// SAME thread/ledger, run through closeGateFindings twice — first with no
// answer reply (stays open, no mutation), then again after an answer reply
// lands (reject-closed). A single-call fixture that starts already-answered
// (the shape most other tests in this file use) cannot show the transition
// itself, only the already-answered end state.
test("answering a previously-unanswered, judge-rejected question lets the pass close it (unanswered -> answered transition)", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Already decided elsewhere." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), async (ledgerPath) => {
    const unansweredThread = threadNode({ id: "THREAD_Q_NOW_ANSWERED", commentId: 6272, body: questionBody });
    await withGhStub(
      roundEntries({ threads: [unansweredThread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const first = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(first.rejectClosed, 0);
        assert.equal(first.unresolvedGateThreadCount, 1);
      },
    );

    const answeredThread = threadNode({
      id: "THREAD_Q_NOW_ANSWERED",
      commentId: 6272,
      body: questionBody,
      replies: [{ body: "Answering now: see the design doc.", author: "operator" }],
    });
    await withGhStub(
      [
        ...roundEntries({ threads: [answeredThread] }),
        postReplyEntry(6272, { id: 7272 }),
        resolveThreadEntry("THREAD_Q_NOW_ANSWERED"),
      ],
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const second = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(second.rejectClosed, 1);
        assert.equal(second.unresolvedGateThreadCount, 0);
      },
    );
  });
});

test("an answered question the judge did NOT reject (act) stays open (the fixer's own answer-and-resolve path owns it)", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "act", judgeRationale: "Worth fixing." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({
    id: "THREAD_Q_ACT",
    commentId: 6273,
    body: questionBody,
    replies: [{ body: "Here is my answer.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries: judgeDisposition "act" must never reject-close.
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// Tier 3: the current ledger carries no matching finding at all (the judge
// rejected this finding several rounds ago and it is suppressed from
// re-appearing — collectSuppressedFingerprints) AND no local prior-round
// ledger file exists (a fresh worktree/clone) — the pass falls back to the
// ` — judge: reject` suffix already rendered on the thread's own posted
// comment, with a generic (non-ledger) rationale in the closing reply.
test("an answered, judge-rejected question with NO ledger match anywhere is still reject-closed via the rendered suffix (tier 3)", async () => {
  const questionBody = `${buildFindingMarker({ fp: "d381d381d381d381", severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach? — judge: reject`;
  const thread = threadNode({
    id: "THREAD_Q_RENDERED",
    commentId: 6274,
    body: questionBody,
    replies: [{ body: "Answered: see the PR description.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6274/replies`, "--input", "-"],
        assertStdinIncludes: ["no rationale text is recorded"],
        stdout: `${JSON.stringify({ id: 7274, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7274` })}\n`,
      },
      resolveThreadEntry("THREAD_Q_RENDERED"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

// Tier 2: absent from the current ledger, but a PRIOR round's local
// findings-log ledger file (same repo/pr/gate) still carries the finding's
// judgeDisposition + judgeRationale — resolveJudgeRejection finds it there
// before ever falling back to the rendered-suffix tier.
test("an answered, judge-rejected question found only in a PRIOR local ledger is reject-closed, citing that ledger's rationale (tier 2)", async () => {
  const finding = { severity: "question", angle: "scope", summary: "why did we pick approach X?", judgeDisposition: "reject", judgeRationale: "Approach X was already justified in the linked issue." };
  const fp = fingerprintFinding(finding);
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why did we pick approach X?`;
  const thread = threadNode({
    id: "THREAD_Q_PRIOR_LEDGER",
    commentId: 6275,
    body: questionBody,
    replies: [{ body: "Answered: approach X is faster.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6275/replies`, "--input", "-"],
        assertStdinIncludes: ["Approach X was already justified in the linked issue"],
        stdout: `${JSON.stringify({ id: 7275, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7275` })}\n`,
      },
      resolveThreadEntry("THREAD_Q_PRIOR_LEDGER"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-08-03T00:00:00.000Z", findings: [finding] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

// ADR 0088 tier ordering: the CURRENT ledger's own finding (tier 1) always
// wins over a PRIOR local ledger for the same fingerprint (tier 2) —
// resolveJudgeRejection never even calls findJudgeDispositionForFingerprint
// when a current match exists, so a stale local ledger can never override
// the round's own judge verdict.
test("tier 1 (current ledger) wins over a disagreeing tier 2 (prior local ledger): current act blocks reject-close", async () => {
  const currentFinding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "act", judgeRationale: "Worth fixing after all." };
  const priorFinding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Stale prior-round rejection." };
  const fp = fingerprintFinding(currentFinding);
  assert.equal(fp, fingerprintFinding(priorFinding)); // same summary → same fingerprint, by construction
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({
    id: "THREAD_Q_TIER1_WINS",
    commentId: 6276,
    body: questionBody,
    replies: [{ body: "Answering now.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [currentFinding] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries: tier 1's "act" must win and skip reject-close.
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-08-03T00:00:00.000Z", findings: [priorFinding] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// #2381: two CURRENT-ledger findings sharing one fingerprint (fingerprintFinding
// hashes only files[0] + the normalized summary — the ledger itself is never
// deduped by fingerprint) with DISAGREEING judge dispositions must STOP tier 1,
// never pick whichever comes first in ledger array order (that would fail open
// on ng:0 and depend on array order). This mirrors tier 2's own `{ ambiguous:
// true }` stop for the identical shape of disagreement. No reply/resolve gh
// call is stubbed, so a regression that reject-closes here overflows the stub
// and fails the test.
test("#2381: two current-ledger findings sharing a fingerprint with disagreeing judge dispositions is ambiguous — tier 1 stops, the thread stays open", async () => {
  const rejectedFinding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Already decided elsewhere." };
  const actedFinding = { severity: "question", angle: "naming", summary: "why this approach?", judgeDisposition: "act", judgeRationale: "Worth fixing after all." };
  const fp = fingerprintFinding(rejectedFinding);
  assert.equal(fp, fingerprintFinding(actedFinding)); // same files[0] (none) + summary → same fingerprint, by construction
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({
    id: "THREAD_Q_TIER1_CONFLICTING_FP",
    commentId: 6279,
    body: questionBody,
    replies: [{ body: "Answering now.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [rejectedFinding, actedFinding] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries: a disagreeing tier 1 must never reject-close.
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// Copilot review (PR 2402): a CURRENT-ledger finding matching this
// fingerprint but carrying a missing/empty judgeDisposition (not yet judged
// this round) is a fail-closed STOP at tier 1, never a tier-1 "cache miss"
// that falls through to a PRIOR round's ledger — even when that prior
// ledger carries a `reject` for the identical fingerprint. Falling through
// here would resolve the thread off stale evidence and violate both tier-1
// precedence and the no-resolution-without-a-recorded-disposition rule
// (ADR 0088). No reply/resolve gh call is stubbed, so a regression that
// reject-closes here overflows the stub and fails the test.
test("#2381: a current-ledger fingerprint match with a missing judgeDisposition fails closed — never falls through to a prior ledger's reject", async () => {
  const undisposedFinding = { severity: "question", angle: "scope", summary: "why this approach?" };
  const priorRejectedFinding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "Stale prior-round rejection." };
  const fp = fingerprintFinding(undisposedFinding);
  assert.equal(fp, fingerprintFinding(priorRejectedFinding)); // same summary → same fingerprint, by construction
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why this approach?`;
  const thread = threadNode({
    id: "THREAD_Q_TIER1_MISSING_DISPOSITION",
    commentId: 6280,
    body: questionBody,
    replies: [{ body: "Answering now.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [undisposedFinding] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries: the missing-disposition current match must
    // stop tier 1 and never reach tier 2's prior-ledger reject.
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-08-03T00:00:00.000Z", findings: [priorRejectedFinding] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// #2381: tier 2's ambiguous result (a tied or undecidable disagreement across
// prior local ledgers) must STOP resolveJudgeRejection, never fall through to
// a stale tier-3 render-time suffix — even when that suffix says reject. Both
// fixtures below carry NO current-ledger finding (tier 1 misses) and a
// rendered " — judge: reject" suffix on the thread's own posted comment
// (tier 3 would otherwise fire); no reply/resolve gh call is stubbed, so a
// regression that reject-closes here overflows the stub and fails the test.
test("#2381: a TIED loggedAt disagreement across prior ledgers is ambiguous — the thread stays open despite a tier-3 reject suffix", async () => {
  const fp = fingerprintFinding({ summary: "why this approach?" });
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why this approach? — judge: reject`;
  const thread = threadNode({
    id: "THREAD_Q_TIER2_TIED_AMBIGUOUS",
    commentId: 6277,
    body: questionBody,
    replies: [{ body: "Answering now.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries: an ambiguous tier 2 must never reject-close.
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "tied A" }] }),
        "utf8",
      );
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(2)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "act", judgeRationale: "tied B" }] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

test("#2381: a MISSING-loggedAt disagreement across prior ledgers is ambiguous — the thread stays open despite a tier-3 reject suffix", async () => {
  const fp = fingerprintFinding({ summary: "why this approach?" });
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why this approach? — judge: reject`;
  const thread = threadNode({
    id: "THREAD_Q_TIER2_MISSING_LOGGEDAT_AMBIGUOUS",
    commentId: 6278,
    body: questionBody,
    replies: [{ body: "Answering now.", author: "operator" }],
  });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No reply/resolve entries: an ambiguous tier 2 must never reject-close.
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        // No `loggedAt` at all: "greatest" is undecidable across the set.
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", findings: [{ severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "no timestamp" }] }),
        "utf8",
      );
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(2)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "act", judgeRationale: "timestamped" }] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// AC row 3 (first half): a body-filed (non-locatable) question never becomes
// a review thread at all (renderNonLocatableBlock/buildNonLocatableFindingMarker
// splice it into the verdict body's own text instead) — it produces no
// unresolved-thread count regardless of judge disposition, deferred by
// construction. countUnresolvedGateAuthoredThreads only ever counts THREADS.
test("a body-filed (non-locatable) question produces no blocking count regardless of judge disposition", async () => {
  const bodyFiledFinding = { severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "reject", judgeRationale: "n/a" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [bodyFiledFinding] }), (ledgerPath) => withGhStub(
    // No thread exists for it (body-filed) — an empty thread list.
    roundEntries({ threads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

// A pre-rename thread stamped severity=defer normalizes on read: the posted
// reply names the canonical tier, never the retired spelling. No ov=1 field
// on this hand-authored legacy marker, and the judge deferred its cluster.
test("a legacy severity=defer marker posts a reply in the canonical vocabulary", async () => {
  const legacyBody = `<!-- dev-loops:finding ${CASING.fp} severity=defer angle=naming round=1 -->\n**defer** (\`naming\`): casing nit — judge: defer`;
  const thread = threadNode({ id: "THREAD_LEGACY", path: "src/naming.mjs", line: 4, commentId: 6300, body: legacyBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [CASING.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6300, legacyBody),
      patchReviewCommentEntry(6300),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6300/replies`, "--input", "-"],
        assertStdinIncludes: ["severity low"],
        assertStdinNotIncludes: ["severity defer,", "defer-severity"],
        stdout: `${JSON.stringify({ id: 7200, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7200` })}\n`,
      },
      resolveThreadEntry("THREAD_LEGACY"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// Gate-authored is decided by AUTHOR IDENTITY (the authenticated `gh` viewer's
// login), never by rendered marker text alone.
test("marker provenance: a FOREIGN-authored thread past the fix window, carrying a valid finding marker, is never selected for disposition", async () => {
  const foreign = openWfnThread({ commentId: 6900, fp: "abcdefabcdefabcd", id: "THREAD_FOREIGN", author: "someone-else" });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No GET/PATCH/reply/resolve entries: a regression that mutates this
    // foreign-authored thread would overflow the stub and fail the run.
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [foreign] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// stampDeferredDisposition trims the REST payload body the same way
// parseReviewThreads' normalizeBody trims thread.body — a leading-whitespace
// padded body must still parse and get PATCHed, not silently skip the stamp
// while reply+resolve proceeds unstamped.
test("a deferral target whose REST-fetched body has LEADING WHITESPACE before the marker is still stamped", async () => {
  const thread = openWfnThread({ commentId: 6600, id: "THREAD_WS" });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [WFN.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6600, ` ${wfnBody()}`),
      patchReviewCommentEntry(6600),
      postReplyEntry(6600, { id: 7600 }),
      resolveThreadEntry("THREAD_WS"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).deferredResolved, 1);
    },
  ));
});

// The already-stamped guard parses the marker's OWN disposition field, never a
// free-text search: a finding quoting the literal token must still be stamped.
test("a finding whose own text quotes the literal 'disposition=deferred' token still gets stamped and resolved", async () => {
  const body = `${buildFindingMarker({ fp: QUOTE.fp, severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): the fix must stamp disposition=deferred before resolving — judge: defer`;
  const thread = threadNode({ id: "THREAD_D", path: "src/cache.mjs", line: 9, commentId: 6500, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [QUOTE.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6500, body),
      patchReviewCommentEntry(6500),
      postReplyEntry(6500, { id: 7500 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).deferredResolved, 1);
    },
  ));
});

test("stampDeferredDisposition skips the PATCH when the marker's OWN disposition field is already deferred", async () => {
  // Already carries its deferral target link: a legitimately-stamped,
  // still-unresolved marker (e.g. an interrupted retry) always does.
  const alreadyStamped = `${buildFindingMarker({ fp: STALE.fp, severity: "worth-fixing-now", angle: "perf", round: 1, disposition: "deferred", issue: 9500 })}\n**worth-fixing-now** (\`perf\`): stale cache — judge: defer`;
  const thread = threadNode({ id: "THREAD_D", path: "src/cache.mjs", line: 9, commentId: 6501, body: alreadyStamped });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [STALE.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      // The target already lists this fingerprint, so no comment is posted.
      prViewEntry([9500]),
      targetCommentsEntry(9500, [{ body: "<!-- dev-loops:deferred-summary -->\n- `" + STALE.fp + "` **medium** (`perf`): stale cache" }]),
      getReviewCommentEntry(6501, alreadyStamped),
      // No patchReviewCommentEntry: a PATCH here would overflow the stub and
      // fail the test — the already-stamped guard must skip straight to
      // reply+resolve.
      postReplyEntry(6501, { id: 7501 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// ADR 0092 Consequences: a legacy stamp (issue=<old follow-up issue>) whose
// target now resolves elsewhere fails closed: isolated into
// dispositionFailures, no PATCH, reply or resolve, the thread stays unresolved.
test("stampDeferredDisposition fails closed when an already-stamped issue= differs from the resolved target", async () => {
  const legacyStamped = `${buildFindingMarker({ fp: STALE.fp, severity: "worth-fixing-now", angle: "perf", round: 1, disposition: "deferred", issue: 9500 })}\n**worth-fixing-now** (\`perf\`): stale cache — judge: defer`;
  const thread = threadNode({ id: "THREAD_LEGACY", path: "src/cache.mjs", line: 9, commentId: 6502, body: legacyStamped });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [STALE.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      // No closing reference: the target resolves to the PR, not 9500.
      prViewEntry([]),
      getReviewCommentEntry(6502, legacyStamped),
      // No PATCH, reply or resolve entries: any of them overflows the stub.
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures.length, 1);
      assert.equal(result.dispositionFailures[0].commentId, 6502);
      assert.match(result.dispositionFailures[0].error, /refuse to overwrite the existing link/);
    },
  ));
});

// Idempotency: a re-run whose every fileable fingerprint the target already
// lists posts NO comment (and never creates an issue); it only finishes the
// reply+resolve.
test("a disposition pass whose every fingerprint the target already lists posts no comment (pure retry)", async () => {
  const first = `${buildFindingMarker({ fp: STALE_A.fp, severity: "worth-fixing-now", angle: "perf", round: 1, disposition: "deferred", issue: 9500 })}\n**worth-fixing-now** (\`perf\`): stale cache A — judge: defer`;
  // #1846: a stamped low must carry operatorVisible: true to be a legitimate
  // (fileable) already-stamped target — a plain low stamp would now itself be
  // the contract violation detectContractViolatingDeferredStamps rejects.
  const second = `${buildFindingMarker({ fp: CASING_B.fp, severity: "nice-to-have", angle: "naming", round: 1, operatorVisible: true, disposition: "deferred", issue: 9500 })}\n**nice-to-have** (\`naming\`): casing nit B — judge: defer`;
  const threadA = threadNode({ id: "THREAD_A", path: "src/cache.mjs", line: 9, commentId: 6801, body: first });
  const threadB = threadNode({ id: "THREAD_B", path: "src/naming.mjs", line: 4, commentId: 6802, body: second });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [STALE_A.finding, CASING_B.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [threadA, threadB] }),
      prViewEntry([9500]),
      targetCommentsEntry(9500, [{ body: "<!-- dev-loops:deferred-summary -->\nGate findings deferred:\n\n- `" + STALE_A.fp + "` **medium** (`perf`): A\n- `" + CASING_B.fp + "` **low** (`naming`): B" }]),
      getReviewCommentEntry(6801, first),
      postReplyEntry(6801, { id: 7801 }),
      resolveThreadEntry("THREAD_A"),
      getReviewCommentEntry(6802, second),
      postReplyEntry(6802, { id: 7802 }),
      resolveThreadEntry("THREAD_B"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 2);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// Idempotency: a MIXED batch — one fingerprint already listed on the target
// (a carried-over retry), one not — posts ONE comment carrying only the
// not-yet-listed entry.
test("a mixed disposition pass comments once, for only the not-yet-listed fingerprint", async () => {
  const stamped = `${buildFindingMarker({ fp: STALE_C.fp, severity: "worth-fixing-now", angle: "perf", round: 1, disposition: "deferred", issue: 9500 })}\n**worth-fixing-now** (\`perf\`): stale cache C — judge: defer`;
  const unstamped = wfnBody(WFN.fp);
  const threadStamped = threadNode({ id: "THREAD_STAMPED", path: "src/cache.mjs", line: 9, commentId: 6901, body: stamped });
  const threadUnstamped = threadNode({ id: "THREAD_UNSTAMPED", path: "src/cache.mjs", line: 11, commentId: 6902, body: unstamped });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [STALE_C.finding, WFN.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [threadStamped, threadUnstamped] }),
      ...deferralCommentEntries(9500, {
        listed: [{ body: "<!-- dev-loops:deferred-summary -->\n- `" + STALE_C.fp + "` **medium** (`perf`): stale cache C" }],
        contains: [WFN.fp],
        notContains: [STALE_C.fp],
      }),
      getReviewCommentEntry(6901, stamped),
      postReplyEntry(6901, { id: 7901 }),
      resolveThreadEntry("THREAD_STAMPED"),
      getReviewCommentEntry(6902, unstamped),
      patchReviewCommentEntry(6902),
      { ...postReplyEntry(6902, { id: 7902 }), assertStdinIncludes: ["recorded in the deferral comment on", "/issues/9500"] },
      resolveThreadEntry("THREAD_UNSTAMPED"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 2);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// Comment target fallback: with no closing reference, or more than one, the PR itself is the
// target: no deferral comment is posted and the stamp records the PR number.
for (const [label, closing] of [["no closing reference", []], ["more than one closing reference", [9500, 9501]]]) {
  test(`deferral comment target: ${label} — posts no comment, followUpIssueNumber is the PR number`, async () => {
    const thread = openWfnThread({ commentId: 6700, id: "THREAD_PR_TARGET" });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [WFN.finding] }), (ledgerPath) => withGhStub(
      [
        ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
        prViewEntry(closing),
        getReviewCommentEntry(6700, wfnBody()),
        { ...patchReviewCommentEntry(6700), assertArgContains: [`disposition=deferred issue=${PR}`] },
        { ...postReplyEntry(6700, { id: 7700 }), assertStdinIncludes: ["recorded in this thread's marker", `issue=${PR}`] },
        resolveThreadEntry("THREAD_PR_TARGET"),
      ],
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.deferredResolved, 1);
        assert.equal(result.followUpIssueNumber, PR);
      },
    ));
  });
}

// A tracker other than GitHub: the PR is the target and no comment is posted,
// with no closing reference lookup at all (a prViewEntry here would be the next stub entry and
// its args would not match the comments read, failing the run).
test("deferral comment target: tracker.provider other than github — no comment, no closing-reference lookup", async () => {
  const thread = openWfnThread({ commentId: 6710, id: "THREAD_NON_GITHUB" });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [WFN.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      getReviewCommentEntry(6710, wfnBody()),
      patchReviewCommentEntry(6710),
      postReplyEntry(6710, { id: 7710 }),
      resolveThreadEntry("THREAD_NON_GITHUB"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await writeFile(path.join(repoRoot, ".devloops.json"), JSON.stringify({ version: 1, tracker: { provider: "jira" } }), "utf8");
      // The config must load cleanly: an invalid config also falls back to the PR,
      // which would make this test pass for the wrong reason.
      const { config, errors } = await loadDevLoopConfig({ repoRoot });
      assert.deepEqual(errors, []);
      assert.equal(resolveTrackerProvider(config), "jira");
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.followUpIssueNumber, PR);
    },
  ));
});

// ADR 0089: a thread whose finding the current ledger disposes judge `act` is
// never selected, whatever its severity and round. A medium past the fix
// window and a low, both act-disposed, get no stamp, no reply, no resolve and
// no deferral comment: any such call would overflow the sequential stub.
function actExclusionFixtures(mediumDisposition, lowDisposition) {
  const mediumFinding = { severity: "medium", angle: "perf", summary: "stale cache not invalidated", files: ["src/cache.mjs"], judgeDisposition: mediumDisposition };
  const lowFinding = { severity: "low", angle: "naming", summary: "unused local variable", files: ["src/naming.mjs"], judgeDisposition: lowDisposition };
  const mediumFp = fingerprintFinding(mediumFinding);
  const lowFp = fingerprintFinding(lowFinding);
  const mediumBody = `${buildFindingMarker({ fp: mediumFp, severity: "medium", angle: "perf", round: 1 })}\n**medium** (\`perf\`): stale cache not invalidated`;
  const lowBody = `${buildFindingMarker({ fp: lowFp, severity: "low", angle: "naming", round: 1 })}\n**low** (\`naming\`): unused local variable`;
  return {
    findings: [mediumFinding, lowFinding],
    mediumFp,
    mediumBody,
    lowFp,
    lowBody,
    threads: [
      threadNode({ id: "THREAD_ACT_MED", path: "src/cache.mjs", line: 9, commentId: 6601, body: mediumBody }),
      threadNode({ id: "THREAD_ACT_LOW", path: "src/naming.mjs", line: 4, commentId: 6602, body: lowBody }),
    ],
  };
}

test("an act-disposed medium past the fix window and an act-disposed low are NOT selected (no stamp, reply, resolve, or comment)", async () => {
  const { findings, threads } = actExclusionFixtures("act", "act");
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 2, "both act threads stay open for the fixer");
      assert.equal(result.followUpIssueNumber, undefined);
    },
  ));
});

// Fingerprints are not unique per ledger: two angles can share one. When the
// current ledger's matches disagree (here a missing disposition plus defer),
// the result is ambiguous and the thread stays open (fail closed).
test("a round-4 medium thread whose duplicate-fingerprint current-ledger entries disagree (missing + defer) is NOT selected", async () => {
  const { findings, threads } = actExclusionFixtures(undefined, "act");
  const duplicate = { ...findings[0], angle: "correctness", judgeDisposition: "defer" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [...findings, duplicate] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 2);
    },
  ));
});

// An act thread from an earlier round is suppressed from later ledgers, so the
// current ledger has no match: the rendered ` — judge: act` suffix keeps it open.
test("a round-4 medium thread with an empty current ledger and a rendered 'judge: act' suffix is NOT selected", async () => {
  const body = `${buildFindingMarker({ fp: "a0a0a0a0a0a0a0a0", severity: "medium", angle: "perf", round: 1 })}\n**medium** (\`perf\`): stale cache not invalidated — judge: act`;
  const thread = threadNode({ id: "THREAD_PRIOR_ACT", path: "src/cache.mjs", line: 9, commentId: 6603, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// Tier 2 of resolveThreadDisposition: with an empty current ledger and NO rendered
// judge suffix, the prior local ledgers decide. A prior `act` keeps the thread
// open; a tied act-vs-defer disagreement is ambiguous and also keeps it open
// (fail closed). No stamp/reply/resolve/comment entry is stubbed, so selecting
// the thread overflows the sequential stub.
for (const [label, priorDispositions] of [
  ["a prior ledger disposing it act", ["act"]],
  ["a TIED act-vs-defer prior-ledger disagreement (ambiguous)", ["act", "defer"]],
]) {
  test(`a round-4 medium thread with an empty current ledger, no judge suffix and ${label} is NOT selected`, async () => {
    const finding = { severity: "medium", angle: "perf", summary: "stale cache not invalidated" };
    const fp = fingerprintFinding(finding);
    const body = `${buildFindingMarker({ fp, severity: "medium", angle: "perf", round: 1 })}\n**medium** (\`perf\`): stale cache not invalidated — judge: defer`;
    const thread = threadNode({ id: "THREAD_PRIOR_LEDGER_ACT", path: "src/cache.mjs", line: 9, commentId: 6604, body });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
      roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
        await mkdir(findingsDir, { recursive: true });
        for (const [i, judgeDisposition] of priorDispositions.entries()) {
          await writeFile(
            path.join(findingsDir, `draft_gate-${nthHeadSha(i + 1)}.json`),
            JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ ...finding, judgeDisposition, judgeRationale: `prior ${judgeDisposition}` }] }),
            "utf8",
          );
        }
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.round, 4);
        assert.equal(result.deferredResolved, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
        assert.equal(result.followUpIssueNumber, undefined);
      },
    ));
  });
}

// A judge-rejected medium or low is reject-closed instead (ADR 0144).
for (const [mediumDisposition, lowDisposition] of [["defer", "defer"]]) {
  test(`the same threads with a ${mediumDisposition} medium and a ${lowDisposition} low ARE still selected`, async () => {
    const { findings, threads, mediumFp, mediumBody, lowFp, lowBody } = actExclusionFixtures(mediumDisposition, lowDisposition);
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings }), (ledgerPath) => withGhStub(
      [
        ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads }),
        ...deferralCommentEntries(9500, { contains: [mediumFp, lowFp] }),
        getReviewCommentEntry(6601, mediumBody),
        patchReviewCommentEntry(6601),
        postReplyEntry(6601, { id: 7601 }),
        resolveThreadEntry("THREAD_ACT_MED"),
        getReviewCommentEntry(6602, lowBody),
        patchReviewCommentEntry(6602),
        postReplyEntry(6602, { id: 7602 }),
        resolveThreadEntry("THREAD_ACT_LOW"),
      ],
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.deferredResolved, 2);
        assert.equal(result.unresolvedGateThreadCount, 0);
        assert.equal(result.followUpIssueNumber, 9500);
      },
    ));
  });
}

// ---------------------------------------------------------------------------
// #1672: GATE-EXEC-THREAD-DISPOSITION enforcement — guard against a subagent
// manually stamping disposition=deferred on a question or in-window medium
// thread (bypassing selectDispositionTargets / stampDeferredDisposition).
// ---------------------------------------------------------------------------

// (a) round-1 medium NOT defer-closed (default window=3): the disposition pass
// must leave an in-window medium thread unresolved (it forces a fix round).
test("#1672 (a): a round-1 unjudged medium thread is NOT defer-closed (stays unresolved, forces a fix round)", async () => {
  const mediumBody = `${buildFindingMarker({ fp: "aaaaaaaaaaaaaaaa", severity: "medium", angle: "config-drift", round: 1 })}\n**medium** (\`config-drift\`): missing schema validation`;
  const thread = threadNode({ id: "THREAD_MED_R1", path: "src/config.mjs", line: 4, commentId: 9001, body: mediumBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No GET/PATCH/reply/resolve entries: a regression that defer-closed this
    // in-window medium thread would overflow the stub and fail the run.
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// (b) question NOT defer-closed: the disposition pass must leave a question
// thread unresolved (it must be answered, never deferred).
test("#1672 (b): a question thread is NOT defer-closed (stays unresolved, must be answered)", async () => {
  const questionBody = `${buildFindingMarker({ fp: "bbbbbbbbbbbbbbbb", severity: "question", angle: "correctness", round: 1 })}\n**question** (\`correctness\`): why is overallVerdict not cross-checked against verdict?`;
  const thread = threadNode({ id: "THREAD_Q_R1", path: "src/verdict.mjs", line: 4, commentId: 9002, body: questionBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No disposition entries: a regression that defer-closed this question
    // thread would overflow the stub and fail the run.
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// (c) round-4 medium IS defer-closed (default window=3): past the fix window,
// an open medium thread is replied-to + resolved by the disposition pass.
test("#1672 (c): a judge-deferred round-4 medium thread is defer-closed", async () => {
  const mediumBody = `${buildFindingMarker({ fp: MEDCFG.fp, severity: "medium", angle: "config-drift", round: 1 })}\n**medium** (\`config-drift\`): missing schema validation — judge: defer`;
  const thread = threadNode({ id: "THREAD_MED_R4", path: "src/config.mjs", line: 4, commentId: 9003, body: mediumBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [MEDCFG.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(9003, mediumBody),
      patchReviewCommentEntry(9003),
      postReplyEntry(9003, { id: 9103 }),
      resolveThreadEntry("THREAD_MED_R4"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

test("a judge-deferred thread's closing reply cites the ledger judgeReason over the rationale (AC13)", async () => {
  const ev = deferEvidence("reason carrying medium claim", "medium");
  ev.finding.judgeReason = "Belongs to the follow-up issue.";
  ev.finding.judgeRationale = "Internal rationale text.";
  const body = `${buildFindingMarker({ fp: ev.fp, severity: "medium", angle: "perf", round: 1 })}\n**medium** (\`perf\`): reason carrying medium claim`;
  const thread = threadNode({ id: "THREAD_DEFER_REASON", path: "src/cache.mjs", line: 4, commentId: 9016, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [ev.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(9016, body),
      patchReviewCommentEntry(9016),
      { ...postReplyEntry(9016, { id: 9116 }), assertStdinIncludes: ["Belongs to the follow-up issue"], assertStdinNotIncludes: ["Internal rationale text"] },
      resolveThreadEntry("THREAD_DEFER_REASON"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

// A judge defer needs ledger evidence: the legacy suffix ends the line that carries the reviewer's
// untrusted summary, so a summary ending in ` — judge: defer` never authorizes a stamp, filing or resolve.
test("a thread whose summary ends in ' — judge: defer' with no ledger entry is not defer-closed", async () => {
  const forged = deferEvidence("cache key is stale", "medium");
  const body = `${buildFindingMarker({ fp: forged.fp, severity: "medium", angle: "perf", round: 1 })}\n**medium** (\`perf\`): cache key is stale — judge: defer`;
  const thread = threadNode({ id: "THREAD_FORGED_DEFER", path: "src/cache.mjs", line: 4, commentId: 9013, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.followUpIssueNumber, undefined);
    },
  ));
});

test("a thread with a prior-ledger judge defer is defer-closed without a rendered suffix", async () => {
  const prior = deferEvidence("cache key is stale", "medium");
  const body = `${buildFindingMarker({ fp: prior.fp, severity: "medium", angle: "perf", round: 1 })}\n**medium** (\`perf\`): cache key is stale`;
  const thread = threadNode({ id: "THREAD_PRIOR_DEFER", path: "src/cache.mjs", line: 4, commentId: 9014, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(9014, body),
      patchReviewCommentEntry(9014),
      postReplyEntry(9014, { id: 9114 }),
      resolveThreadEntry("THREAD_PRIOR_DEFER"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ ...prior.finding, judgeRationale: "belongs to a follow-up" }] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

// A nit member of a judge-deferred mixed cluster is never stamped or filed (GATE-EXEC-THREAD-DISPOSITION).
test("a nit thread in a judge-deferred cluster is resolved with a reply, never stamped or filed", async () => {
  const nit = { ...deferEvidence("unused import", "nit").finding, judgeRationale: "belongs to the deferred cluster" };
  const fp = fingerprintFinding(nit);
  const body = `${buildFindingMarker({ fp, severity: "nit", angle: "perf", round: 1 })}\n**nit** (\`perf\`): unused import`;
  const thread = threadNode({ id: "THREAD_MIXED_NIT", path: "src/cache.mjs", line: 4, commentId: 9015, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [nit] }), (ledgerPath) => withGhStub(
    // No comment, GET or PATCH entries: a stamp or a filing would overflow the stub.
    [
      ...roundEntries({ threads: [thread] }),
      { ...postReplyEntry(9015, { id: 9115 }), assertStdinIncludes: ["A nit is never deferred or filed"] },
      resolveThreadEntry("THREAD_MIXED_NIT"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
      assert.equal(result.foldedFiled, 0);
      assert.equal(result.followUpIssueNumber, undefined);
    },
  ));
});

// (d) high never defer-closed: even past the fix window, a high thread stays
// unresolved (it forces per-gate continuation until the round cap escalates).
test("#1672 (d): a high thread is never defer-closed (even past the fix window)", async () => {
  const highBody = `${buildFindingMarker({ fp: "dddddddddddddddd", severity: "high", angle: "security", round: 1 })}\n**high** (\`security\`): SQL injection`;
  const thread = threadNode({ id: "THREAD_HIGH", path: "src/db.mjs", line: 2, commentId: 9004, body: highBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No disposition entries: a regression that defer-closed this high thread
    // would overflow the stub and fail the run.
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// #1672 guard: a contract-violating disposition=deferred stamp on a QUESTION
// thread (manually stamped by a subagent bypassing selectDispositionTargets)
// is detected and rejected BEFORE the disposition pass proceeds.
test("#1672 guard: a disposition=deferred stamp on a question thread is rejected (throws, does not silently skip)", async () => {
  const stampedQuestion = `${buildFindingMarker({ fp: "eeeeeeeeeeeeeeee", severity: "question", angle: "correctness", round: 2, disposition: "deferred" })}\n**question** (\`correctness\`): why is overallVerdict not cross-checked?`;
  const thread = threadNode({ id: "THREAD_Q_STAMPED", path: "src/verdict.mjs", line: 4, commentId: 9005, body: stampedQuestion });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No GET/PATCH/reply/resolve entries: the scan runs before any of those,
    // and a regression that proceeded to stamp/resolve would overflow the stub.
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /GATE-EXEC-THREAD-DISPOSITION violation.*severity=question.*reason=not-judge-deferred/s,
      );
    },
  ));
});

// #1672 guard: a contract-violating disposition=deferred stamp on an IN-WINDOW
// medium thread (round 1, default window 3 — manually stamped by a subagent)
// is detected and rejected BEFORE the disposition pass proceeds.
test("#1672 guard: a disposition=deferred stamp the judge did not dispose defer is rejected (throws, does not silently skip)", async () => {
  const mediumFinding = { severity: "medium", angle: "config-drift", summary: "missing schema validation", judgeDisposition: "reject" };
  const stampedMedium = `${buildFindingMarker({ fp: fingerprintFinding(mediumFinding), severity: "medium", angle: "config-drift", round: 1, disposition: "deferred", issue: 42 })}\n**medium** (\`config-drift\`): missing schema validation`;
  const thread = threadNode({ id: "THREAD_MED_STAMPED", path: "src/config.mjs", line: 4, commentId: 9006, body: stampedMedium });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [mediumFinding] }),(ledgerPath) => withGhStub(
    // No GET/PATCH/reply/resolve entries: the scan runs before any of those.
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /GATE-EXEC-THREAD-DISPOSITION violation.*severity=medium.*reason=not-judge-deferred/s,
      );
    },
  ));
});

// A current ledger that holds the fingerprint with disagreeing or missing dispositions never supports a deferred stamp.
test("a disposition=deferred stamp is rejected when the current ledger holds the fingerprint as act plus defer or unjudged", async () => {
  const base = { severity: "medium", angle: "config-drift", summary: "missing schema validation" };
  const stampedMedium = `${buildFindingMarker({ fp: fingerprintFinding(base), severity: "medium", angle: "config-drift", round: 1, disposition: "deferred", issue: 42 })}\n**medium** (\`config-drift\`): missing schema validation`;
  for (const findings of [
    [{ ...base, judgeDisposition: "act" }, { ...base, angle: "correctness", judgeDisposition: "defer" }],
    [{ ...base }],
  ]) {
    const thread = threadNode({ id: "THREAD_MED_AMBIG", path: "src/config.mjs", line: 4, commentId: 9006, body: stampedMedium });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings }), (ledgerPath) => withGhStub(
      roundEntries({ threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        await assert.rejects(
          () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
          /GATE-EXEC-THREAD-DISPOSITION violation.*severity=medium.*reason=not-judge-deferred/s,
        );
      },
    ));
  }
});

// #1807 AC6: GATE-EXEC-THREAD-DISPOSITION also refuses a disposition=deferred
// stamp that carries no linked follow-up issue number — an in-window
// deferral is otherwise legitimate (a nit at round 1), so only the missing
// issue link trips this guard.
// #1846: a nit is now NEVER fileable (any round), so a nit stamped
// disposition=deferred with no issue link would trip "out-of-window"
// (not-fileable) first, not "missing-issue-link" — that reason needs a
// genuinely FILEABLE severity/context (an operator-visible low) to isolate.
test("#1807 guard: a disposition=deferred stamp with no linked follow-up issue number is rejected (throws, does not silently skip)", async () => {
  const stampedNoIssue = `${buildFindingMarker({ fp: CASING.fp, severity: "low", angle: "naming", round: 1, operatorVisible: true, disposition: "deferred" })}\n**low** (\`naming\`): casing nit — judge: defer`;
  const thread = threadNode({ id: "THREAD_LOW_NO_ISSUE", path: "src/naming.mjs", line: 4, commentId: 9007, body: stampedNoIssue });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [CASING.finding] }), (ledgerPath) => withGhStub(
    // No issue-create/GET/PATCH/reply/resolve entries: the scan runs before
    // any of those, and a regression that proceeded would overflow the stub.
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /GATE-EXEC-THREAD-DISPOSITION violation.*severity=low.*reason=missing-issue-link/s,
      );
    },
  ));
});

// #1846: a nit stamped disposition=deferred is ALWAYS a contract violation
// ("out-of-window"/not-fileable), regardless of whether it also links an
// issue — a nit is never fileable at any round.
test("#1846 guard: a deferred stamp on a nit thread the judge did not dispose defer is rejected (not-judge-deferred)", async () => {
  const stampedNit = `${buildFindingMarker({ fp: "0202020202020202", severity: "nit", angle: "naming", round: 1, disposition: "deferred", issue: 42 })}\n**nit** (\`naming\`): casing nit`;
  const thread = threadNode({ id: "THREAD_NIT_STAMPED", path: "src/naming.mjs", line: 4, commentId: 9008, body: stampedNit });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        // #1853 hygiene: the error message itself names the nit rejection
        // case (diagnosable without cross-referencing the code), in addition
        // to the per-thread detail already asserted.
        /GATE-EXEC-THREAD-DISPOSITION violation.*severity=nit.*reason=not-judge-deferred/s,
      );
    },
  ));
});

test("severity floor: a deferred stamp on a nit is refused even when the ledger carries a judge defer", async () => {
  const nit = deferEvidence("floor nit", "nit");
  const stamped = `${buildFindingMarker({ fp: nit.fp, severity: "nit", angle: "perf", round: 1, disposition: "deferred", issue: 42 })}\n**nit** (\`perf\`): floor nit`;
  const thread = threadNode({ id: "THREAD_NIT_FLOOR", path: "src/floor.mjs", line: 4, commentId: 9009, body: stamped });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [nit.finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /GATE-EXEC-THREAD-DISPOSITION violation.*severity=nit.*reason=not-judge-deferred/s,
      );
    },
  ));
});

// #1846 guard: a disposition=deferred stamp on a low with NO operatorVisible
// signal (or ov absent/false) on its own marker is rejected the same way — a
// subagent that manually stamped a non-visible low bypassing
// selectDispositionTargets/isFileableDeferral.
test("#1846 guard: a deferred stamp on a low thread the judge did not dispose defer is rejected (not-judge-deferred)", async () => {
  const lowFinding = { severity: "low", angle: "naming", summary: "casing nit", judgeDisposition: "reject" };
  const stampedLow = `${buildFindingMarker({ fp: fingerprintFinding(lowFinding), severity: "low", angle: "naming", round: 1, disposition: "deferred", issue: 42 })}\n**low** (\`naming\`): casing nit`;
  const thread = threadNode({ id: "THREAD_LOW_STAMPED", path: "src/naming.mjs", line: 4, commentId: 9009, body: stampedLow });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [lowFinding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        // #1853 hygiene: the error message names the low/operatorVisible
        // rejection case explicitly, in addition to the per-thread detail.
        /GATE-EXEC-THREAD-DISPOSITION violation.*severity=low.*reason=not-judge-deferred/s,
      );
    },
  ));
});

// A deferred stamp with no ledger evidence at all (tmp wiped, other host) is not a violation.
test("a deferred stamp with an issue link and an empty ledger directory does not abort the rerun", async () => {
  const lowFinding = { severity: "low", angle: "naming", summary: "casing nit" };
  const stampedLow = `${buildFindingMarker({ fp: fingerprintFinding(lowFinding), severity: "low", angle: "naming", round: 1, disposition: "deferred", issue: 42 })}\n**low** (\`naming\`): casing nit`;
  const thread = threadNode({ id: "THREAD_LOW_NO_EVIDENCE", path: "src/naming.mjs", line: 4, commentId: 9010, body: stampedLow });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.ok, true);
    },
  ));
});

// commentId is validated BEFORE it is ever interpolated into a
// `pulls/comments/{commentId}` API path.
test("a gate-authored thread selected for deferral with no resolvable comment id fails closed, named by threadId", async () => {
  const shortBody = `${buildFindingMarker({ fp: SHORT.fp, severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): short body — judge: defer`;
  const thread = threadNode({ id: "THREAD_NO_COMMENT_ID", path: "src/naming.mjs", line: 3, commentId: null, body: shortBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [SHORT.finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /THREAD_NO_COMMENT_ID carries a gate-authored finding marker.*no resolvable comment id/s,
      );
    },
  ));
});

// ---------------------------------------------------------------------------
// fetchThreadsWithFullBodies: the two independent GraphQL walks must join
// ---------------------------------------------------------------------------

test("fetchThreadsWithFullBodies fails closed when the full-body join misses a thread whose listing excerpt was truncated", async () => {
  const thread = threadNode({ id: "THREAD_MISS", path: "src/cache.mjs", line: 9, commentId: 7000, body: "x".repeat(220) });
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread], fullBodyThreads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /Could not resolve the full body/,
      );
    },
  ));
});

test("fetchThreadsWithFullBodies fails closed for a truncated thread that carries no comment id to join against", async () => {
  const thread = threadNode({ id: "THREAD_NO_ID", path: "src/cache.mjs", line: 9, commentId: null, body: "y".repeat(220) });
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread], fullBodyThreads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot }),
        /Could not resolve the full body for review thread THREAD_NO_ID/,
      );
    },
  ));
});

test("a join miss on a SHORT body (never truncated) does not fail closed — the run completes on the listing body", async () => {
  // must-fix is never a disposition target, so the run exercises exactly the
  // truncation guard: a short body that missed the full-body join is already
  // complete and must NOT abort the round.
  const shortBody = `${buildFindingMarker({ fp: "2222222222222222", severity: "must-fix", angle: "security", round: 1 })}\n**must-fix** (\`security\`): short body`;
  const thread = threadNode({ id: "THREAD_SHORT", path: "src/naming.mjs", line: 3, commentId: 7100, body: shortBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread], fullBodyThreads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).deferredResolved, 0);
    },
  ));
});

test("a join miss on a SHORT body that legitimately ends with its own ellipsis character does not fail closed", async () => {
  const body = `${buildFindingMarker({ fp: "3333333333333333", severity: "must-fix", angle: "security", round: 1 })}\n**must-fix** (\`security\`): trailing thought…`;
  const thread = threadNode({ id: "THREAD_ELLIPSIS", path: "src/naming.mjs", line: 3, commentId: 7101, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread], fullBodyThreads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).deferredResolved, 0);
    },
  ));
});

// A finding summary longer than list-review-threads.mjs's 200-char listing
// excerpt must survive the full-body join intact, or the disposition pass would
// read a body cut mid-marker.
test("a thread whose body exceeds the 200-char listing excerpt is disposed from its FULL joined body", async () => {
  const longBody = `${buildFindingMarker({ fp: LONG.fp, severity: "worth-fixing-now", angle: "perf", round: 2 })}\n**worth-fixing-now** (\`perf\`): ${"x".repeat(220)} — judge: defer`;
  const thread = threadNode({ id: "THREAD_LONG", path: "src/cache.mjs", line: 9, commentId: 6400, body: longBody });
  await withLedgerFile(makeLedger({ findings: [LONG.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("pre_approval_gate", 4), threads: [thread] }),
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(6400, longBody),
      patchReviewCommentEntry(6400),
      postReplyEntry(6400, { id: 7400 }),
      resolveThreadEntry("THREAD_LONG"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).deferredResolved, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// Paginated (--slurp page-array) reviews response
// ---------------------------------------------------------------------------

test("a paginated (--slurp page-array) reviews response is flattened, not just the flat-array shape", async () => {
  const pagedReview = { id: 900, state: "COMMENTED", submitted_at: "2026-08-03T10:00:00Z", body: `### Gate review: \`draft_gate\`\n<!-- dev-loops:gate-findings-review draft_gate ${HEAD_SHA} round=7 -->\n\n**Reviewed head SHA:** \`${HEAD_SHA}\``, user: { login: AUTHENTICATED_LOGIN } };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      userEntry(),
      // Two-page reviews response: the round=7 header only appears on page 2 —
      // a flattening regression would silently lose it.
      { ...reviewsEntry([]), stdout: `${JSON.stringify([[], [pagedReview]])}\n` },
      issueCommentsEntry([{ id: 1, body: verdictBody("draft_gate") }]),
      threadsEntry([]),
      threadsEntry([]),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot })).round, 7);
    },
  ));
});

// Kept for parity with the shared surface module: the fingerprint helper the
// poster suppresses on is the same one the ledger writers feed.
test("fingerprintFinding is stable across the ledger's trimmed/untrimmed file spellings", () => {
  assert.equal(
    fingerprintFinding({ files: [" src/a.mjs "], summary: "Missing null check" }),
    fingerprintFinding({ files: ["src/a.mjs"], summary: "missing null check!" }),
  );
});

// ---------------------------------------------------------------------------
// --jq / --silent base guarantee (real subprocess, minimal round)
// ---------------------------------------------------------------------------

// Generic --help flag documentation, --silent success mapping, and
// invalid-filter refusal are owned by emitResult and the base-guarantee
// contract (test/loop/jq-output.test.mjs,
// test/contracts/jq-output-base-guarantee-contract.test.mjs). This command
// keeps one positive --jq wiring case below to prove it composes its result
// through the shared emit path end to end.

test("close-gate-findings.mjs: --jq filters the result and exits 0", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withCliGhStub(roundEntries(), async ({ env, repoRoot }) => {
    const { code, stdout, stderr } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--jq", ".round"], {
      env: { ...env, PATH: env.PATH },
      cwd: repoRoot,
      execPath: (Bun.which("node") ?? "node"),
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "1");
  }));
});


// ---------------------------------------------------------------------------
// #1581: per-gate worth-fixing-now fix window + must-fix-if-present default
// ---------------------------------------------------------------------------

// A must-fix thread fixture (must-fix never defers, so it forces per-gate
// continuation until the gate round cap escalates).
const mustFixBody = (fp, round = 1) => `${buildFindingMarker({ fp, severity: "must-fix", angle: "security", round })}\n**must-fix** (\`security\`): SQL injection`;

function openMustFixThread({ commentId, fp = "2222222222222222", id = "THREAD_MUST", author = AUTHENTICATED_LOGIN } = {}) {
  return threadNode({ id, isResolved: false, path: "src/db.mjs", line: 2, commentId, body: mustFixBody(fp), author });
}

// Write a .devloops.json override into the gh-stub repoRoot so loadDevLoopConfig
// resolves a per-gate worthFixingNowFixWindow for the disposition pass.
async function withGhStubAndConfig(entries, config, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "close-gate-findings-cfg-"));
  try {
    await writeFile(path.join(tmpDir, ".devloops.json"), JSON.stringify(config), "utf8");
    const { env, ghPath } = await writeGhStub(tmpDir, entries);
    return await fn({ env, ghCommand: ghPath, repoRoot: tmpDir });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("a config load error keeps the default inlineSeverityFloor and a null trackerProvider", async () => {
  // Configured floor "nit" would keep the low inline; the error falls back to
  // "medium" and a null tracker provider, so the low folds and the PR is the
  // target. A PR target posts no comment, so the stub list has no comment entry.
  const finding = { severity: "low", angle: "naming", summary: "casing nit in a local constant", operatorVisible: true, judgeDisposition: "defer" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStubAndConfig(
    [...roundEntries({ threads: [] })],
    { version: 1, futureKnob: true, tracker: { provider: "linear" }, gates: { draft: { inlineSeverityFloor: "nit" } } },
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.foldedFiled, 1);
      assert.equal(result.followUpIssueNumber, 42);
    },
  ));
});
// (c) must-fix-if-present continuation: an open must-fix finding forces another
// fix round — it is NEVER deferred, even past the worth-fixing-now window.
test("#1581 (c): an open must-fix finding forces continuation (never deferred past the WFN window)", async () => {
  const thread = openMustFixThread({ commentId: 7300 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    // No GET/PATCH/reply/resolve entries: a regression that deferred this
    // must-fix thread would overflow the stub and fail the run.
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// (d) must-fix escalates (not defers) at round-cap exhaustion: even at a very
// high round (10, past any configured window) a must-fix thread is still NOT
// deferred — it would escalate via the gate round cap, never defer.
test("#1581 (d): must-fix escalates (not defers) at round-cap exhaustion", async () => {
  const thread = openMustFixThread({ commentId: 7400 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStubAndConfig(
    // No disposition entries: must-fix must not be deferred even at round 10.
    roundEntries({ issueComments: roundHistory("draft_gate", 10), threads: [thread] }),
    { version: 1, gates: { draft: { worthFixingNowFixWindow: 2 } } },
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 10);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// ---------------------------------------------------------------------------
// #1585: close-gate-findings reports unresolvedGateThreadCount after the defer pass
// ---------------------------------------------------------------------------

test("#1585: unresolvedGateThreadCount reflects the subtraction (must-fix stays, nice-to-have resolved)", async () => {
  // A must-fix thread (never deferred) + a judge-deferred nice-to-have thread
  // => pre-defer count is 2, deferredResolved is 1, reported
  // unresolvedGateThreadCount is 1 (the must-fix the fixer has not yet closed).
  const mustFixBodyStr = `${buildFindingMarker({ fp: "2222222222222222", severity: "must-fix", angle: "security", round: 1 })}\n**must-fix** (\`security\`): SQL injection`;
  const niceToHaveBodyStr = `${buildFindingMarker({ fp: CASING.fp, severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): casing nit — judge: defer`;
  const mustFix = threadNode({ id: "THREAD_MUST", path: "src/db.mjs", line: 2, commentId: 8001, body: mustFixBodyStr });
  const niceToHave = threadNode({ id: "THREAD_NTH", path: "src/naming.mjs", line: 4, commentId: 8002, body: niceToHaveBodyStr });

  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [CASING.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [mustFix, niceToHave] }),
      // The disposition pass resolves ONLY the judge-deferred nice-to-have
      // (the must-fix is unjudged and never defers).
      ...deferralCommentEntries(9500),
      getReviewCommentEntry(8002, niceToHaveBodyStr),
      patchReviewCommentEntry(8002),
      postReplyEntry(8002, { id: 7800 }),
      resolveThreadEntry("THREAD_NTH"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
      // 2 unresolved gate-authored threads pre-defer, 1 resolved => 1 remains.
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.followUpIssueNumber, 9500);
    },
  ));
});

// ---------------------------------------------------------------------------
// Folded filing. A finding below the inline floor
// (upsert-checkpoint-verdict.mjs's renderVerdictDetailsBlock) never gets a
// thread of its own; its operator-visible lows join the round's ONE batched
// deferral comment directly from the ledger (linked spec issue target only; a
// PR target posts no comment).
// ---------------------------------------------------------------------------

test("#2263: an operator-visible folded low is listed in ONE deferral comment, with no gate-authored thread of its own", async () => {
  const finding = { severity: "low", angle: "naming", summary: "casing nit in a local constant", operatorVisible: true, judgeDisposition: "defer" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [] }),
      ...deferralCommentEntries(9600, { contains: [fingerprintFinding(finding)] }),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0, "a folded finding never had a thread to resolve");
      assert.equal(result.unresolvedGateThreadCount, 0, "a folded finding never enters the gate-authored thread count");
      assert.equal(result.foldedFiled, 1);
      assert.equal(result.followUpIssueNumber, 9600);
    },
  ));
});

test("a folded deferred nit stays out of the deferral comment while a folded deferred operator-visible low enters it", async () => {
  const low = { severity: "low", angle: "naming", summary: "casing nit in a local constant", operatorVisible: true, judgeDisposition: "defer" };
  const nit = { severity: "nit", angle: "style", summary: "trailing whitespace", judgeDisposition: "defer" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [low, nit] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [] }),
      ...deferralCommentEntries(9600, { contains: [fingerprintFinding(low)], notContains: [fingerprintFinding(nit)] }),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.foldedFiled, 1);
    },
  ));
});

test("#2263: an unjudged nit and an unjudged low fold with no filing: no deferral-comment calls at all", async () => {
  const nitFinding = { severity: "nit", angle: "style", summary: "trailing whitespace" };
  const quietLowFinding = { severity: "low", angle: "naming", summary: "casing nit in a local constant" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [nitFinding, quietLowFinding] }), (ledgerPath) => withGhStub(
    // No deferralCommentEntries here: an all-unfileable folded batch must
    // never even look up the comment target.
    roundEntries({ threads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.foldedFiled, 0);
      assert.equal(result.followUpIssueNumber, undefined);
    },
  ));
});

test("an operator-visible folded low the judge disposed act is not listed — no deferral-comment calls", async () => {
  const finding = { severity: "low", angle: "naming", summary: "casing nit in a local constant", operatorVisible: true, judgeDisposition: "act" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.foldedFiled, 0);
      assert.equal(result.followUpIssueNumber, undefined);
    },
  ));
});

for (const [label, dispositions] of [["act + defer", ["act", "defer"]], ["missing + defer", [undefined, "defer"]]]) {
  test(`an operator-visible folded low whose duplicate-fingerprint ledger entries disagree (${label}) is not listed`, async () => {
    const base = { severity: "low", summary: "casing nit in a local constant", operatorVisible: true };
    const findings = [
      { ...base, angle: "naming", judgeDisposition: dispositions[0] },
      { ...base, angle: "scope", judgeDisposition: dispositions[1] },
    ];
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings }), (ledgerPath) => withGhStub(
      roundEntries({ threads: [] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.foldedFiled, 0);
        assert.equal(result.followUpIssueNumber, undefined);
      },
    ));
  });
}

test("#2263: re-running the folded filing does not re-append a fingerprint the target already lists (idempotency)", async () => {
  const finding = { severity: "low", angle: "naming", summary: "casing nit in a local constant", operatorVisible: true, judgeDisposition: "defer" };
  const fp = fingerprintFinding(finding);
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [] }),
      prViewEntry([9500]),
      targetCommentsEntry(9500, [{ body: `<!-- dev-loops:deferred-summary -->\n- \`${fp}\` **low** (\`naming\`): casing nit in a local constant` }]),
      // No appendFollowUpIssueEntry: the fingerprint is already listed.
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.foldedFiled, 0);
      assert.equal(result.followUpIssueNumber, 9500, "still reports the comment target");
    },
  ));
});

// Folded and thread deferrals of one round share ONE batched comment.
test("#2263: folded and thread deferrals of one round go in ONE batched comment", async () => {
  const wfnBody2 = `${buildFindingMarker({ fp: NPLUS1.fp, severity: "worth-fixing-now", angle: "perf", round: 4 })}\n**medium** (\`perf\`): n+1 query — judge: defer`;
  const threadFinding = threadNode({ id: "THREAD_MEDIUM", path: "src/perf.mjs", line: 9, commentId: 6300, body: wfnBody2 });
  const foldedFinding = { severity: "low", angle: "naming", summary: "casing nit in a local constant", operatorVisible: true, judgeDisposition: "defer" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [foldedFinding, NPLUS1.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [threadFinding] }),
      ...deferralCommentEntries(9700, { contains: [NPLUS1.fp, fingerprintFinding(foldedFinding)] }),
      getReviewCommentEntry(6300, wfnBody2),
      patchReviewCommentEntry(6300),
      postReplyEntry(6300, { id: 7400 }),
      resolveThreadEntry("THREAD_MEDIUM"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 1);
      assert.equal(result.foldedFiled, 1);
      assert.equal(result.followUpIssueNumber, 9700);
    },
  ));
});


// An act with remedyKind evidence_only never reaches the fixer, but it is still
// an act: the judge did not defer it, so the thread is never deferred.
test("a prior-ledger act with remedyKind evidence_only is replied to and resolved with no stamp", async () => {
  const finding = { severity: "worth-fixing-now", angle: "perf", summary: "stale cache not invalidated" };
  const fp = fingerprintFinding(finding);
  const thread = openWfnThread({ commentId: 6002, fp });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      { ...postReplyEntry(6002, { id: 7002 }), assertStdinIncludes: ["evidence-only remedy", "no file change"] },
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ ...finding, judgeDisposition: "act", remedyKind: "evidence_only", judgeRationale: "no file change" }] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.evidenceOnlyClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

// The same holds for the CURRENT ledger.
test("a current-ledger act with remedyKind evidence_only is replied to and resolved with no stamp", async () => {
  const finding = { severity: "worth-fixing-now", angle: "perf", summary: "stale cache not invalidated" };
  const fp = fingerprintFinding(finding);
  const thread = openWfnThread({ commentId: 6003, fp });
  const ledger = makeLedger({ gate: "draft_gate", findings: [{ ...finding, judgeDisposition: "act", remedyKind: "evidence_only", judgeRationale: "no file change" }] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      { ...postReplyEntry(6003, { id: 7003 }), assertStdinIncludes: ["evidence-only remedy", "no file change"] },
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.evidenceOnlyClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

// With no judgeRationale, the evidence-only reply states that none was recorded.
test("a current-ledger evidence_only act without judgeRationale replies with the no-rationale text", async () => {
  const finding = { severity: "worth-fixing-now", angle: "perf", summary: "stale cache not invalidated" };
  const fp = fingerprintFinding(finding);
  const thread = openWfnThread({ commentId: 6005, fp });
  const ledger = makeLedger({ gate: "draft_gate", findings: [{ ...finding, judgeDisposition: "act", remedyKind: "evidence_only" }] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      { ...postReplyEntry(6005, { id: 7005 }), assertStdinIncludes: ["evidence-only remedy", "the judge recorded no rationale text for this evidence-only remedy"] },
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.evidenceOnlyClosed, 1);
    },
  ));
});

// Rejected forms: an open act, or a mixed pair of evidence-only and open act, keeps the thread open.
for (const [label, extra] of [["an open act", []], ["a mixed evidence-only and open act pair", [{ remedyKind: "evidence_only" }]]]) {
  test(`${label} in the current ledger leaves the thread open: no reply, stamp or resolve`, async () => {
    const finding = { severity: "worth-fixing-now", angle: "perf", summary: "stale cache not invalidated", judgeDisposition: "act", judgeRationale: "fix it" };
    const fp = fingerprintFinding(finding);
    const thread = openWfnThread({ commentId: 6004, fp });
    const findings = [finding, ...extra.map((e) => ({ ...finding, ...e }))];
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings }), (ledgerPath) => withGhStub(
      roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.evidenceOnlyClosed, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
      },
    ));
  });
}

// Tier 2: same disposition but a remedyKind disagreement is ambiguous, not a cache hit.
test("a tied prior-ledger remedyKind disagreement (same disposition) is ambiguous — the thread stays open", async () => {
  const fp = fingerprintFinding({ summary: "why this approach?" });
  const questionBody = `${buildFindingMarker({ fp, severity: "question", angle: "scope", round: 2 })}\n**question** (\`scope\`): why this approach? — judge: reject`;
  const thread = threadNode({ id: "THREAD_Q_REMEDY_AMBIGUOUS", commentId: 6278, body: questionBody, replies: [{ body: "Answering now.", author: "operator" }] });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      for (const [n, extra] of [[1, { remedyKind: "evidence_only" }], [2, {}]]) {
        await writeFile(
          path.join(findingsDir, `draft_gate-${nthHeadSha(n)}.json`),
          JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ severity: "question", angle: "scope", summary: "why this approach?", judgeDisposition: "act", judgeRationale: `tied ${n}`, ...extra }] }),
          "utf8",
        );
      }
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// ---------------------------------------------------------------------------
// ADR 0144: reject-close a judge-rejected medium or low defect thread
// ---------------------------------------------------------------------------

function defectThread({ severity, summary, judgeDisposition, judgeRationale, commentId, id, angle = "correctness" }) {
  const finding = { severity, angle, summary, judgeDisposition, ...(judgeRationale ? { judgeRationale } : {}) };
  const fp = fingerprintFinding(finding);
  const body = `${buildFindingMarker({ fp, severity, angle, round: 1 })}\n**Problem:** ${summary}`;
  return { finding, fp, thread: threadNode({ id, commentId, body }) };
}

for (const severity of ["medium", "low", "nit"]) {
  test(`a judge-rejected ${severity} defect thread is reply-resolved with the summary and judge rationale, never deferred or filed`, async () => {
    const { finding, thread } = defectThread({ severity, summary: `the ${severity} claim about parsing`, judgeDisposition: "reject", judgeRationale: "The claim contradicts the spec.", commentId: 6300, id: `THREAD_${severity}_REJECTED` });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
      [
        ...roundEntries({ threads: [thread] }),
        {
          assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6300/replies`, "--input", "-"],
          assertStdinIncludes: ["Examined on merits:", `the ${severity} claim about parsing`, "The claim contradicts the spec."],
          stdout: `${JSON.stringify({ id: 7300, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7300` })}\n`,
        },
        resolveThreadEntry(`THREAD_${severity}_REJECTED`),
      ],
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.rejectClosed, 1);
        assert.equal(result.deferredResolved, 0);
        assert.equal(result.followUpIssueNumber, undefined);
        assert.equal(result.unresolvedGateThreadCount, 0);
      },
    ));
  });
}

test("a judge-rejected medium past the fix window is reject-closed, never stamped deferred or filed", async () => {
  const { finding, thread } = defectThread({ severity: "medium", summary: "a past-window medium claim", judgeDisposition: "reject", judgeRationale: "The claim contradicts the spec.", commentId: 6305, id: "THREAD_MEDIUM_PAST_WINDOW" });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6305/replies`, "--input", "-"],
        assertStdinIncludes: ["Examined on merits:", "The claim contradicts the spec."],
        stdout: `${JSON.stringify({ id: 7305, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7305` })}\n`,
      },
      resolveThreadEntry("THREAD_MEDIUM_PAST_WINDOW"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.followUpIssueNumber, undefined);
    },
  ));
});

// A high has no exit unless rejected and a question is never deferred, even when the ledger says defer.
for (const severity of ["high", "question"]) {
  test(`a judge-deferred ${severity} thread is never deferred: it stays open`, async () => {
    const { finding, thread } = defectThread({ severity, summary: `a ${severity} the judge wrongly deferred`, judgeDisposition: "defer", judgeRationale: "Outside scope.", commentId: 6310, id: `THREAD_${severity}_DEFER` });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
      // No stamp, reply or resolve entries: a regression that defers it overflows the stub.
      roundEntries({ threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.deferredResolved, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
      },
    ));
  });
}

function mergedThread(primary, member, { id, commentId }) {
  const body = `${buildFindingMarker({ fp: primary.fp, severity: "medium", angle: "correctness", round: 1 })}\n${buildFindingMarker({ fp: member.fp, severity: "medium", angle: "correctness", round: 1 })}\n**Problem:** merged`;
  return threadNode({ id, commentId, body });
}

for (const memberDisposition of ["act", "defer"]) {
  test(`a merged medium thread with a reject primary and a ${memberDisposition} member is not reject-closed in the fix window`, async () => {
    const primary = defectThread({ severity: "medium", summary: "merged primary claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6350, id: "X" });
    const member = defectThread({ severity: "medium", summary: "merged member claim", judgeDisposition: memberDisposition, commentId: 6350, id: "X" });
    const thread = mergedThread(primary, member, { id: "THREAD_MERGED_MIXED", commentId: 6350 });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [primary.finding, member.finding] }), (ledgerPath) => withGhStub(
      roundEntries({ threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.rejectClosed, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
      },
    ));
  });
}

test("a merged medium thread with a reject primary and an act member is neither stamped nor resolved past the fix window", async () => {
  const primary = defectThread({ severity: "medium", summary: "merged primary claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6370, id: "X" });
  const member = defectThread({ severity: "medium", summary: "merged member claim", judgeDisposition: "act", commentId: 6370, id: "X" });
  const thread = mergedThread(primary, member, { id: "THREAD_MERGED_PAST_WINDOW", commentId: 6370 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [primary.finding, member.finding] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// The rendered header suffix carries only the primary's disposition: a non-primary member with no
// ledger evidence must not inherit it, or an act member would be reject-closed.
test("a merged medium thread with no ledger entries and a rendered judge: reject header is not reject-closed", async () => {
  const primary = defectThread({ severity: "medium", summary: "merged primary claim", judgeDisposition: "reject", commentId: 6380, id: "X" });
  const member = defectThread({ severity: "medium", summary: "merged member claim", judgeDisposition: "act", commentId: 6380, id: "X" });
  const merged = mergedThread(primary, member, { id: "THREAD_MERGED_RENDERED", commentId: 6380 });
  const thread = threadNode({ id: "THREAD_MERGED_RENDERED", commentId: 6380, body: `${merged.comments.nodes[0].body}\n**medium** · correctness · judge: reject` });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures, undefined);
    },
  ));
});

test("a merged medium thread whose primary is ledger-rejected and member has no ledger entry is not reject-closed", async () => {
  const primary = defectThread({ severity: "medium", summary: "merged primary claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6381, id: "X" });
  const member = defectThread({ severity: "medium", summary: "merged member claim", judgeDisposition: "reject", commentId: 6381, id: "X" });
  const merged = mergedThread(primary, member, { id: "THREAD_MERGED_NOMEMBER", commentId: 6381 });
  const thread = threadNode({ id: "THREAD_MERGED_NOMEMBER", commentId: 6381, body: `${merged.comments.nodes[0].body}\n**medium** · correctness · judge: reject` });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [primary.finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures, undefined);
    },
  ));
});

test("a merged medium thread whose every member marker is judge-rejected is reject-closed", async () => {
  const primary = defectThread({ severity: "medium", summary: "merged primary claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6360, id: "X" });
  const member = defectThread({ severity: "medium", summary: "merged member claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6360, id: "X" });
  const thread = mergedThread(primary, member, { id: "THREAD_MERGED_REJECT", commentId: 6360 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [primary.finding, member.finding] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6360/replies`, "--input", "-"],
        stdout: `${JSON.stringify({ id: 7360, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7360` })}\n`,
      },
      resolveThreadEntry("THREAD_MERGED_REJECT"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});

test("a judge-rejected high thread is never reject-closed and still counts as unresolved", async () => {
  const { finding, thread } = defectThread({ severity: "high", summary: "a high claim", judgeDisposition: "reject", judgeRationale: "Out of scope.", commentId: 6310, id: "THREAD_HIGH_REJECTED" });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures, undefined);
    },
  ));
});


test("disagreeing current-ledger dispositions for one fingerprint leave a medium thread open", async () => {
  const { finding, thread } = defectThread({ severity: "medium", summary: "an ambiguous medium claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6330, id: "THREAD_MEDIUM_AMBIGUOUS" });
  const twin = { ...finding, angle: "other", judgeDisposition: "defer" };
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding, twin] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures, undefined);
    },
  ));
});

test("a judge-rejected medium thread with an unparseable summary records a dispositionFailures entry and stays open", async () => {
  const { finding, fp } = defectThread({ severity: "medium", summary: "a claim", judgeDisposition: "reject", judgeRationale: "No.", commentId: 6340, id: "X" });
  const thread = threadNode({ id: "THREAD_MEDIUM_NO_SUMMARY", commentId: 6340, body: buildFindingMarker({ fp, severity: "medium", angle: "correctness", round: 1 }) });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
      assert.equal(result.dispositionFailures[0].severity, "medium");
      assert.match(result.dispositionFailures[0].error, /no parseable finding summary/);
    },
  ));
});

for (const [severity, commentId] of [["low", null], ["medium", 0], ["medium", 1.5]]) {
  test(`a judge-rejected ${severity} thread with commentId ${commentId} stays open and names the threadId in dispositionFailures`, async () => {
    const { finding, thread } = defectThread({ severity, summary: `a ${severity} claim with a bad id`, judgeDisposition: "reject", judgeRationale: "No.", commentId, id: `THREAD_BAD_ID_${severity}_${commentId}` });
    await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [finding] }), (ledgerPath) => withGhStub(
      roundEntries({ threads: [thread] }),
      async ({ env, ghCommand, runChild, repoRoot }) => {
        const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
        assert.equal(result.rejectClosed, 0);
        assert.equal(result.unresolvedGateThreadCount, 1);
        assert.equal(result.dispositionFailures.length, 1);
        assert.equal(result.dispositionFailures[0].threadId, `THREAD_BAD_ID_${severity}_${commentId}`);
        assert.match(result.dispositionFailures[0].error, /no valid root commentId/);
      },
    ));
  });
}

test("a medium thread rejected only in a PRIOR round's ledger is reject-closed", async () => {
  const finding = { severity: "medium", angle: "perf", summary: "stale cache not invalidated" };
  const fp = fingerprintFinding(finding);
  const body = `${buildFindingMarker({ fp, severity: "medium", angle: "perf", round: 1 })}\n**Problem:** stale cache not invalidated`;
  const thread = threadNode({ id: "THREAD_PRIOR_REJECT", commentId: 6350, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      postReplyEntry(6350, { id: 7350 }),
      resolveThreadEntry("THREAD_PRIOR_REJECT"),
    ],
    async ({ env, ghCommand, runChild, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(
        path.join(findingsDir, `draft_gate-${nthHeadSha(1)}.json`),
        JSON.stringify({ repo: REPO, pr: PR, gate: "draft_gate", verdict: "findings_present", loggedAt: "2026-09-10T00:00:00.000Z", findings: [{ ...finding, judgeDisposition: "reject", judgeRationale: "prior reject" }] }),
        "utf8",
      );
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, runChild, repoRoot });
      assert.equal(result.rejectClosed, 1);
      assert.equal(result.unresolvedGateThreadCount, 0);
    },
  ));
});
