import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";

import {
  closeGateFindings,
  parseCloseGateFindingsCliArgs,
} from "../../scripts/github/close-gate-findings.mjs";
import { buildFindingMarker, fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";

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

function threadNode({ id, isResolved = false, path: filePath = null, line = null, commentId, body, author = AUTHENTICATED_LOGIN }) {
  return {
    id,
    isResolved,
    isOutdated: false,
    path: filePath,
    line,
    comments: { nodes: [{ id: `gid-${commentId}`, databaseId: commentId, body, author: { login: author, __typename: "User" } }] },
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

test("parseCloseGateFindingsCliArgs: --ledger required, --tmp-root optional (default tmp)", () => {
  const result = parseCloseGateFindingsCliArgs(["--ledger", "/tmp/x.json"]);
  assert.equal(result.ledgerPath, "/tmp/x.json");
  assert.equal(result.tmpRoot, "tmp");
});

test("parseCloseGateFindingsCliArgs: --tmp-root overrides the default", () => {
  assert.equal(parseCloseGateFindingsCliArgs(["--ledger", "x.json", "--tmp-root", "custom-tmp"]).tmpRoot, "custom-tmp");
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
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.deepEqual(result, {
        ok: true,
        repo: REPO,
        pr: PR,
        gate: "pre_approval_gate",
        headSha: HEAD_SHA,
        round: 1,
        deferredResolved: 0,
        unresolvedGateThreadCount: 0,
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
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 3);
    },
  ));
});

test("round source (A): a comment merely QUOTING the verdict header (a blockquoted reply) never counts toward the round", async () => {
  const quotedHeaderReply = `> ${verdictBody("draft_gate").split("\n")[0]}\nAgreed, looks good.`;
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: [{ id: 1, body: verdictBody("draft_gate") }, { id: 2, body: quotedHeaderReply }] }),
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 1);
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 1);
    },
  ));
});

test("round source (A): DISTINCT reviewed heads across the review and issue-comment streams count distinctly", async () => {
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      reviews: [{ id: 501, body: verdictBody("pre_approval_gate", HEAD_SHA) }],
      issueComments: [{ id: 1, body: verdictBody("pre_approval_gate", nthHeadSha(1)) }],
    }),
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 2);
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 1);
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 5);
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 2);
    },
  ));
});

test("round source (C): real <gate>-*.json findings-log files under --tmp-root count, ignoring the other gate's and non-.json files", async () => {
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries(),
    async ({ env, ghCommand, repoRoot }) => {
      const findingsDir = path.join(repoRoot, "tmp", "gate-findings", REPO.replace("/", "-"), `pr-${PR}`);
      await mkdir(findingsDir, { recursive: true });
      await writeFile(path.join(findingsDir, `draft_gate-${HEAD_SHA}.json`), "{}", "utf8");
      await writeFile(path.join(findingsDir, "draft_gate-0000000000000000000000000000000000000000.json"), "{}", "utf8");
      await writeFile(path.join(findingsDir, `pre_approval_gate-${HEAD_SHA}.json`), "{}", "utf8"); // other gate — excluded
      await writeFile(path.join(findingsDir, `draft_gate-${HEAD_SHA}.txt`), "not json", "utf8"); // wrong extension — excluded

      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      // Verdict-surface count is 1; the local fallback (2 real draft_gate-*.json
      // files) pushes the round up to 2.
      assert.equal(result.round, 2);
    },
  ));
});

// ---------------------------------------------------------------------------
// Disposition pass: the round window
// ---------------------------------------------------------------------------

const wfnBody = (fp, round = 1) => `${buildFindingMarker({ fp, severity: "worth-fixing-now", angle: "perf", round })}\n**worth-fixing-now** (\`perf\`): stale cache not invalidated`;

function openWfnThread({ commentId, fp = "1111111111111111", id = "THREAD_D", author = AUTHENTICATED_LOGIN } = {}) {
  return threadNode({ id, isResolved: false, path: "src/cache.mjs", line: 9, commentId, body: wfnBody(fp), author });
}

