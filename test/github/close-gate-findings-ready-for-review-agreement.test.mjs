import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { closeGateFindings } from "../../scripts/github/close-gate-findings.mjs";
import { readyForReview } from "../../scripts/github/ready-for-review.mjs";
import { buildFindingMarker, fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { renderGateReviewCommentBody } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { runIdFreeEnv } from "../_helpers.mjs";

// #2381 AC row 4: "A shared fixture drives close-gate-findings and
// ready-for-review and asserts the reported unresolved set and the refusal
// decision agree in every seeded case." Both scripts ultimately assert
// against countUnresolvedGateAuthoredThreads / fetchDraftGateEvidence (the
// SAME shared primitive), but they read the PR's thread state through TWO
// INDEPENDENT gh fetches — this file drives ONE shared, STATEFUL mock GH
// backend (not two disjoint canned-response stubs) so a thread
// close-gate-findings actually resolves is observably resolved on
// ready-for-review's own later, separate read, exactly like the real GitHub
// API would report it.

const REPO = "owner/agreement-repo";
const PR = 99;
const HEAD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const LOGIN = "gate-bot";
const QUESTION_COMMENT_ID = 5001;
const QUESTION_THREAD_ID = "THREAD_AGREEMENT";

const REJECTED_FINDING = {
  severity: "question",
  angle: "scope",
  summary: "why this approach?",
  judgeDisposition: "reject",
  judgeRationale: "This was already decided in the linked issue.",
};
const FP = fingerprintFinding(REJECTED_FINDING);
const QUESTION_MARKER_BODY = `${buildFindingMarker({ fp: FP, severity: "question", angle: "scope", round: 1 })}\n**question** (\`scope\`): why this approach?`;

const DEFECT_COMMENT_ID = 5101;
const DEFECT_THREAD_ID = "THREAD_AGREEMENT_DEFECT";
const DEFECT_FINDING = { severity: "high", angle: "security", summary: "missing auth check" };
const DEFECT_FP = fingerprintFinding(DEFECT_FINDING);
const DEFECT_MARKER_BODY = `${buildFindingMarker({ fp: DEFECT_FP, severity: "high", angle: "security", round: 1 })}\n**high** (\`security\`): missing auth check`;

const DRAFT_GATE_BODY = renderGateReviewCommentBody({
  gate: "draft_gate",
  headSha: HEAD_SHA,
  verdict: "clean",
  findingsSummary: "no blocking issues found",
  nextAction: "mark ready for review",
});

function threadNodeFromState(threadState) {
  return {
    id: threadState.threadId,
    isResolved: threadState.isResolved,
    isOutdated: false,
    path: null,
    line: null,
    comments: {
      nodes: threadState.comments.map((c) => ({
        id: `gid-${c.databaseId}`,
        databaseId: c.databaseId,
        body: c.body,
        author: { login: c.author, __typename: "User" },
      })),
    },
  };
}

// One stateful mock shared across BOTH scripts: reply/resolve calls from
// close-gate-findings mutate the matching `threadState` (by threadId), and a
// LATER ready-for-review read observes that mutation — exactly like two
// separate calls against the real GitHub API would. Generalized to N threads
// so a mixed question+defect fixture can drive both scripts over the SAME
// PR state; buildSharedMock (single thread) is a thin wrapper kept for the
// two pre-existing single-thread tests.
function buildSharedMockForThreads(threadStates) {
  const calls = [];
  const runChild = async (cmd, args = [], _env, stdinText = "") => {
    calls.push({ cmd, args, stdinText });
    if (cmd === "git") return { code: 0, stdout: "", stderr: "" };
    if (cmd !== "gh") throw new Error(`unexpected command: ${cmd}`);
    const joined = args.join(" ");
    if (args[0] === "api" && args[1] === "user") {
      return { code: 0, stdout: `${JSON.stringify({ login: LOGIN })}\n`, stderr: "" };
    }
    if (args.includes(`repos/${REPO}/pulls/${PR}/reviews?per_page=100`)) {
      return { code: 0, stdout: "[]\n", stderr: "" };
    }
    if (args.includes(`repos/${REPO}/issues/${PR}/comments?per_page=100`)) {
      return {
        code: 0,
        stdout: `${JSON.stringify([{ id: 1, body: DRAFT_GATE_BODY, html_url: "https://x/1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }])}\n`,
        stderr: "",
      };
    }
    if (args[0] === "api" && args[1] === "graphql" && joined.includes("resolveReviewThread")) {
      const threadIdArg = args.find((a) => typeof a === "string" && a.startsWith("threadId="));
      const targetId = threadIdArg?.slice("threadId=".length);
      const target = threadStates.find((t) => t.threadId === targetId) ?? threadStates[0];
      target.isResolved = true;
      return { code: 0, stdout: `${JSON.stringify({ data: { resolveReviewThread: { thread: { id: target.threadId, isResolved: true } } } })}\n`, stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql" && joined.includes("reviewThreads")) {
      const nodes = threadStates.map(threadNodeFromState);
      return {
        code: 0,
        stdout: `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } })}\n`,
        stderr: "",
      };
    }
    if (args[0] === "api" && args[1] === "-X" && args[2] === "POST" && joined.includes("/replies")) {
      return { code: 0, stdout: `${JSON.stringify({ id: 9999, html_url: "https://x/discussion_r9999" })}\n`, stderr: "" };
    }
    if (args[0] === "api" && args[1] === "graphql" && joined.includes("isDraft")) {
      return {
        code: 0,
        stdout: `${JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_x", isDraft: true, headRefOid: HEAD_SHA, baseRefName: "main",
                state: "OPEN", mergeStateStatus: "CLEAN", title: "Fix the thing",
                body: "no linked issue here", closingIssuesReferences: { nodes: [] },
              },
            },
          },
        })}\n`,
        stderr: "",
      };
    }
    if (args[0] === "pr" && args[1] === "checks") {
      return { code: 0, stdout: `${JSON.stringify([{ name: "test", state: "success", bucket: "pass" }])}\n`, stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "ready") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 97, stdout: "", stderr: `unhandled gh call in shared-agreement mock: ${joined}\n` };
  };
  return { runChild, calls };
}

function buildSharedMock(threadState) {
  return buildSharedMockForThreads([threadState]);
}

// A gh failure reading the review-thread listing (e.g. an API outage) — both
// scripts must fail CLOSED (unresolvedGateThreadCount: -1), never silently
// proceed as if 0 threads were unresolved.
function buildUnreadableThreadsMock(threadStates) {
  const base = buildSharedMockForThreads(threadStates);
  const runChild = async (cmd, args = [], env, stdinText = "") => {
    const joined = args.join(" ");
    if (cmd === "gh" && args[0] === "api" && args[1] === "graphql" && joined.includes("reviewThreads")) {
      return { code: 1, stdout: "", stderr: "gh: API rate limit exceeded\n" };
    }
    return base.runChild(cmd, args, env, stdinText);
  };
  return { runChild, calls: base.calls };
}

function passingSizeBudget() {
  return { ok: true, outcome: "pass", wholeLogicLoc: 0, t1SliceLoc: 0, reasons: [], waiver: { requested: false, approvedBy: null, t1Valid: false, defaultValid: false } };
}
function passingAdrTripwire() {
  return { ok: true, outcome: "pass", satisfiedBy: null, triggers: [], adrFiles: [], waiver: { requested: false, valid: false, reason: null }, reasons: [] };
}
function passingCommentDiscipline() {
  return { ok: true, outcome: "pass", findings: [], reasons: [] };
}

async function withLedgerFile(fn, { findings = [REJECTED_FINDING] } = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "agreement-ledger-"));
  try {
    const ledgerPath = path.join(tmpDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify({
      repo: REPO, pr: PR, gate: "draft_gate", headSha: HEAD_SHA, verdict: "findings_present",
      findings,
    }), "utf8");
    return await fn(ledgerPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("#2381 shared fixture: an answered, judge-rejected question — close-gate-findings closes it, and ready-for-review (reading the now-resolved thread) then succeeds", async () => {
  const threadState = {
    threadId: QUESTION_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: QUESTION_COMMENT_ID, body: QUESTION_MARKER_BODY, author: LOGIN },
      { databaseId: QUESTION_COMMENT_ID + 1, body: "Answered: see the linked issue's discussion.", author: "operator" },
    ],
  };
  const mock = buildSharedMock(threadState);
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agreement-repo-root-"));
  try {
    const closeResult = await withLedgerFile((ledgerPath) =>
      closeGateFindings({ ledgerPath }, { env: runIdFreeEnv(), ghCommand: "gh", runChild: mock.runChild, repoRoot }),
    );
    assert.equal(closeResult.rejectClosed, 1);
    assert.equal(closeResult.unresolvedGateThreadCount, 0);
    assert.equal(threadState.isResolved, true, "close-gate-findings must have resolved the thread");

    const readyResult = await readyForReview(
      { repo: REPO, pr: PR, waiveSizeBudget: false, reason: null, approvedBy: null },
      {
        env: runIdFreeEnv(),
        ghCommand: "gh",
        repoRoot,
        runChild: mock.runChild,
        syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
        evaluatePrSizeBudget: async () => passingSizeBudget(),
        evaluateAdrTripwire: async () => passingAdrTripwire(),
        evaluateCommentDiscipline: async () => passingCommentDiscipline(),
      },
    );
    assert.equal(readyResult.ok, true);
    assert.equal(readyResult.action, "marked_ready");
    assert.equal(readyResult.unresolvedGateThreadCount, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("#2381 shared fixture: an UNANSWERED, judge-rejected question — close-gate-findings and ready-for-review agree it stays unresolved (count 1, refused)", async () => {
  const threadState = {
    threadId: QUESTION_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: QUESTION_COMMENT_ID, body: QUESTION_MARKER_BODY, author: LOGIN },
      // No reply — hasAnswerReply must be false on the close-gate-findings side.
    ],
  };
  const mock = buildSharedMock(threadState);
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agreement-repo-root-unanswered-"));
  try {
    const closeResult = await withLedgerFile((ledgerPath) =>
      closeGateFindings({ ledgerPath }, { env: runIdFreeEnv(), ghCommand: "gh", runChild: mock.runChild, repoRoot }),
    );
    assert.equal(closeResult.rejectClosed, 0);
    assert.equal(closeResult.unresolvedGateThreadCount, 1);
    assert.equal(threadState.isResolved, false);

    await assert.rejects(
      () => readyForReview(
        { repo: REPO, pr: PR, waiveSizeBudget: false, reason: null, approvedBy: null },
        {
          env: runIdFreeEnv(),
          ghCommand: "gh",
          repoRoot,
          runChild: mock.runChild,
          syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
          evaluatePrSizeBudget: async () => passingSizeBudget(),
          evaluateAdrTripwire: async () => passingAdrTripwire(),
          evaluateCommentDiscipline: async () => passingCommentDiscipline(),
        },
      ),
      /1 unresolved gate-authored review thread/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// #2381 item 9: a defect (high) thread never auto-resolves — close-gate-findings
// and ready-for-review must agree it stays unresolved, and the refusal names
// the defect remedy (fixer fix-close / disposition-pass defer-close), never
// the question remedy.
test("#2381 shared fixture: a defect (high) thread — close-gate-findings never auto-resolves it, and ready-for-review agrees it stays unresolved", async () => {
  const threadState = {
    threadId: DEFECT_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: DEFECT_COMMENT_ID, body: DEFECT_MARKER_BODY, author: LOGIN },
    ],
  };
  const mock = buildSharedMockForThreads([threadState]);
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agreement-repo-root-defect-"));
  try {
    const closeResult = await withLedgerFile(
      (ledgerPath) => closeGateFindings({ ledgerPath }, { env: runIdFreeEnv(), ghCommand: "gh", runChild: mock.runChild, repoRoot }),
      { findings: [DEFECT_FINDING] },
    );
    assert.equal(closeResult.rejectClosed, 0);
    assert.equal(closeResult.deferredResolved, 0);
    assert.equal(closeResult.unresolvedGateThreadCount, 1);
    assert.equal(threadState.isResolved, false);

    await assert.rejects(
      () => readyForReview(
        { repo: REPO, pr: PR, waiveSizeBudget: false, reason: null, approvedBy: null },
        {
          env: runIdFreeEnv(),
          ghCommand: "gh",
          repoRoot,
          runChild: mock.runChild,
          syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
          evaluatePrSizeBudget: async () => passingSizeBudget(),
          evaluateAdrTripwire: async () => passingAdrTripwire(),
          evaluateCommentDiscipline: async () => passingCommentDiscipline(),
        },
      ),
      /1 unresolved gate-authored review thread\(s\): 1 open defect thread\(s\)/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// Mixed case: an answered, judge-rejected question (reject-closed) PLUS an
// open defect thread (never auto-resolved) on the same PR — the reported
// count/refusal must reflect ONLY the still-open defect thread, and the
// refusal text must name the defect remedy, not the (already-cleared)
// question remedy.
test("#2381 shared fixture: a mixed question+defect PR — the question reject-closes, the defect thread stays unresolved, and the refusal names only the defect remedy", async () => {
  const questionThreadState = {
    threadId: QUESTION_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: QUESTION_COMMENT_ID, body: QUESTION_MARKER_BODY, author: LOGIN },
      { databaseId: QUESTION_COMMENT_ID + 1, body: "Answered: see the linked issue's discussion.", author: "operator" },
    ],
  };
  const defectThreadState = {
    threadId: DEFECT_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: DEFECT_COMMENT_ID, body: DEFECT_MARKER_BODY, author: LOGIN },
    ],
  };
  const mock = buildSharedMockForThreads([questionThreadState, defectThreadState]);
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agreement-repo-root-mixed-"));
  try {
    const closeResult = await withLedgerFile(
      (ledgerPath) => closeGateFindings({ ledgerPath }, { env: runIdFreeEnv(), ghCommand: "gh", runChild: mock.runChild, repoRoot }),
      { findings: [REJECTED_FINDING, DEFECT_FINDING] },
    );
    assert.equal(closeResult.rejectClosed, 1);
    assert.equal(closeResult.unresolvedGateThreadCount, 1);
    assert.equal(questionThreadState.isResolved, true, "the question thread must have been reject-closed");
    assert.equal(defectThreadState.isResolved, false, "the defect thread must stay open");

    await assert.rejects(
      () => readyForReview(
        { repo: REPO, pr: PR, waiveSizeBudget: false, reason: null, approvedBy: null },
        {
          env: runIdFreeEnv(),
          ghCommand: "gh",
          repoRoot,
          runChild: mock.runChild,
          syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
          evaluatePrSizeBudget: async () => passingSizeBudget(),
          evaluateAdrTripwire: async () => passingAdrTripwire(),
          evaluateCommentDiscipline: async () => passingCommentDiscipline(),
        },
      ),
      (error) => {
        assert.match(error.message, /1 unresolved gate-authored review thread\(s\): 1 open defect thread\(s\)/);
        assert.doesNotMatch(error.message, /question thread/);
        return true;
      },
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// The -1 unreadable case: a gh failure reading the review-thread listing
// must fail CLOSED on both surfaces, never silently proceed as if 0 threads
// were unresolved.
test("#2381 shared fixture: an unreadable thread state (-1) refuses ready-for-review with its own distinct message", async () => {
  const threadState = {
    threadId: QUESTION_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: QUESTION_COMMENT_ID, body: QUESTION_MARKER_BODY, author: LOGIN },
      { databaseId: QUESTION_COMMENT_ID + 1, body: "Answered: see the linked issue's discussion.", author: "operator" },
    ],
  };
  const mock = buildUnreadableThreadsMock([threadState]);
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agreement-repo-root-unreadable-"));
  try {
    await assert.rejects(
      () => readyForReview(
        { repo: REPO, pr: PR, waiveSizeBudget: false, reason: null, approvedBy: null },
        {
          env: runIdFreeEnv(),
          ghCommand: "gh",
          repoRoot,
          runChild: mock.runChild,
          syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
          evaluatePrSizeBudget: async () => passingSizeBudget(),
          evaluateAdrTripwire: async () => passingAdrTripwire(),
          evaluateCommentDiscipline: async () => passingCommentDiscipline(),
        },
      ),
      /could not read review-thread state/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// An answer authored by THE GATE'S OWN LOGIN (single-account setup, #2381
// item 1) must still count as a resolving answer reply — identity is never
// the criterion.
test("#2381 shared fixture: an answer authored by the gate's own login still reject-closes the question (single-account setup)", async () => {
  const threadState = {
    threadId: QUESTION_THREAD_ID,
    isResolved: false,
    comments: [
      { databaseId: QUESTION_COMMENT_ID, body: QUESTION_MARKER_BODY, author: LOGIN },
      { databaseId: QUESTION_COMMENT_ID + 1, body: "Answered: see the linked issue's discussion.", author: LOGIN },
    ],
  };
  const mock = buildSharedMockForThreads([threadState]);
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agreement-repo-root-samelogin-"));
  try {
    const closeResult = await withLedgerFile((ledgerPath) =>
      closeGateFindings({ ledgerPath }, { env: runIdFreeEnv(), ghCommand: "gh", runChild: mock.runChild, repoRoot }),
    );
    assert.equal(closeResult.rejectClosed, 1);
    assert.equal(closeResult.unresolvedGateThreadCount, 0);
    assert.equal(threadState.isResolved, true);

    const readyResult = await readyForReview(
      { repo: REPO, pr: PR, waiveSizeBudget: false, reason: null, approvedBy: null },
      {
        env: runIdFreeEnv(),
        ghCommand: "gh",
        repoRoot,
        runChild: mock.runChild,
        syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
        evaluatePrSizeBudget: async () => passingSizeBudget(),
        evaluateAdrTripwire: async () => passingAdrTripwire(),
        evaluateCommentDiscipline: async () => passingCommentDiscipline(),
      },
    );
    assert.equal(readyResult.ok, true);
    assert.equal(readyResult.action, "marked_ready");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
