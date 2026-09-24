// Carried convergence and the Copilot body-disposition record.
//
// One fixture table drives BOTH request-copilot-review.mjs and
// detect-pr-gate-coordination-state.mjs, so the test proves the two agree on
// every head: the request tool never re-requests on a head the detector
// reports as carried, and the detector never reports carried on a head where
// the request tool would re-request.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, test } from "bun:test";
import { makeGhMock, runIdFreeEnv } from "../_helpers.mjs";
import { performCopilotReviewRequest } from "../../scripts/github/request-copilot-review.mjs";
import { mergePr } from "../../scripts/github/merge-pr.mjs";
import { detectPrGateCoordinationState, loadPrGateCoordinationContext } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { runHandoff } from "../../scripts/loop/copilot-pr-handoff.mjs";
import { autoDetectSnapshot } from "../../scripts/loop/detect-copilot-loop-state.mjs";
import { buildCoordinationEvaluatorInput } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import {
  isTrustedDispositionAuthor,
  parseCopilotBodyDispositionMarker,
  resolveCopilotBodyDisposition,
  resolveLatestCopilotReview,
} from "../../scripts/github/_copilot-body-disposition.mjs";
import { fetchDeltaChangedFiles, resolveCarriedConvergence, resolvePostConvergenceReviewSuppressed } from "../../scripts/loop/_copilot-convergence-carry.mjs";
import { writeSuppressionMarker } from "../../scripts/loop/_post-convergence-review-suppression.mjs";
import { summarizeCopilotReviews } from "@dev-loops/core/github/copilot-helpers";
import { interpretLoopState } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluatePrGateCoordination, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { resolveGateConfig } from "@dev-loops/core/config";

const REPO = "owner/repo";
const PR = 17;
const PRIOR = "a".repeat(40);
const HEAD = "b".repeat(40);
const FIX = "c".repeat(40);
const COPILOT = "copilot-pull-request-reviewer[bot]";
const YELLOW = "### 🟡 Changes recommended\n\nActionable feedback in the body.";
const DOCS_DELTA = { status: "ahead", files: [{ filename: "docs/guide.md", status: "modified" }] };
const CODE_DELTA = { status: "ahead", files: [{ filename: "scripts/loop/foo.mjs", status: "modified" }] };
// Large enough for the round-cap significant-change check.
const SIGNIFICANT_CODE_DELTA = { status: "ahead", files: [{ filename: "scripts/loop/foo.mjs", status: "modified", changes: 40 }] };

// capRoot and wideRoot pin the strict mode
// (refinement.requireCopilotConvergenceAtLatestHead: true), the docs-only carry
// these tables were written against. The converged-once roots pin the default.
let capRoot = null;
// Round cap 5: multi-round scenarios stay below the cap.
let wideRoot = null;
let convergedOnceCapRoot = null;
let convergedOnceWideRoot = null;
let checkpointDir = null;
beforeAll(async () => {
  capRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-"));
  wideRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-wide-"));
  const devloops = await readFile(path.resolve(".devloops"), "utf8");
  const strict = "\n  requireCopilotConvergenceAtLatestHead: true";
  await writeFile(path.join(capRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, `maxCopilotRounds: 2${strict}`), "utf8");
  await writeFile(path.join(wideRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, `maxCopilotRounds: 5${strict}`), "utf8");
  convergedOnceCapRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-once-cap-"));
  convergedOnceWideRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-once-wide-"));
  await writeFile(path.join(convergedOnceCapRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, "maxCopilotRounds: 2"), "utf8");
  await writeFile(path.join(convergedOnceWideRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, "maxCopilotRounds: 5"), "utf8");
  checkpointDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-markers-"));
});
afterAll(async () => {
  await rm(capRoot, { recursive: true, force: true });
  await rm(wideRoot, { recursive: true, force: true });
  await rm(convergedOnceCapRoot, { recursive: true, force: true });
  await rm(convergedOnceWideRoot, { recursive: true, force: true });
  await rm(checkpointDir, { recursive: true, force: true });
});

const line = (value) => `${JSON.stringify(value)}\n`;

// `reviewId` attributes the thread to the review that opened it (the root
// comment's pullRequestReview); null leaves it unattributed.
function thread({ id = "thread-1", isResolved, reviewId = null }) {
  return {
    id,
    isResolved,
    comments: { nodes: [{ id: `${id}-c1`, databaseId: 1001, body: "Tighten this sentence.", author: { login: "copilot-pull-request-reviewer", __typename: "Bot" }, ...(reviewId ? { pullRequestReview: { id: reviewId } } : {}) }] },
  };
}

function dispositionComment({ reviewId, head = HEAD, kind = "operator", login = "maintainer", association = "OWNER", type = "User" }) {
  const tail = kind === "operator" ? "operator" : `fix=${kind}`;
  return {
    id: 501,
    body: `Disposition recorded.\n<!-- dev-loops:copilot-body-disposition review=${reviewId} head=${head} ${tail} -->`,
    user: { login, type },
    author_association: association,
  };
}

const OLDER = "d".repeat(40);
const OLDER_REVIEW = { id: "PRR_older", author: { login: COPILOT }, state: "COMMENTED", body: "", commit: { oid: OLDER }, submittedAt: "2026-09-22T08:00:00Z" };
const compareEntry = (base, head, status) => ({ matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${base}...${head}`], stdout: line({ status }) });
// A fix record for PRR_prior: FIX is after PRIOR and contained in HEAD.
const FIX_AFTER_PRIOR = [compareEntry(PRIOR, FIX, "ahead"), compareEntry(FIX, HEAD, "ahead")];

const commentsEntry = (dispositions) => ({ matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`, "--jq", ".[]"], stdout: dispositions.map(line).join("") });
// The PR's base branch, declared so the base-relative reduction runs on every
// row instead of failing open on an unmatched call.
const BASE_REF_ENTRY = { matchByClaims: true, assertArgs: ["pr", "view", String(PR), "--json", "baseRefName"], stdout: "main\n" };

// The single scenario table: prior Copilot review on PRIOR, current head HEAD.
// `prOwn` is the PR's own diff (compare main...HEAD); it defaults to the delta.
// The comment stream is declared twice: the body-feedback resolver and the
// carry predicate each read it once.
function scenario({ priorBody = "", threads = [], delta = DOCS_DELTA, prOwn = delta, dispositions = [], olderReviews = [], extraShared = [], reviews: reviewsOverride = null } = {}) {
  const reviews = reviewsOverride ?? [...olderReviews, { id: "PRR_prior", author: { login: COPILOT }, state: "COMMENTED", body: priorBody, commit: { oid: PRIOR }, submittedAt: "2026-09-22T10:00:00Z" }];
  const shared = [
    ...extraShared,
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${PRIOR}...${HEAD}`], stdout: line(delta) },
    BASE_REF_ENTRY,
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/main...${HEAD}`], stdout: line(prOwn) },
    { matchByClaims: true, assertArgs: ["api", "graphql"], assertArgContains: ["reviewThreads"], stdout: line({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } }) },
    commentsEntry(dispositions),
    commentsEntry(dispositions),
  ];
  return { reviews, shared };
}