test("an open worth-fixing-now thread stays unresolved AT ROUND 3 EXACTLY (the fix-window boundary)", async () => {
  const thread = openWfnThread({ commentId: 6002 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ issueComments: roundHistory("draft_gate", 3), threads: [thread] }),
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 3);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

test("an open worth-fixing-now thread is replied-to + resolved FROM ROUND 4", async () => {
  const thread = openWfnThread({ commentId: 6002 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      getReviewCommentEntry(6002, wfnBody("1111111111111111")),
      patchReviewCommentEntry(6002),
      postReplyEntry(6002, { id: 7001 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 4);
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

test("an unresolved nice-to-have thread is replied-to + resolved immediately, at round 1", async () => {
  const niceToHaveBody = `${buildFindingMarker({ fp: "7777777777777777", severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): casing nit`;
  const thread = threadNode({ id: "THREAD_DEFER", path: "src/naming.mjs", line: 4, commentId: 6200, body: niceToHaveBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      getReviewCommentEntry(6200, niceToHaveBody),
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

// #1592: a nit thread defer-closes immediately at round 1, exactly like a
// low finding, but with its own window-reason text (no fixer cycle at all).
test("an unresolved nit thread is replied-to + resolved immediately, at round 1", async () => {
  const nitBody = `${buildFindingMarker({ fp: "9999999999999999", severity: "nit", angle: "naming", round: 1 })}\n**nit** (\`naming\`): casing nit`;
  const thread = threadNode({ id: "THREAD_NIT", path: "src/naming.mjs", line: 4, commentId: 6250, body: nitBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      getReviewCommentEntry(6250, nitBody),
      patchReviewCommentEntry(6250),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6250/replies`, "--input", "-"],
        assertStdinIncludes: ["severity nit", "nit findings are deferred immediately at gate close, with no fixer cycle"],
        stdout: `${JSON.stringify({ id: 7150, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7150` })}\n`,
      },
      resolveThreadEntry("THREAD_NIT"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 1);
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
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 0);
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});

// A pre-rename thread stamped severity=defer normalizes on read: the posted
// deferral reply names the canonical tier, never the retired spelling.
test("a legacy severity=defer marker posts a reply in the canonical vocabulary", async () => {
  const legacyBody = `<!-- dev-loops:finding 8888888888888888 severity=defer angle=naming round=1 -->\n**defer** (\`naming\`): casing nit`;
  const thread = threadNode({ id: "THREAD_LEGACY", path: "src/naming.mjs", line: 4, commentId: 6300, body: legacyBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [thread] }),
      getReviewCommentEntry(6300, legacyBody),
      patchReviewCommentEntry(6300),
      {
        assertArgs: ["api", "-X", "POST", `repos/${REPO}/pulls/${PR}/comments/6300/replies`, "--input", "-"],
        assertStdinIncludes: ["severity low", "low findings are deferred at gate close after the fixer triaged them"],
        assertStdinNotIncludes: ["severity defer,", "defer-severity"],
        stdout: `${JSON.stringify({ id: 7200, html_url: `https://github.com/${REPO}/pull/${PR}#discussion_r7200` })}\n`,
      },
      resolveThreadEntry("THREAD_LEGACY"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 1);
      assert.equal(result.deferredResolved, 1);
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
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
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
  const thread = openWfnThread({ commentId: 6600, fp: "5555555555555555", id: "THREAD_WS" });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      getReviewCommentEntry(6600, ` ${wfnBody("5555555555555555")}`),
      patchReviewCommentEntry(6600),
      postReplyEntry(6600, { id: 7600 }),
      resolveThreadEntry("THREAD_WS"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).deferredResolved, 1);
    },
  ));
});

// The already-stamped guard parses the marker's OWN disposition field, never a
// free-text search: a finding quoting the literal token must still be stamped.
test("a finding whose own text quotes the literal 'disposition=deferred' token still gets stamped and resolved", async () => {
  const body = `${buildFindingMarker({ fp: "1010101010101010", severity: "worth-fixing-now", angle: "perf", round: 1 })}\n**worth-fixing-now** (\`perf\`): the fix must stamp disposition=deferred before resolving`;
  const thread = threadNode({ id: "THREAD_D", path: "src/cache.mjs", line: 9, commentId: 6500, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      getReviewCommentEntry(6500, body),
      patchReviewCommentEntry(6500),
      postReplyEntry(6500, { id: 7500 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).deferredResolved, 1);
    },
  ));
});

test("stampDeferredDisposition skips the PATCH when the marker's OWN disposition field is already deferred", async () => {
  const alreadyStamped = `${buildFindingMarker({ fp: "1111000011110000", severity: "worth-fixing-now", angle: "perf", round: 1, disposition: "deferred" })}\n**worth-fixing-now** (\`perf\`): stale cache`;
  const thread = threadNode({ id: "THREAD_D", path: "src/cache.mjs", line: 9, commentId: 6501, body: alreadyStamped });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 4), threads: [thread] }),
      getReviewCommentEntry(6501, alreadyStamped),
      // No patchReviewCommentEntry: a PATCH here would overflow the stub and
      // fail the test — the already-stamped guard must skip straight to
      // reply+resolve.
      postReplyEntry(6501, { id: 7501 }),
      resolveThreadEntry("THREAD_D"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).deferredResolved, 1);
    },
  ));
});

// commentId is validated BEFORE it is ever interpolated into a
// `pulls/comments/{commentId}` API path.
test("a gate-authored thread selected for deferral with no resolvable comment id fails closed, named by threadId", async () => {
  const shortBody = `${buildFindingMarker({ fp: "4444444444444444", severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): short body`;
  const thread = threadNode({ id: "THREAD_NO_COMMENT_ID", path: "src/naming.mjs", line: 3, commentId: null, body: shortBody });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread] }),
    async ({ env, ghCommand, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot }),
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
    async ({ env, ghCommand, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot }),
        /Could not resolve the full body/,
      );
    },
  ));
});

