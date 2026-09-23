// Carried convergence and the Copilot body-disposition record.
//
// One fixture table drives BOTH request-copilot-review.mjs and
// detect-pr-gate-coordination-state.mjs, so the test proves the two agree on
// every head: the request tool suppresses a re-request exactly when the
// detector reports a carried convergence (and allows pre_approval_gate).
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
import { resolveCarriedConvergence } from "../../scripts/loop/_copilot-convergence-carry.mjs";
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
let checkpointDir = null;
beforeAll(async () => {
  capRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-"));
  const devloops = await readFile(path.resolve(".devloops"), "utf8");
  await writeFile(path.join(capRoot, ".devloops"), devloops.replace(/maxCopilotRounds: *\d+/, "maxCopilotRounds: 2"), "utf8");
  checkpointDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-carried-convergence-markers-"));
});
afterAll(async () => {
  await rm(capRoot, { recursive: true, force: true });
  await rm(checkpointDir, { recursive: true, force: true });
});

const line = (value) => `${JSON.stringify(value)}\n`;

function thread({ id = "thread-1", isResolved }) {
  return {
    id,
    isResolved,
    comments: { nodes: [{ id: `${id}-c1`, databaseId: 1001, body: "Tighten this sentence.", author: { login: "copilot-pull-request-reviewer", __typename: "Bot" } }] },
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

// The single scenario table: prior Copilot review on PRIOR, current head HEAD.
function scenario({ priorBody = "", threads = [], delta = DOCS_DELTA, dispositions = [] } = {}) {
  const reviews = [{ id: "PRR_prior", author: { login: COPILOT }, state: "COMMENTED", body: priorBody, commit: { oid: PRIOR }, submittedAt: "2026-09-22T10:00:00Z" }];
  const shared = [
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

function runtimeFor(entries) {
  const { runChild, calls } = makeGhMock(entries);
  return { runtime: { env: runIdFreeEnv({ DEVLOOPS_RUN_ID: "" }), ghCommand: "gh", runChild, repoRoot: capRoot, checkpointDir }, calls };
}

async function runRequestTool(fixture) {
  const { runChild } = makeGhMock(requestEntries(fixture));
  return performCopilotReviewRequest(
    { repo: REPO, pr: PR, checkpointDir },
    { env: { GH_SEQUENCE_PATH: "1" }, ghCommand: "gh", runChild, repoRoot: capRoot, delayImpl: async () => {} },
  );
}

async function runDetector(fixture, options) {
  const { runtime } = runtimeFor(detectorEntries(fixture, options));
  return detectPrGateCoordinationState({ repo: REPO, pr: PR }, runtime);
}

const CASES = [
  { name: "docs-only delta, one resolved thread (the observed deadlock shape)", fixture: { threads: [thread({ isResolved: true })] }, carried: true },
  { name: "docs-only delta, no thread, plain body", fixture: {}, carried: true },
  { name: "docs-only delta, changes-recommended body, its thread resolved", fixture: { priorBody: YELLOW, threads: [thread({ isResolved: true })] }, carried: true },
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
  for (const { name, fixture, carried, bodyDisposition = false, nextAction = PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW } of CASES) {
    it(name, async () => {
      const request = await runRequestTool(scenario(fixture));
      const detected = await runDetector(scenario(fixture));
      const suppressed = request.status === "suppressed_post_convergence_docs_only";
      assert.equal(suppressed, carried, `request tool status ${request.status}`);
      assert.equal(detected.carriedConvergence !== null, carried);
      assert.equal(suppressed, detected.carriedConvergence !== null, "request tool and detector must agree");
      if (carried) {
        assert.equal(detected.nextAction, PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE);
        assert.ok(detected.allowedNextActions.includes(PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE));
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
  const base = { repo: REPO, pr: PR, currentHeadSha: HEAD, prData, hasAnyThread: true };
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
  { name: "trusted fix record whose commit the head contains", dispositions: [dispositionComment({ reviewId: "PRR_round2", kind: FIX })], extra: [FIX_CONTAINED], cleared: true },
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
      { matchByClaims: true, assertArgs: ["api", `repos/${REPO}/compare/${FIX}...${HEAD}`], stdout: line({ status: "diverged" }) },
    ]);
    assert.equal((await resolveCopilotBodyDisposition({ repo: REPO, pr: PR, headSha: HEAD, reviewId: "R1" }, { runChild: uncontained.runChild })).cleared, false);
  });
});