// The draft_gate evidence both tools read to adjust the round count at the cap.
function gateEvidenceEntry() {
  return {
    matchByClaims: true,
    assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`],
    stdout: line([[{
      id: 21,
      body: ["Gate review: draft_gate", `Reviewed head SHA: ${PRIOR}`, "Verdict: clean", "Findings summary: no issues found", "Next action: mark ready for review"].join("\n"),
      html_url: "https://example.test/comment/21",
      updated_at: "2026-09-22T09:00:00Z",
    }]]),
  };
}

const REVIEWS_ENTRY = { matchByClaims: true, assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/reviews?per_page=100`], stdout: "[]\n" };

// Every gh call must match a declared fixture: no row may pass on the mock's
// unmatched-call exit code.
function strictRunChild(entries) {
  const mock = makeGhMock(entries);
  const unmatched = [];
  const runChild = async (...args) => {
    const result = await mock.runChild(...args);
    if (result.code === 97) unmatched.push(args[1].join(" "));
    return result;
  };
  return { runChild, calls: mock.calls, unmatched };
}

function requestEntries({ reviews, shared }) {
  const prView = { matchByClaims: true, assertArgs: ["pr", "view", String(PR), "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: line({ headRefOid: HEAD, isDraft: false, state: "OPEN", number: PR, reviews, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }) };
  return [
    gateEvidenceEntry(),
    REVIEWS_ENTRY,
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`, "-X", "POST"], stdout: line({ requested_reviewers: [{ login: COPILOT }] }) },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [], teams: [] }) },
    prView,
    ...shared,
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [{ login: "Copilot" }], teams: [] }) },
    prView,
  ];
}

function detectorEntries({ reviews, shared }, { extra = [], files, formallyRequested = true } = {}) {
  return [
    {
      matchByClaims: true,
      assertArgs: ["pr", "view", String(PR), "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
      stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], reviews, ...(files ? { files } : {}) }),
    },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [], teams: [] }) },
    { matchByClaims: true, assertArgs: ["pr", "view", String(PR), "--json", "headRefOid"], stdout: line({ headRefOid: HEAD }) },
    gateEvidenceEntry(),
    REVIEWS_ENTRY,
    { matchByClaims: true, assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'], stdout: formallyRequested ? `${COPILOT}\n` : "" },
    ...shared,
    ...extra,
  ];
}

function runtimeFor(entries, { root = capRoot, markerDir = checkpointDir } = {}) {
  const { runChild, calls } = makeGhMock(entries);
  return { runtime: { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", runChild, repoRoot: root, checkpointDir: markerDir }, calls };
}

async function runRequestTool(fixture, { root = capRoot, markerDir = checkpointDir } = {}) {
  const { runChild, unmatched } = strictRunChild(requestEntries(fixture));
  const result = await performCopilotReviewRequest(
    { repo: REPO, pr: PR, checkpointDir: markerDir },
    { env: { GH_SEQUENCE_PATH: "1" }, ghCommand: "gh", runChild, repoRoot: root, delayImpl: async () => {} },
  );
  assert.deepEqual(unmatched, [], "request tool made an undeclared gh call");
  return result;
}

async function runDetector(fixture, options = {}) {
  const { runtime } = runtimeFor([], options);
  const { runChild, unmatched } = strictRunChild(detectorEntries(fixture, options));
  const result = await detectPrGateCoordinationState({ repo: REPO, pr: PR }, { ...runtime, runChild });
  assert.deepEqual(unmatched, [], "detector made an undeclared gh call");
  return result;
}

const CASES = [
  { name: "docs-only delta, one resolved thread (the observed deadlock shape)", fixture: { threads: [thread({ isResolved: true })] }, carried: true },
  { name: "docs-only delta, no thread, plain body", fixture: {}, carried: true },
  { name: "docs-only delta, changes-recommended body, its thread resolved", fixture: { priorBody: YELLOW, threads: [thread({ isResolved: true, reviewId: "PRR_prior" })] }, carried: true },
  // Thread attribution: only a thread the prior review opened counts.
  {
    name: "docs-only delta, body-only changes-recommended, only an older review's resolved thread, no record",
    fixture: { priorBody: YELLOW, olderReviews: [OLDER_REVIEW], threads: [thread({ isResolved: true, reviewId: "PRR_older" })] },
    root: "wide",
    carried: false,
  },
  {
    name: "docs-only delta, changes-recommended body, resolved thread without review attribution",
    fixture: { priorBody: YELLOW, threads: [thread({ isResolved: true })] },
    carried: false,
  },
  {
    name: "docs-only delta, body-only changes-recommended, trusted fix record after the review commit",
    fixture: { priorBody: YELLOW, dispositions: [dispositionComment({ reviewId: "PRR_prior", kind: FIX })], extraShared: [...FIX_AFTER_PRIOR, ...FIX_AFTER_PRIOR] },
    carried: true,
    bodyDisposition: true,
  },
  {
    name: "docs-only delta, body-only changes-recommended, fix record naming the review commit itself",
    fixture: { priorBody: YELLOW, dispositions: [dispositionComment({ reviewId: "PRR_prior", kind: PRIOR })] },
    carried: false,
  },
  // An unresolved thread keeps the pre-existing route: resolve the thread first.
  { name: "docs-only delta, one unresolved thread", fixture: { threads: [thread({ isResolved: false })] }, carried: false, nextAction: PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS },
  { name: "code delta, one resolved thread", fixture: { threads: [thread({ isResolved: true })], delta: CODE_DELTA }, carried: false },
  // Integrate-only: the code file changed since PRIOR came from the base, so
  // the base-relative reduction empties the delta.
  { name: "integrate-only base move: code delta outside the PR's own diff", fixture: { threads: [thread({ isResolved: true })], delta: CODE_DELTA, prOwn: DOCS_DELTA }, carried: true },
  { name: "docs-only delta, body-only changes-recommended, no record", fixture: { priorBody: YELLOW }, carried: false },
  // The body-blocking set: an unrecognized disposition header fails closed, and
  // the soft needs-a-closer-look non-approval carries without a record.
  { name: "docs-only delta, body-only unrecognized disposition header, no record", fixture: { priorBody: "### 🟣 Something new\n\nBody." }, carried: false },
  { name: "docs-only delta, body-only needs-a-closer-look, no record", fixture: { priorBody: "### 🔵 Needs a closer look\n\nBody." }, carried: true },
  {
    name: "docs-only delta, body-only changes-recommended, trusted operator record",
    fixture: { priorBody: YELLOW, dispositions: [dispositionComment({ reviewId: "PRR_prior" })] },
    carried: true,
    bodyDisposition: true,
  },
  {
    name: "docs-only delta, body-only changes-recommended, untrusted record",
    fixture: { priorBody: YELLOW, dispositions: [dispositionComment({ reviewId: "PRR_prior", association: "CONTRIBUTOR" })] },
    carried: false,
  },
];

describe("carried convergence: request tool and gate coordination detector agree", () => {
  for (const { name, fixture, carried, root, bodyDisposition = false, nextAction = PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW } of CASES) {
    it(name, async () => {
      const options = root === "wide" ? { root: wideRoot } : {};
      const request = await runRequestTool(scenario(fixture), options);
      const detected = await runDetector(scenario(fixture), options);
      const suppressed = request.status === "suppressed_post_convergence_docs_only";
      assert.equal(suppressed, carried, `request tool status ${request.status}`);
      assert.equal(detected.carriedConvergence !== null, carried);
      assert.equal(suppressed, detected.carriedConvergence !== null, "request tool and detector must agree");
      if (carried) {
        assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
        assert.ok(detected.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
        assert.equal(detected.carriedConvergence.source, "carried");
        assert.equal(detected.carriedConvergence.sourceReviewId, "PRR_prior");
        assert.equal(detected.carriedConvergence.sourceHeadSha, PRIOR);
        assert.equal(typeof detected.carriedConvergence.reason, "string");
        assert.equal(detected.carriedConvergence.bodyDisposition !== null, bodyDisposition);
      } else {
        assert.equal(request.status, "requested");
        assert.equal(detected.nextAction, nextAction);
        assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
      }
    });
  }
});

test("upsert-checkpoint-verdict's gate-entry check accepts pre_approval_gate for the resolved-thread docs-only shape", async () => {
  const fixture = scenario({ threads: [thread({ isResolved: true })] });
  const { runtime } = runtimeFor(detectorEntries(fixture));
  const coordinationContext = await loadPrGateCoordinationContext({ repo: REPO, pr: PR }, runtime);
  assert.equal(coordinationContext.postConvergenceReviewSuppressed, true);
  const coordination = evaluatePrGateCoordination(buildCoordinationEvaluatorInput({
    coordinationContext,
    maxCopilotRounds: 2,
    draftGateConfig: resolveGateConfig({}, "draft"),
    preApprovalGateConfig: resolveGateConfig({}, "preApproval"),
    reviewMode: null,
  }));
  assert.ok(coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  assert.ok(!coordination.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
});

test("resolveCarriedConvergence refuses without a gh call when a request is outstanding or a thread is unresolved", async () => {
  const { runChild, calls } = makeGhMock([]);
  const prData = { reviews: scenario().reviews };
  const base = { repo: REPO, pr: PR, currentHeadSha: HEAD, prData, reviewThreads: [] };
  assert.equal((await resolveCarriedConvergence({ ...base, copilotReviewRequestStatus: "requested", unresolvedThreadCount: 0 }, { runChild })).carried, false);
  assert.equal((await resolveCarriedConvergence({ ...base, copilotReviewRequestStatus: "none", unresolvedThreadCount: 1 }, { runChild })).carried, false);
  assert.equal(calls.length, 0);
});

// Round cap (cap = 2): two Copilot rounds on the current head, the latest a
// body-only changes-recommended review with no thread.
function capReviews() {
  return [
    { id: "PRR_round1", author: { login: COPILOT }, state: "COMMENTED", body: "", commit: { oid: HEAD }, submittedAt: "2026-09-22T10:00:00Z" },
    { id: "PRR_round2", author: { login: COPILOT }, state: "COMMENTED", body: YELLOW, commit: { oid: HEAD }, submittedAt: "2026-09-22T11:00:00Z" },
  ];
}

function capFixture(dispositions = []) {
  return {
    reviews: capReviews(),
    shared: [
      { matchByClaims: true, assertArgs: ["api", "graphql"], assertArgContains: ["reviewThreads"], stdout: line({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) },
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`, "--jq", ".[]"], stdout: dispositions.map(line).join("") },
    ],
  };
}