test("fetchThreadsWithFullBodies fails closed for a truncated thread that carries no comment id to join against", async () => {
  const thread = threadNode({ id: "THREAD_NO_ID", path: "src/cache.mjs", line: 9, commentId: null, body: "y".repeat(220) });
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread], fullBodyThreads: [] }),
    async ({ env, ghCommand, repoRoot }) => {
      await assert.rejects(
        () => closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot }),
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).deferredResolved, 0);
    },
  ));
});

test("a join miss on a SHORT body that legitimately ends with its own ellipsis character does not fail closed", async () => {
  const body = `${buildFindingMarker({ fp: "3333333333333333", severity: "must-fix", angle: "security", round: 1 })}\n**must-fix** (\`security\`): trailing thought…`;
  const thread = threadNode({ id: "THREAD_ELLIPSIS", path: "src/naming.mjs", line: 3, commentId: 7101, body });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({ threads: [thread], fullBodyThreads: [] }),
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).deferredResolved, 0);
    },
  ));
});

// A finding summary longer than list-review-threads.mjs's 200-char listing
// excerpt must survive the full-body join intact, or the disposition pass would
// read a body cut mid-marker.
test("a thread whose body exceeds the 200-char listing excerpt is disposed from its FULL joined body", async () => {
  const longBody = `${buildFindingMarker({ fp: "9999999999999999", severity: "worth-fixing-now", angle: "perf", round: 2 })}\n**worth-fixing-now** (\`perf\`): ${"x".repeat(220)}`;
  const thread = threadNode({ id: "THREAD_LONG", path: "src/cache.mjs", line: 9, commentId: 6400, body: longBody });
  await withLedgerFile(makeLedger({ findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ issueComments: roundHistory("pre_approval_gate", 4), threads: [thread] }),
      getReviewCommentEntry(6400, longBody),
      patchReviewCommentEntry(6400),
      postReplyEntry(6400, { id: 7400 }),
      resolveThreadEntry("THREAD_LONG"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).deferredResolved, 1);
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
    async ({ env, ghCommand, repoRoot }) => {
      assert.equal((await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot })).round, 7);
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

test("close-gate-findings.mjs: --help documents the shared --jq/--silent flags", async () => {
  const { code, stdout } = await runNode(SCRIPT_PATH, ["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--jq <filter>/);
  assert.match(stdout, /--silent, -s/);
});

test("close-gate-findings.mjs: --jq filters the result and exits 0", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(roundEntries(), async ({ env, repoRoot }) => {
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
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(roundEntries(), async ({ env, repoRoot }) => {
    const { code, stdout } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--silent"], { env, cwd: repoRoot });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  }));
});

test("close-gate-findings.mjs: an invalid --jq filter fails closed: stderr + exit 2", async () => {
  const ledger = makeLedger({ gate: "draft_gate", findings: [] });
  await withLedgerFile(ledger, (ledgerPath) => withGhStub(roundEntries(), async ({ env, repoRoot }) => {
    const { code, stdout, stderr } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--jq", "bogus!!"], { env, cwd: repoRoot });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /--jq/);
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

// (a) per-gate window honored: a draft gate configured with window=2 defers an
// open worth-fixing-now thread at round 3 (3 > 2), where the default window 3
// would have kept it open.
test("#1581 (a): a per-gate worthFixingNowFixWindow is honored by the disposition pass", async () => {
  const thread = openWfnThread({ commentId: 7100 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStubAndConfig(
    [
      ...roundEntries({ issueComments: roundHistory("draft_gate", 3), threads: [thread] }),
      getReviewCommentEntry(7100, wfnBody("1111111111111111")),
      patchReviewCommentEntry(7100),
      postReplyEntry(7100, { id: 8100 }),
      resolveThreadEntry("THREAD_D"),
    ],
    { version: 1, gates: { draft: { worthFixingNowFixWindow: 2 } } },
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 3);
      assert.equal(result.deferredResolved, 1);
    },
  ));
});

// (a cont.) the SAME gate at round 2 with window 2 keeps the WFN thread open —
// the window boundary is inclusive (round <= window stays open).
test("#1581 (a): a WFN thread stays open at round == window (boundary is inclusive)", async () => {
  const thread = openWfnThread({ commentId: 7101 });
  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStubAndConfig(
    roundEntries({ issueComments: roundHistory("draft_gate", 2), threads: [thread] }),
    { version: 1, gates: { draft: { worthFixingNowFixWindow: 2 } } },
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 2);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// (b) cross-gate isolation: a high draft_gate round count does NOT deplete
// pre_approval_gate's window. pre_approval_gate at its own round 2 keeps a WFN
// thread open, even though draft_gate has already run 9 rounds.
test("#1581 (b): draft_gate rounds do not consume pre_approval_gate's worth-fixing-now window", async () => {
  const thread = openWfnThread({ commentId: 7200 });
  await withLedgerFile(makeLedger({ gate: "pre_approval_gate", findings: [] }), (ledgerPath) => withGhStub(
    roundEntries({
      issueComments: [...roundHistory("draft_gate", 9), ...roundHistory("pre_approval_gate", 2)],
      threads: [thread],
    }),
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 2);
      assert.equal(result.deferredResolved, 0);
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
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
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
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.round, 10);
      assert.equal(result.deferredResolved, 0);
    },
  ));
});

// ---------------------------------------------------------------------------
// #1585: close-gate-findings reports unresolvedGateThreadCount after the defer pass
// ---------------------------------------------------------------------------

test("#1585: unresolvedGateThreadCount reflects the subtraction (must-fix stays, nice-to-have deferred)", async () => {
  // A must-fix thread (never deferred) + a nice-to-have thread (deferred at
  // round 1) => pre-defer count is 2, deferredResolved is 1, reported
  // unresolvedGateThreadCount is 1 (the must-fix the fixer has not yet closed).
  const mustFixBodyStr = `${buildFindingMarker({ fp: "2222222222222222", severity: "must-fix", angle: "security", round: 1 })}\n**must-fix** (\`security\`): SQL injection`;
  const niceToHaveBodyStr = `${buildFindingMarker({ fp: "7777777777777777", severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): casing nit`;
  const mustFix = threadNode({ id: "THREAD_MUST", path: "src/db.mjs", line: 2, commentId: 8001, body: mustFixBodyStr });
  const niceToHave = threadNode({ id: "THREAD_NTH", path: "src/naming.mjs", line: 4, commentId: 8002, body: niceToHaveBodyStr });

  await withLedgerFile(makeLedger({ gate: "draft_gate", findings: [] }), (ledgerPath) => withGhStub(
    [
      ...roundEntries({ threads: [mustFix, niceToHave] }),
      // The disposition pass defers ONLY the nice-to-have (must-fix never defers).
      getReviewCommentEntry(8002, niceToHaveBodyStr),
      patchReviewCommentEntry(8002),
      postReplyEntry(8002, { id: 7800 }),
      resolveThreadEntry("THREAD_NTH"),
    ],
    async ({ env, ghCommand, repoRoot }) => {
      const result = await closeGateFindings({ ledgerPath }, { env, ghCommand, repoRoot });
      assert.equal(result.deferredResolved, 1);
      // 2 unresolved gate-authored threads pre-defer, 1 deferred => 1 remains.
      assert.equal(result.unresolvedGateThreadCount, 1);
    },
  ));
});
