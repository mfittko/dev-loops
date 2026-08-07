import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCopilotReviewRequestStatus } from "../../scripts/loop/_copilot-review-request-status.mjs";

// Build a fake runChild that serves canned { code, stdout, stderr } based on
// which `gh api` endpoint the module requested. The module's two callers are:
//   - requested_reviewers: `repos/${repo}/pulls/${pr}/requested_reviewers`
//   - timeline:            `repos/${repo}/issues/${pr}/timeline` (--jq projection)
// The timeline endpoint emits newline-delimited JSON objects {login, created_at}.
function makeRunChild({ requestedReviewersPayload, timelineLines = [] }) {
  return async (command, args) => {
    const argStr = args.join(" ");
    if (argStr.includes("/requested_reviewers")) {
      return { code: 0, stdout: JSON.stringify(requestedReviewersPayload), stderr: "" };
    }
    if (argStr.includes("/timeline")) {
      return { code: 0, stdout: timelineLines.join("\n"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh call: ${argStr}` };
  };
}

const CTX = { repo: "owner/name", pr: 42 };
const REVIEW_TS = "2024-01-10T00:00:00Z";
const OLDER_REQ_TS = "2024-01-01T00:00:00Z";
const NEWER_REQ_TS = "2024-01-20T00:00:00Z";

const COPILOT_LOGIN = "Copilot";

function reviewers(login) {
  return { users: login ? [{ login }] : [] };
}

function timelineEvent(login, createdAt) {
  return JSON.stringify({ login, created_at: createdAt });
}

test("override passthrough returns override verbatim", async () => {
  for (const override of ["already-requested", "unavailable", "failed", "none", "requested"]) {
    const status = await resolveCopilotReviewRequestStatus(
      { ...CTX, reviewSummary: {}, reviewRequestStatusOverride: override },
      { runChild: makeRunChild({ requestedReviewersPayload: reviewers(COPILOT_LOGIN) }) },
    );
    assert.equal(status, override);
  }
});

test("pending current-head review is genuinely outstanding -> requested", async () => {
  const status = await resolveCopilotReviewRequestStatus(
    { ...CTX, reviewSummary: { hasPendingReviewOnCurrentHead: true }, copilotRequested: true },
    { runChild: makeRunChild({}) },
  );
  assert.equal(status, "requested");
});

test("not requested -> none", async () => {
  const status = await resolveCopilotReviewRequestStatus(
    { ...CTX, reviewSummary: {}, copilotRequested: false },
    { runChild: makeRunChild({}) },
  );
  assert.equal(status, "none");
});

test("requested, no submitted review on current head -> requested", async () => {
  const status = await resolveCopilotReviewRequestStatus(
    { ...CTX, reviewSummary: { hasSubmittedReviewOnCurrentHead: false }, copilotRequested: true },
    { runChild: makeRunChild({}) },
  );
  assert.equal(status, "requested");
});

test("stale request (request predates latest submitted review) -> none", async () => {
  const status = await resolveCopilotReviewRequestStatus(
    {
      ...CTX,
      reviewSummary: {
        hasSubmittedReviewOnCurrentHead: true,
        latestSubmittedReviewOnCurrentHeadAt: REVIEW_TS,
      },
      copilotRequested: true,
    },
    { runChild: makeRunChild({ requestedReviewersPayload: reviewers(COPILOT_LOGIN), timelineLines: [timelineEvent(COPILOT_LOGIN, OLDER_REQ_TS)] }) },
  );
  assert.equal(status, "none");
});

test("newer request (request after latest submitted review) -> requested", async () => {
  const status = await resolveCopilotReviewRequestStatus(
    {
      ...CTX,
      reviewSummary: {
        hasSubmittedReviewOnCurrentHead: true,
        latestSubmittedReviewOnCurrentHeadAt: REVIEW_TS,
      },
      copilotRequested: true,
    },
    { runChild: makeRunChild({ requestedReviewersPayload: reviewers(COPILOT_LOGIN), timelineLines: [timelineEvent(COPILOT_LOGIN, NEWER_REQ_TS)] }) },
  );
  assert.equal(status, "requested");
});

test("unknown request timestamp (timeline unavailable) fails closed -> requested", async () => {
  // timeline endpoint returns non-zero exit -> fetchLatestCopilotReviewRequestAt returns null
  const runChild = async (command, args) => {
    const argStr = args.join(" ");
    if (argStr.includes("/requested_reviewers")) {
      return { code: 0, stdout: JSON.stringify(reviewers(COPILOT_LOGIN)), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "boom" };
  };
  const status = await resolveCopilotReviewRequestStatus(
    {
      ...CTX,
      reviewSummary: {
        hasSubmittedReviewOnCurrentHead: true,
        latestSubmittedReviewOnCurrentHeadAt: REVIEW_TS,
      },
      copilotRequested: true,
    },
    { runChild },
  );
  assert.equal(status, "requested");
});

test("fail-closed: submitted review present but review timestamp missing -> requested (not none)", async () => {
  const status = await resolveCopilotReviewRequestStatus(
    {
      ...CTX,
      reviewSummary: {
        hasSubmittedReviewOnCurrentHead: true,
        latestSubmittedReviewOnCurrentHeadAt: null,
      },
      copilotRequested: true,
    },
    { runChild: makeRunChild({ requestedReviewersPayload: reviewers(COPILOT_LOGIN), timelineLines: [timelineEvent(COPILOT_LOGIN, NEWER_REQ_TS)] }) },
  );
  assert.equal(status, "requested");
});