const CAP_CASES = [
  { name: "no disposition record", dispositions: [], cleared: false },
  { name: "trusted operator record for the current head", dispositions: [dispositionComment({ reviewId: "PRR_round2" })], cleared: true },
  // The finding sits on a current-head review, so no fix commit can be after it: only the operator form clears.
  // The compare from the review commit (HEAD) to FIX reports `behind`.
  { name: "trusted fix record for a current-head review", dispositions: [dispositionComment({ reviewId: "PRR_round2", kind: FIX })], extra: [compareEntry(HEAD, FIX, "behind")], cleared: false },
  { name: "record for a stale head", dispositions: [dispositionComment({ reviewId: "PRR_round2", head: PRIOR })], cleared: false },
  { name: "record naming a different review", dispositions: [dispositionComment({ reviewId: "PRR_round1" })], cleared: false },
  { name: "record by an untrusted author", dispositions: [dispositionComment({ reviewId: "PRR_round2", association: "NONE" })], cleared: false },
  { name: "record by a bot", dispositions: [dispositionComment({ reviewId: "PRR_round2", login: "helper[bot]", type: "Bot" })], cleared: false },
];

describe("round cap: body-only Copilot feedback clears only through a recorded disposition", () => {
  for (const { name, dispositions, extra = [], cleared } of CAP_CASES) {
    it(`gate coordination detector: ${name}`, async () => {
      const detected = await runDetector(capFixture(dispositions), { extra });
      if (cleared) {
        assert.equal(detected.lifecycleState, "round_cap_clean_fallback");
        assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
        assert.equal(detected.copilotBodyDisposition.reviewId, "PRR_round2");
        assert.equal(detected.copilotBodyDisposition.headSha, HEAD);
      } else {
        assert.notEqual(detected.lifecycleState, "round_cap_clean_fallback");
        assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
        assert.equal(detected.copilotBodyDisposition, null);
      }
      assert.deepEqual(detected.copilotBodyDispositionRequired, cleared ? null : {
        reviewId: "PRR_round2",
        reviewCommitSha: HEAD,
        reason: "the current-head Copilot review carries body feedback with no trusted operator copilot-body-disposition record",
      });
    });

    it(`copilot loop detector: ${name}`, async () => {
      const fixture = capFixture(dispositions);
      const { runChild, unmatched } = strictRunChild([
        { matchByClaims: true, assertArgs: ["pr", "view", String(PR)], stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], reviews: fixture.reviews }) },
        ...fixture.shared,
        ...extra,
      ]);
      const snapshot = await autoDetectSnapshot({ repo: REPO, pr: PR, reviewRequestStatusOverride: "none" }, { env: {}, ghCommand: "gh", runChild });
      assert.deepEqual(unmatched, []);
      assert.equal(snapshot.copilotBodyFeedbackUnresolved, !cleared);
      const interpretation = interpretLoopState(snapshot, { maxCopilotRounds: 2 });
      assert.equal(interpretation.state === "round_cap_clean_fallback", cleared);
    });
  }
});

