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
import { detectPrGateCoordinationState, loadPrGateCoordinationContext } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { autoDetectSnapshot } from "../../scripts/loop/detect-copilot-loop-state.mjs";
import { buildCoordinationEvaluatorInput } from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import {
  isTrustedDispositionAuthor,
  parseCopilotBodyDispositionMarker,
  resolveCopilotBodyDisposition,
} from "../../scripts/github/_copilot-body-disposition.mjs";
import { resolveCarriedConvergence, resolvePostConvergenceReviewSuppressed } from "../../scripts/loop/_copilot-convergence-carry.mjs";
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

let capRoot = null;
// Round cap 5: multi-round scenarios stay below the cap.
let wideRoot = null;
let checkpointDir = null;
beforeAll(async () => {
  capRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-"));
  wideRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-wide-"));
  const devloops = await readFile(path.resolve(".devloops"), "utf8");
  await writeFile(path.join(capRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, "maxCopilotRounds: 2"), "utf8");
  await writeFile(path.join(wideRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, "maxCopilotRounds: 5"), "utf8");
  checkpointDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-markers-"));
});
afterAll(async () => {
  await rm(capRoot, { recursive: true, force: true });
  await rm(wideRoot, { recursive: true, force: true });
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

// The single scenario table: prior Copilot review on PRIOR, current head HEAD.
function scenario({ priorBody = "", threads = [], delta = DOCS_DELTA, dispositions = [], olderReviews = [], extraShared = [] } = {}) {
  const reviews = [...olderReviews, { id: "PRR_prior", author: { login: COPILOT }, state: "COMMENTED", body: priorBody, commit: { oid: PRIOR }, submittedAt: "2026-09-22T10:00:00Z" }];
  const shared = [
    ...extraShared,
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${PRIOR}...${HEAD}`], stdout: line(delta) },
    { matchByClaims: true, assertArgs: ["api", "graphql"], assertArgContains: ["reviewThreads"], stdout: line({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } }) },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/issues/${PR}/comments`, "--jq", ".[]"], stdout: dispositions.map(line).join("") },
  ];
  return { reviews, shared };
}

function requestEntries({ reviews, shared }) {
  const prView = { matchByClaims: true, assertArgs: ["pr", "view", String(PR), "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: line({ headRefOid: HEAD, isDraft: false, state: "OPEN", number: PR, reviews }) };
  return [
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`, "-X", "POST"], stdout: line({ requested_reviewers: [{ login: COPILOT }] }) },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [], teams: [] }) },
    prView,
    ...shared,
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [{ login: "Copilot" }], teams: [] }) },
    prView,
  ];
}

function detectorEntries({ reviews, shared }, { extra = [] } = {}) {
  return [
    {
      matchByClaims: true,
      assertArgs: ["pr", "view", String(PR), "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
      stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], reviews }),
    },
    { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/pulls/${PR}/requested_reviewers`], stdout: line({ users: [], teams: [] }) },
    { matchByClaims: true, assertArgs: ["pr", "view", String(PR), "--json", "headRefOid"], stdout: line({ headRefOid: HEAD }) },
    {
      matchByClaims: true,
      assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`],
      stdout: line([[{
        id: 21,
        body: ["Gate review: draft_gate", `Reviewed head SHA: ${PRIOR}`, "Verdict: clean", "Findings summary: no issues found", "Next action: mark ready for review"].join("\n"),
        html_url: "https://example.test/comment/21",
        updated_at: "2026-09-22T09:00:00Z",
      }]]),
    },
    { matchByClaims: true, assertArgs: ["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${PR}/reviews?per_page=100`], stdout: "[]\n" },
    { matchByClaims: true, assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'], stdout: `${COPILOT}\n` },
    ...shared,
    ...extra,
  ];
}

function runtimeFor(entries, { root = capRoot, markerDir = checkpointDir } = {}) {
  const { runChild, calls } = makeGhMock(entries);
  return { runtime: { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", runChild, repoRoot: root, checkpointDir: markerDir }, calls };
}

async function runRequestTool(fixture, { root = capRoot, markerDir = checkpointDir } = {}) {
  const { runChild } = makeGhMock(requestEntries(fixture));
  return performCopilotReviewRequest(
    { repo: REPO, pr: PR, checkpointDir: markerDir },
    { env: { GH_SEQUENCE_PATH: "1" }, ghCommand: "gh", runChild, repoRoot: root, delayImpl: async () => {} },
  );
}

async function runDetector(fixture, options = {}) {
  const { runtime } = runtimeFor(detectorEntries(fixture, options), options);
  return detectPrGateCoordinationState({ repo: REPO, pr: PR }, runtime);
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
    fixture: { priorBody: YELLOW, dispositions: [dispositionComment({ reviewId: "PRR_prior", kind: FIX })], extraShared: FIX_AFTER_PRIOR },
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
  { name: "docs-only delta, body-only changes-recommended, no record", fixture: { priorBody: YELLOW }, carried: false },
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

const FIX_CONTAINED = { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${FIX}...${HEAD}`], stdout: line({ status: "ahead" }) };

const CAP_CASES = [
  { name: "no disposition record", dispositions: [], cleared: false },
  { name: "trusted operator record for the current head", dispositions: [dispositionComment({ reviewId: "PRR_round2" })], cleared: true },
  // The finding sits on a current-head review, so no fix commit can be after it: only the operator form clears.
  { name: "trusted fix record for a current-head review", dispositions: [dispositionComment({ reviewId: "PRR_round2", kind: FIX })], extra: [FIX_CONTAINED], cleared: false },
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
    });

    it(`copilot loop detector: ${name}`, async () => {
      const fixture = capFixture(dispositions);
      const { runChild } = makeGhMock([
        { matchByClaims: true, assertArgs: ["pr", "view", String(PR)], stdout: line({ number: PR, state: "OPEN", isDraft: false, headRefOid: HEAD, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], reviews: fixture.reviews }) },
        ...fixture.shared,
        ...extra,
      ]);
      const snapshot = await autoDetectSnapshot({ repo: REPO, pr: PR, reviewRequestStatusOverride: "none" }, { env: {}, ghCommand: "gh", runChild });
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
      const fixture = scenario({ priorBody: YELLOW });
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