describe("copilot-body-disposition record format and trust rule", () => {
  it("parses the fix and operator forms and rejects malformed markers", () => {
    assert.deepEqual(parseCopilotBodyDispositionMarker(`<!-- dev-loops:copilot-body-disposition review=R1 head=${HEAD} fix=${FIX} -->`), { reviewId: "R1", headSha: HEAD, fixSha: FIX, operator: false });
    assert.deepEqual(parseCopilotBodyDispositionMarker(`<!-- dev-loops:copilot-body-disposition review=R1 head=${HEAD} operator -->`), { reviewId: "R1", headSha: HEAD, fixSha: null, operator: true });
    assert.equal(parseCopilotBodyDispositionMarker(`<!-- dev-loops:copilot-body-disposition review=R1 head=abc operator -->`), null);
    assert.equal(parseCopilotBodyDispositionMarker(`<!-- dev-loops:copilot-body-disposition review=R1 head=${HEAD} -->`), null);
  });

  it("trusts only OWNER/MEMBER/COLLABORATOR humans", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      assert.equal(isTrustedDispositionAuthor({ user: { login: "maintainer", type: "User" }, author_association: association }), true);
    }
    assert.equal(isTrustedDispositionAuthor({ user: { login: "drive-by", type: "User" }, author_association: "CONTRIBUTOR" }), false);
    assert.equal(isTrustedDispositionAuthor({ user: { login: "Copilot", type: "User" }, author_association: "OWNER" }), false);
    assert.equal(isTrustedDispositionAuthor({ user: { login: "helper[bot]", type: "Bot" }, author_association: "OWNER" }), false);
  });

  it("does not clear on an unreadable comment stream or an uncontained fix commit", async () => {
    const failing = makeGhMock([{ assertArgs: ["api"], exitCode: 1, stdout: "", stderr: "boom" }]);
    assert.equal((await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1" }, { runChild: failing.runChild })).cleared, false);
    const uncontained = makeGhMock([
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`], stdout: line(dispositionComment({ reviewId: "R1", kind: FIX })) },
      compareEntry(PRIOR, FIX, "ahead"),
      compareEntry(FIX, HEAD, "diverged"),
    ]);
    assert.equal((await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1", reviewCommitSha: PRIOR }, { runChild: uncontained.runChild })).cleared, false);
  });

  it("does not clear when the comment stream holds a malformed line beside a trusted operator record", async () => {
    const { runChild } = makeGhMock([
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`], stdout: `{not json\n${line(dispositionComment({ reviewId: "R1" }))}` },
    ]);
    const record = await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1" }, { runChild });
    assert.equal(record.cleared, false);
    assert.match(record.reason, /unreadable/);
  });

  it("clears on a fix commit strictly after the review commit and contained in the head", async () => {
    const { runChild } = makeGhMock([
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`], stdout: line(dispositionComment({ reviewId: "R1", kind: FIX })) },
      ...FIX_AFTER_PRIOR,
    ]);
    assert.equal((await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1", reviewCommitSha: PRIOR }, { runChild })).cleared, true);
  });

  it("refuses a fix record naming the review commit itself, without a compare call", async () => {
    const { runChild, calls } = makeGhMock([
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`], stdout: line(dispositionComment({ reviewId: "R1", kind: PRIOR })) },
    ]);
    assert.equal((await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1", reviewCommitSha: PRIOR }, { runChild })).cleared, false);
    assert.equal(calls.filter((call) => call.args.some((arg) => arg.includes("/compare/"))).length, 0);
  });

  it("refuses a fix record naming a base commit that is not after the review commit", async () => {
    const BASE = "e".repeat(40);
    const { runChild } = makeGhMock([
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`], stdout: line(dispositionComment({ reviewId: "R1", kind: BASE })) },
      compareEntry(PRIOR, BASE, "behind"),
      compareEntry(BASE, HEAD, "ahead"),
    ]);
    assert.equal((await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1", reviewCommitSha: PRIOR }, { runChild })).cleared, false);
  });

  it("ignores a marker inside a fenced code block, an inline code span, or a quote line", () => {
    const marker = `<!-- dev-loops:copilot-body-disposition review=R1 head=${HEAD} operator -->`;
    assert.equal(parseCopilotBodyDispositionMarker(["Example:", "```", marker, "```"].join("\n")), null);
    assert.equal(parseCopilotBodyDispositionMarker(`Use \`${marker}\` to disposition.`), null);
    assert.equal(parseCopilotBodyDispositionMarker(`> ${marker}`), null);
    assert.notEqual(parseCopilotBodyDispositionMarker(`Recorded.\n${marker}`), null);
  });
});

describe("operator-marker suppression records its carried convergence", () => {
  async function withMarker(fn) {
    const markerDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-operator-marker-"));
    try {
      await writeSuppressionMarker(
        { repo: REPO, pr: PR, headSha: HEAD, lastReviewedHeadSha: PRIOR, reason: "pure doc/prose bump" },
        { checkpointDir: markerDir },
      );
      await fn(markerDir);
    } finally {
      await rm(markerDir, { recursive: true, force: true });
    }
  }

  it("reports carriedConvergence with source marker and the source review and head", async () => {
    await withMarker(async (markerDir) => {
      const detected = await runDetector(scenario(), { markerDir });
      assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
      assert.equal(detected.carriedConvergence.source, "marker");
      assert.equal(detected.carriedConvergence.sourceReviewId, "PRR_prior");
      assert.equal(detected.carriedConvergence.sourceHeadSha, PRIOR);
    });
  });

  it("does not suppress a body-only changes-recommended prior review with no own thread and no record", async () => {
    await withMarker(async (markerDir) => {
      // The marker path and the carry predicate each read the shared facts.
      const fixture = scenario({ priorBody: YELLOW, extraShared: scenario({ priorBody: YELLOW }).shared });
      const markerCarry = await resolvePostConvergenceReviewSuppressed(
        { repo: REPO, pr: PR, currentHeadSha: HEAD, prData: { reviews: fixture.reviews }, copilotReviewRequestStatus: "none", unresolvedThreadCount: 0, reviewThreads: [] },
        { ...runtimeFor(fixture.shared).runtime, checkpointDir: markerDir },
      );
      assert.equal(markerCarry.carried, false);
      const request = await runRequestTool(fixture, { markerDir });
      assert.equal(request.status, "requested");
    });
  });
});

describe("summarizeCopilotReviews body-finding owner on a timestamp tie", () => {
  const review = (id, body) => ({ id, author: { login: COPILOT }, state: "COMMENTED", body, commit: { oid: HEAD }, submittedAt: "2026-09-22T10:00:00Z" });

  it("names the one signaling review when a signaling and a clean review tie", () => {
    const summary = summarizeCopilotReviews([review("R_clean", ""), review("R_yellow", YELLOW)], { headSha: HEAD });
    assert.equal(summary.hasBodyFindingOnCurrentHead, true);
    assert.equal(summary.bodyFindingReviewId, "R_yellow");
  });

  it("names no review when two signaling reviews tie, so no record can clear the finding", () => {
    const summary = summarizeCopilotReviews([review("R_a", YELLOW), review("R_b", YELLOW)], { headSha: HEAD });
    assert.equal(summary.hasBodyFindingOnCurrentHead, true);
    assert.equal(summary.bodyFindingReviewId, null);
  });
});

describe("current-head body finding: request tool and detector agree through the shared resolver", () => {
  const headYellow = [{ id: "PRR_head", author: { login: COPILOT }, state: "COMMENTED", body: YELLOW, commit: { oid: HEAD }, submittedAt: "2026-09-22T10:00:00Z" }];
  const fixture = (dispositions) => scenario({ reviews: headYellow, dispositions });

  it("an operator record settles the head: the tool does not re-request and the detector opens pre_approval_gate", async () => {
    const dispositions = [dispositionComment({ reviewId: "PRR_head" })];
    const request = await runRequestTool(fixture(dispositions), { root: wideRoot });
    const detected = await runDetector(fixture(dispositions), { root: wideRoot });
    assert.equal(request.status, "suppressed_same_head_clean");
    assert.equal(detected.copilotBodyDisposition.reviewId, "PRR_head");
    assert.ok(!detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
    assert.notEqual(detected.nextAction, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW);
  });

  it("without a record the body finding stays unresolved in both", async () => {
    const request = await runRequestTool(fixture([]), { root: wideRoot });
    const detected = await runDetector(fixture([]), { root: wideRoot });
    assert.notEqual(request.status, "suppressed_same_head_clean");
    assert.equal(detected.copilotBodyDisposition, null);
    assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  });
});

// Round cap (cap = 2), earlier head: both rounds on PRIOR, the latest a
// body-only changes-recommended review with no thread; the head advanced to
// HEAD with a docs-only fix.
describe("round cap: an earlier-head body-only finding clears only through a recorded disposition", () => {
  const priorRounds = [
    { id: "PRR_round1", author: { login: COPILOT }, state: "COMMENTED", body: "", commit: { oid: PRIOR }, submittedAt: "2026-09-22T10:00:00Z" },
    { id: "PRR_round2", author: { login: COPILOT }, state: "COMMENTED", body: YELLOW, commit: { oid: PRIOR }, submittedAt: "2026-09-22T11:00:00Z" },
  ];
  const PRIOR_CAP_CASES = [
    { name: "no disposition record", dispositions: [], cleared: false },
    // The resolver and the carry predicate each verify the fix commit.
    { name: "trusted fix record after the review commit", dispositions: [dispositionComment({ reviewId: "PRR_round2", kind: FIX })], extra: [...FIX_AFTER_PRIOR, ...FIX_AFTER_PRIOR], cleared: true },
    { name: "trusted operator record for the current head", dispositions: [dispositionComment({ reviewId: "PRR_round2" })], cleared: true },
    { name: "operator record naming the earlier clean review", dispositions: [dispositionComment({ reviewId: "PRR_round1" })], cleared: false },
    // A significant code fix opens a new Copilot cycle without a record. The
    // significant-change check reads the delta a second time.
    {
      name: "no record, significant code fix after the review",
      dispositions: [],
      delta: SIGNIFICANT_CODE_DELTA,
      extra: [{ matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${PRIOR}...${HEAD}`], stdout: line(SIGNIFICANT_CODE_DELTA) }],
      files: [{ path: "scripts/loop/foo.mjs" }],
      cleared: false,
      reopened: true,
    },
  ];
  for (const { name, dispositions, extra = [], delta, files, cleared, reopened = false } of PRIOR_CAP_CASES) {
    const fixture = () => scenario({ reviews: priorRounds, dispositions, extraShared: extra, ...(delta ? { delta } : {}) });

    it(`gate coordination detector: ${name}`, async () => {
      const detected = await runDetector(fixture(), { files });
      if (reopened) {
        assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW);
        assert.ok(detected.allowedNextActions.includes(PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW));
        assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
        assert.equal(detected.carriedConvergence, null);
      } else if (cleared) {
        assert.equal(detected.lifecycleState, "round_cap_clean_fallback");
        assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
        assert.equal(detected.copilotBodyDispositionRequired, null);
        assert.equal(detected.copilotBodyDisposition.reviewId, "PRR_round2");
        assert.equal(detected.copilotBodyDisposition.headSha, HEAD);
      } else {
        assert.equal(detected.lifecycleState, "round_cap_reached");
        assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
        assert.equal(detected.carriedConvergence, null);
        // The output names the sanctioned exit: a record for this review.
        assert.deepEqual(detected.copilotBodyDispositionRequired, {
          reviewId: "PRR_round2",
          reviewCommitSha: PRIOR,
          reason: "the latest Copilot review, on an earlier head, carries body-only feedback with no trusted copilot-body-disposition record",
        });
      }
    });

    it(`copilot loop detector: ${name}`, async () => {
      const { reviews, shared } = fixture();
      const { runChild } = makeGhMock([
        { matchByClaims: true, assertArgs: ["pr", "view", String(PR)], stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], reviews }) },
        ...shared,
      ]);
      const snapshot = await autoDetectSnapshot({ repo: REPO, pr: PR, reviewRequestStatusOverride: "none" }, { env: {}, ghCommand: "gh", runChild });
      assert.equal(snapshot.copilotBodyFeedbackUnresolved, false);
      assert.equal(snapshot.copilotPriorHeadBodyFeedbackUnresolved, !cleared);
      const interpretation = interpretLoopState({ ...snapshot, ciStatus: "success" }, { maxCopilotRounds: 2 });
      assert.equal(interpretation.state, cleared ? "round_cap_clean_fallback" : "round_cap_reached");
      // Every row stays open to a new cycle on a significant post-convergence change.
      assert.equal(interpretation.roundCapReopenEligible, true);
      // Below the cap the earlier-head finding does not change routing: a fresh
      // Copilot review can still supersede it.
      assert.notEqual(interpretLoopState({ ...snapshot, ciStatus: "success" }, { maxCopilotRounds: 5 }).state, "round_cap_reached");
    });

    it(`request tool never re-requests: ${name}`, async () => {
      const request = await runRequestTool(fixture());
      assert.equal(request.status, "round_cap_reached");
    });
  }
});

// At the cap, each blocker other than the earlier-head body finding keeps the
// cycle closed: a significant change must not reopen Copilot past it.
describe("round cap: an earlier-head body finding reopens a cycle only on an otherwise clean head", () => {
  const capSnapshot = {
    prExists: true,
    prNumber: PR,
    currentHeadSha: HEAD,
    copilotReviewPresent: true,
    copilotReviewRoundCount: 2,
    ciStatus: "success",
    copilotPriorHeadBodyFeedbackUnresolved: true,
  };
  const BLOCKERS = [
    { name: "an unresolved thread", patch: { unresolvedThreadCount: 1 }, state: "round_cap_reached" },
    { name: "a current-head body finding", patch: { copilotBodyFeedbackUnresolved: true }, state: "round_cap_reached" },
    { name: "non-green CI", patch: { ciStatus: "failure" }, state: "round_cap_reached" },
    // An in-flight request leaves the not-clean cap to the normal routing.
    { name: "a review in flight", patch: { copilotReviewRequestStatus: "requested" }, state: null },
  ];

  it("the earlier-head body finding alone is reopen-eligible", () => {
    const interpretation = interpretLoopState(capSnapshot, { maxCopilotRounds: 2 });
    assert.equal(interpretation.state, "round_cap_reached");
    assert.equal(interpretation.roundCapReopenEligible, true);
  });

  for (const { name, patch, state } of BLOCKERS) {
    it(`${name} blocks the reopen`, () => {
      const interpretation = interpretLoopState({ ...capSnapshot, ...patch }, { maxCopilotRounds: 2 });
      if (state) assert.equal(interpretation.state, state);
      else assert.notEqual(interpretation.state, "round_cap_clean_fallback");
      assert.equal(interpretation.roundCapReopenEligible, false);
    });
  }
});

describe("latest-review timestamp tie fails closed", () => {
  const tied = (id, body) => ({ id, author: { login: COPILOT }, state: "COMMENTED", body, commit: { oid: PRIOR }, submittedAt: "2026-09-22T10:00:00Z" });
  const carry = async (reviews, dispositions = []) => {
    const fixture = scenario({ reviews, dispositions });
    const { runtime } = runtimeFor(fixture.shared, { root: wideRoot });
    return resolveCarriedConvergence(
      { repo: REPO, pr: PR, currentHeadSha: HEAD, prData: { reviews }, copilotReviewRequestStatus: "none", unresolvedThreadCount: 0, reviewThreads: [] },
      runtime,
    );
  };

  it("a changes-recommended review tied with a clean one blocks the carry in either array order", async () => {
    assert.equal((await carry([tied("R_clean", ""), tied("R_yellow", YELLOW)])).carried, false);
    assert.equal((await carry([tied("R_yellow", YELLOW), tied("R_clean", "")])).carried, false);
  });

  it("names the blocking review as the latest, and flags two tied blocking reviews as ambiguous", () => {
    assert.equal(resolveLatestCopilotReview({ reviews: [tied("R_yellow", YELLOW), tied("R_clean", "")] }).review.id, "R_yellow");
    const ambiguous = resolveLatestCopilotReview({ reviews: [tied("R_a", YELLOW), tied("R_b", YELLOW)] });
    assert.equal(ambiguous.ambiguousBlockingTie, true);
  });

  it("orders by the raw submittedAt string, as summarizeCopilotReviews does, so a malformed later timestamp keeps the blocking review", () => {
    const clean = tied("R_clean", "");
    const malformed = { ...tied("R_yellow", YELLOW), submittedAt: "not-a-timestamp" };
    assert.equal(resolveLatestCopilotReview({ reviews: [malformed, clean] }).review.id, "R_yellow");
  });

  it("treats reviews that all lack a timestamp as tied, so a blocking one wins in either array order", () => {
    const untimed = (id, body) => ({ ...tied(id, body), submittedAt: undefined });
    assert.equal(resolveLatestCopilotReview({ reviews: [untimed("R_yellow", YELLOW), untimed("R_clean", "")] }).review.id, "R_yellow");
    assert.equal(resolveLatestCopilotReview({ reviews: [untimed("R_clean", ""), untimed("R_yellow", YELLOW)] }).review.id, "R_yellow");
  });

  it("two tied clean reviews still carry", async () => {
    assert.equal((await carry([tied("R_a", ""), tied("R_b", "")])).carried, true);
  });

  it("a trusted record naming one of two tied changes-recommended reviews clears neither the carry nor the round-cap block", async () => {
    const reviews = [
      { id: "R_round1", author: { login: COPILOT }, state: "COMMENTED", body: "", commit: { oid: PRIOR }, submittedAt: "2026-09-22T09:00:00Z" },
      tied("R_a", YELLOW),
      tied("R_b", YELLOW),
    ];
    // Name the review the resolver selects, so only the tie guard refuses.
    const owner = resolveLatestCopilotReview({ reviews }).review.id;
    const dispositions = [dispositionComment({ reviewId: owner })];
    const carried = await carry(reviews, dispositions);
    assert.equal(carried.carried, false);
    assert.match(carried.reason, /share a timestamp/);

    const { shared } = scenario({ reviews, dispositions });
    const { runChild } = makeGhMock([
      { matchByClaims: true, assertArgs: ["pr", "view", String(PR)], stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], reviews }) },
      ...shared,
    ]);
    const snapshot = await autoDetectSnapshot({ repo: REPO, pr: PR, reviewRequestStatusOverride: "none" }, { env: {}, ghCommand: "gh", runChild });
    assert.equal(snapshot.copilotPriorHeadBodyFeedbackUnresolved, true);
    assert.equal(interpretLoopState({ ...snapshot, ciStatus: "success" }, { maxCopilotRounds: 2 }).state, "round_cap_reached");
  });
});

test("resolveCarriedConvergence refuses a docs-only carry when the review-thread list is unreadable", async () => {
  const { reviews, shared } = scenario();
  const unreadable = shared.map((entry) => (entry.assertArgContains?.includes("reviewThreads") ? { ...entry, stdout: "", exitCode: 1 } : entry));
  const { runtime } = runtimeFor(unreadable, { root: wideRoot });
  const carried = await resolveCarriedConvergence(
    { repo: REPO, pr: PR, currentHeadSha: HEAD, prData: { reviews }, copilotReviewRequestStatus: "none" },
    runtime,
  );
  assert.deepEqual(carried, { carried: false, reason: "the review-thread list is unavailable" });
});

describe("fetchDeltaChangedFiles fails closed on a malformed compare payload", () => {
  const fetchFor = (payload) => fetchDeltaChangedFiles(
    { repo: REPO, base: PRIOR, head: HEAD },
    { env: {}, ghCommand: "gh", runChild: async () => ({ code: 0, stdout: line(payload) }) },
  );

  it("reads a well-formed delta", async () => {
    assert.deepEqual(await fetchFor(DOCS_DELTA), ["docs/guide.md"]);
  });

  it("returns null when the files array is missing or not an array", async () => {
    assert.equal(await fetchFor({ status: "ahead" }), null);
    assert.equal(await fetchFor({ status: "ahead", files: {} }), null);
  });

  it("returns null when any entry lacks a valid filename", async () => {
    assert.equal(await fetchFor({ status: "ahead", files: [{ filename: "docs/guide.md", status: "modified" }, { status: "modified" }] }), null);
    assert.equal(await fetchFor({ status: "ahead", files: [{ filename: "  ", status: "modified" }] }), null);
  });
});

// ── Converged-once default vs the strict opt-in ─────────────────────────────
//
// One fixture table drives the request tool, the gate coordination detector,
// and merge-pr under both values of
// refinement.requireCopilotConvergenceAtLatestHead, so the three agree on
// every head in both modes.

const BLUE = "### 🔵 Needs a closer look\n\nHave a look.";

// merge-pr reads REST-shaped reviews (node_id is the id a record names).
const toRestReview = (review) => ({ node_id: review.id, user: { login: review.author.login }, state: review.state, commit_id: review.commit.oid, body: review.body, submitted_at: review.submittedAt });

async function runMerge(fixture, { threads = [], delta = DOCS_DELTA, prOwn = delta, dispositions = [] }, { strict }) {
  const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
  const runChild = async (_cmd, args) => {
    const joined = args.join(" ");
    if (args[0] === "pr" && args[1] === "view" && joined.includes("mergeable")) {
      return ok({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "feat: converged-once", headRefOid: HEAD, url: "https://example.test/pr", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
    }
    if (args[0] === "pr" && args[1] === "view" && joined.includes("baseRefName")) return ok("main\n");
    if (args[0] === "pr" && args[1] === "view" && joined.includes("mergeCommit")) return ok({ mergeCommit: { oid: FIX }, state: "MERGED" });
    if (args[0] === "pr" && args[1] === "merge") return ok("");
    if (joined.includes(`pulls/${PR}/reviews`)) return ok([fixture.reviews.map(toRestReview)]);
    if (joined.includes(`issues/${PR}/comments?per_page`)) return ok([[]]);
    if (joined.includes(`issues/${PR}/comments`)) return ok(dispositions.map((d) => JSON.stringify(d)).join("\n"));
    if (joined.includes("requested_reviewers")) return ok({ users: [], teams: [] });
    if (args[1] === "graphql" && joined.includes("reviewThreads")) return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });
    if (args[1] === "graphql") return ok({ data: { repository: { pullRequest: { reviewRequests: { nodes: [] }, reviews: { nodes: [] } } } } });
    if (joined.includes(`compare/main...${HEAD}`)) return ok(prOwn);
    if (joined.includes(`compare/${PRIOR}...${HEAD}`)) return ok(delta);
    return { code: 97, stdout: "", stderr: `unexpected gh call: ${joined}` };
  };
  try {
    return await mergePr({ repo: REPO, pr: PR, humanApprovedBy: "maintainer", method: "squash", stableRelease: false, standingAuthorization: true }, {
      env: {},
      ghCommand: "gh",
      runChild,
      detectEvidence: async () => ({ ok: true, sizeOutcome: "pass", touchesT1: false, failures: [], currentHeadSha: HEAD, draftGate: null }),
      loadConfig: async () => ({ config: { refinement: { maxCopilotRounds: 5, requireCopilotConvergenceAtLatestHead: strict } }, errors: [] }),
      detectInternalOnlyPr: async () => ({ ok: true, internalOnly: false, files: [] }),
      cwd: process.cwd(),
      // No-op post-merge steps: the real ones would fast-forward and prune the test checkout.
      postMergeSteps: { fastForward: async () => null, worktreeCleanup: async () => null, actions: async () => null },
    });
  } catch (error) {
    if (error?.mergePrFailure) return error.mergePrFailure;
    throw error;
  }
}

const MODE_CASES = [
  { name: "clean review, code delta", fixture: { delta: CODE_DELTA }, once: true, strict: false },
  { name: "clean review, docs-only delta", fixture: {}, once: true, strict: true },
  { name: "needs-a-closer-look review, code delta", fixture: { priorBody: BLUE, delta: CODE_DELTA }, once: true, strict: false },
  { name: "changes-recommended review with its own resolved thread, code delta", fixture: { priorBody: YELLOW, delta: CODE_DELTA, threads: [thread({ isResolved: true, reviewId: "PRR_prior" })] }, once: true, strict: false },
  { name: "unrecognized review with a trusted operator record, code delta", fixture: { priorBody: "### 🟣 Something new\n\nBody.", delta: CODE_DELTA, dispositions: [dispositionComment({ reviewId: "PRR_prior" })] }, once: true, strict: false },
  { name: "body-only changes-recommended review, no thread, no record, code delta", fixture: { priorBody: YELLOW, delta: CODE_DELTA }, once: false, strict: false },
  { name: "clean review with an unresolved thread, code delta", fixture: { delta: CODE_DELTA, threads: [thread({ isResolved: false, reviewId: "PRR_prior" })] }, once: false, strict: false },
];

describe("loop and merge agree in both Copilot convergence modes", () => {
  for (const { name, fixture, once, strict: strictCarried } of MODE_CASES) {
    for (const strict of [false, true]) {
      const carried = strict ? strictCarried : once;
      const mode = strict ? "strict" : "converged-once";
      it(`${mode}: ${name}`, async () => {
        const root = strict ? wideRoot : convergedOnceWideRoot;
        const request = await runRequestTool(scenario(fixture), { root });
        const detected = await runDetector(scenario(fixture), { root });
        const merged = await runMerge(scenario(fixture), fixture, { strict });
        const expectedStatus = strict ? "suppressed_post_convergence_docs_only" : "suppressed_post_convergence";
        const expectedDisposition = strict ? "docs_only_suppression" : "converged_once";
        assert.equal(request.status === expectedStatus, carried, `request tool status ${request.status}`);
        assert.equal(detected.carriedConvergence !== null, carried, "detector carriedConvergence");
        assert.equal(merged.merged === true, carried, `merge ${JSON.stringify(merged.failures ?? merged.copilotDisposition)}`);
        if (carried) {
          const source = strict ? "carried" : "converged_once";
          assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
          assert.equal(detected.carriedConvergence.source, source);
          assert.equal(merged.copilotDisposition, expectedDisposition);
          assert.equal(merged.copilotConvergenceState, "no_current_head_review");
          assert.equal(merged.copilotCarriedConvergence.source, source);
          for (const carry of [detected.carriedConvergence, merged.copilotCarriedConvergence]) {
            assert.equal(carry.sourceReviewId, "PRR_prior");
            assert.equal(carry.sourceHeadSha, PRIOR);
          }
        } else {
          assert.notEqual(request.status, "suppressed_post_convergence");
          assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
          assert.ok(merged.failures.some((failure) => failure.precondition === "copilot_convergence"));
        }
      });
    }
  }
});

// The handoff reads the loop snapshot first, then calls the request tool.
function handoffEntries(fixture) {
  const ciRun = { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" };
  return [
    { matchByClaims: true, assertArgs: ["pr", "view", String(PR), "--repo", REPO], assertArgContains: ["baseRefName"], stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, reviews: fixture.reviews, statusCheckRollup: [ciRun] }) },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [], teams: [] }) },
    { matchByClaims: true, assertArgs: ["api", "graphql"], stdout: line({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`], stdout: line({ check_runs: [ciRun] }) },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/commits/${HEAD}/status?per_page=100`], stdout: line({ statuses: [] }) },
    ...requestEntries(fixture),
  ];
}

async function runHandoffTool(fixture, { root }) {
  const { runChild, unmatched } = strictRunChild(handoffEntries(fixture));
  const result = await runHandoff({ repo: REPO, pr: PR }, { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "", GH_SEQUENCE_PATH: "1" }), ghCommand: "gh", runChild, repoRoot: root });
  assert.deepEqual(unmatched, [], "handoff made an undeclared gh call");
  return result;
}

describe("below the cap, the handoff, the detector, and merge agree on a post-convergence suppression", () => {
  const ROWS = [
    { mode: "converged-once", fixture: { delta: CODE_DELTA }, strict: false, status: "suppressed_post_convergence", flag: "suppressedPostConvergence" },
    { mode: "strict", fixture: {}, strict: true, status: "suppressed_post_convergence_docs_only", flag: "suppressedPostConvergenceDocsOnly" },
  ];
  for (const { mode, fixture, strict, status, flag } of ROWS) {
    it(`${mode}: the handoff routes to pre_approval_gate, never to a re-request`, async () => {
      const root = strict ? wideRoot : convergedOnceWideRoot;
      const handoff = await runHandoffTool(scenario(fixture), { root });
      const detected = await runDetector(scenario(fixture), { root });
      const merged = await runMerge(scenario(fixture), fixture, { strict });

      assert.equal(handoff.reviewRequestStatus, status);
      assert.equal(handoff[flag], true);
      assert.equal(handoff.action, "stop");
      assert.equal(handoff.terminal, true);
      assert.equal(handoff.loopDisposition, "done");
      assert.notEqual(handoff.state, "ready_to_rerequest_review");
      assert.match(handoff.nextAction, /pre_approval_gate/);
      assert.doesNotMatch(handoff.nextAction, /Re-request/);
      assert.equal(handoff.requestWatchContract.requestStatus, "none");
      assert.notEqual(handoff.requestWatchContract.routingState, "ready_state_needs_copilot_request");

      assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
      assert.equal(merged.merged, true, JSON.stringify(merged.failures));
    });
  }
});

describe("converged-once: the detector routes a post-convergence change to pre_approval_gate below and at the cap", () => {
  const NEVER = [PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW, PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW, PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW];
  const clean = (id, submittedAt) => ({ id, author: { login: COPILOT }, state: "COMMENTED", body: "", commit: { oid: PRIOR }, submittedAt });
  // The strict run reads the delta a second time for the significant-change check.
  const reread = [{ matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${PRIOR}...${HEAD}`], stdout: line(SIGNIFICANT_CODE_DELTA) }];
  const fixture = (reviews) => scenario({ reviews, delta: SIGNIFICANT_CODE_DELTA, extraShared: reread });
  const files = [{ path: "scripts/loop/foo.mjs" }];

  for (const [label, reviews, root] of [
    ["below the cap", [clean("PRR_prior", "2026-09-22T10:00:00Z")], () => convergedOnceWideRoot],
    ["at the cap", [clean("PRR_round1", "2026-09-22T09:00:00Z"), clean("PRR_prior", "2026-09-22T10:00:00Z")], () => convergedOnceCapRoot],
  ]) {
    it(label, async () => {
      const detected = await runDetector(fixture(reviews), { root: root(), files });
      assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
      assert.ok(detected.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
      for (const action of NEVER) assert.ok(!detected.allowedNextActions.includes(action), action);
      assert.equal(detected.carriedConvergence.source, "converged_once");
      assert.equal(detected.carriedConvergence.sourceReviewId, "PRR_prior");
    });
  }

  it("a ruleset auto-review with no formal Copilot request still routes to pre_approval_gate", async () => {
    const detected = await runDetector(fixture([clean("PRR_prior", "2026-09-22T10:00:00Z")]), { root: convergedOnceWideRoot, files, formallyRequested: false });
    assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
    for (const action of NEVER) assert.ok(!detected.allowedNextActions.includes(action), action);
    assert.equal(detected.carriedConvergence.source, "converged_once");
  });

  it("strict mode at the cap still reopens the cycle on a significant change", async () => {
    const detected = await runDetector(fixture([clean("PRR_round1", "2026-09-22T09:00:00Z"), clean("PRR_prior", "2026-09-22T10:00:00Z")]), { files });
    assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW);
    assert.equal(detected.carriedConvergence, null);
  });

  it("the checkpoint-verdict gate-entry re-check accepts pre_approval_gate after a code change", async () => {
    const { runtime } = runtimeFor(detectorEntries(fixture([clean("PRR_prior", "2026-09-22T10:00:00Z")])), { root: convergedOnceWideRoot });
    const coordinationContext = await loadPrGateCoordinationContext({ repo: REPO, pr: PR }, runtime);
    assert.equal(coordinationContext.postConvergenceReviewSuppressed, true);
    const coordination = evaluatePrGateCoordination(buildCoordinationEvaluatorInput({
      coordinationContext,
      maxCopilotRounds: 5,
      draftGateConfig: resolveGateConfig({}, "draft"),
      preApprovalGateConfig: resolveGateConfig({}, "preApproval"),
      reviewMode: null,
    }));
    assert.ok(coordination.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
    assert.ok(!coordination.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
  });
});

describe("converged-once: a later Copilot review wins over an earlier convergence", () => {
  const cleanOlder = { ...OLDER_REVIEW, body: "### 🟢 Approval recommended" };
  const later = (isResolved) => ({ olderReviews: [cleanOlder], priorBody: YELLOW, delta: CODE_DELTA, threads: [thread({ isResolved, reviewId: "PRR_prior" })] });

  it("the detector and merge refuse while the later review's thread is unresolved", async () => {
    const detected = await runDetector(scenario(later(false)), { root: convergedOnceWideRoot });
    assert.equal(detected.carriedConvergence, null);
    assert.ok(detected.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
    const merged = await runMerge(scenario(later(false)), later(false), { strict: false });
    assert.equal(merged.merged, false);
    assert.ok(merged.failures.some((failure) => failure.precondition === "copilot_convergence"));
  });

  it("both pass once the thread is resolved, naming the later review", async () => {
    const detected = await runDetector(scenario(later(true)), { root: convergedOnceWideRoot });
    assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
    assert.equal(detected.carriedConvergence.sourceReviewId, "PRR_prior");
    const merged = await runMerge(scenario(later(true)), later(true), { strict: false });
    assert.equal(merged.merged, true);
    assert.equal(merged.copilotDisposition, "converged_once");
    assert.equal(merged.copilotCarriedConvergence.sourceReviewId, "PRR_prior");
  });

  it("a clean current-head review does not stand over a later body-only changes-recommended review on an earlier commit until a record names it", async () => {
    const currentHeadClean = { id: "PRR_head", author: { login: COPILOT }, state: "COMMENTED", body: "", commit: { oid: HEAD }, submittedAt: "2026-09-22T09:30:00Z" };
    const laterYellow = { id: "PRR_prior", author: { login: COPILOT }, state: "COMMENTED", body: YELLOW, commit: { oid: PRIOR }, submittedAt: "2026-09-22T10:00:00Z" };
    const shape = (dispositions) => ({ reviews: [currentHeadClean, laterYellow], delta: CODE_DELTA, dispositions });

    const blocked = await runDetector(scenario(shape([])), { root: convergedOnceWideRoot });
    assert.ok(blocked.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
    for (const action of [PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW, PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW]) {
      assert.ok(!blocked.allowedNextActions.includes(action), action);
    }
    assert.equal(blocked.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
    assert.equal(blocked.copilotBodyDispositionRequired.reviewId, "PRR_prior");
    const refused = await runMerge(scenario(shape([])), shape([]), { strict: false });
    assert.equal(refused.merged, false);
    assert.ok(refused.failures.some((failure) => failure.precondition === "copilot_convergence"));

    const recorded = shape([dispositionComment({ reviewId: "PRR_prior" })]);
    const opened = await runDetector(scenario(recorded), { root: convergedOnceWideRoot });
    assert.equal(opened.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
    const merged = await runMerge(scenario(recorded), recorded, { strict: false });
    assert.equal(merged.merged, true, JSON.stringify(merged.failures));
  });
});

describe("resolveCarriedConvergence converged-once predicate", () => {
  const carry = async (fixture, extra = {}) => {
    const { reviews, shared } = scenario(fixture);
    const { runtime, calls } = runtimeFor(shared);
    const result = await resolveCarriedConvergence(
      { repo: REPO, pr: PR, currentHeadSha: HEAD, prData: { reviews }, copilotReviewRequestStatus: "none", ...extra },
      runtime,
    );
    return { result, calls };
  };

  it("carries a clean latest review across a code delta without a compare call", async () => {
    const { result, calls } = await carry({ delta: CODE_DELTA });
    assert.equal(result.carried, true);
    assert.equal(result.source, "converged_once");
    assert.equal(result.sourceReviewId, "PRR_prior");
    assert.equal(result.sourceHeadSha, PRIOR);
    assert.equal(calls.some((call) => call.args.some((arg) => String(arg).includes("/compare/"))), false);
  });

  it("carries the three converged shapes: needs-a-closer-look, own resolved thread, trusted record", async () => {
    assert.equal((await carry({ priorBody: BLUE, delta: CODE_DELTA })).result.carried, true);
    assert.equal((await carry({ priorBody: YELLOW, delta: CODE_DELTA, threads: [thread({ isResolved: true, reviewId: "PRR_prior" })] })).result.carried, true);
    const recorded = (await carry({ priorBody: YELLOW, delta: CODE_DELTA, dispositions: [dispositionComment({ reviewId: "PRR_prior" })] })).result;
    assert.equal(recorded.carried, true);
    assert.equal(recorded.bodyDisposition.reviewId, "PRR_prior");
  });

  it("refuses a never-reviewed PR, an unresolved thread, a body-only finding with no record, and an outstanding request", async () => {
    assert.equal((await carry({ reviews: [] })).result.carried, false);
    assert.equal((await carry({ delta: CODE_DELTA, threads: [thread({ isResolved: false })] })).result.carried, false);
    assert.equal((await carry({ priorBody: YELLOW, delta: CODE_DELTA })).result.carried, false);
    assert.equal((await carry({ delta: CODE_DELTA }, { copilotReviewRequestStatus: "requested" })).result.carried, false);
  });

  it("strict mode keeps the docs-only delta condition", async () => {
    const strict = { requireCopilotConvergenceAtLatestHead: true };
    assert.equal((await carry({ delta: CODE_DELTA }, strict)).result.carried, false);
    const docs = (await carry({}, strict)).result;
    assert.equal(docs.carried, true);
    assert.equal(docs.source, "carried");
  });
});
