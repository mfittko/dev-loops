import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  COMPLETE_FIXER_DISPOSITION_ACTION,
  evaluateFixerDisposition,
  FIXER_DISPOSITION_FAILED_STEP,
  FIXER_DISPOSITION_FORBIDDEN_ACTIONS,
  normalizeFixerDispositionHandoff,
} from "../src/loop/fixer-disposition.mjs";
import { PR_CHECKPOINT_ACTION } from "../src/loop/pr-gate-coordination.mjs";

const SHA = "abc1234def5670000000000000000000000000000";

// ---------------------------------------------------------------------------
// normalizeFixerDispositionHandoff — AC row 1 (schema validation)
// ---------------------------------------------------------------------------

test("normalizeFixerDispositionHandoff throws on missing headSha", () => {
  assert.throws(() => normalizeFixerDispositionHandoff({ dispositions: [] }), /missing headSha/);
});

test("normalizeFixerDispositionHandoff throws on missing threadId", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({ headSha: SHA, dispositions: [{ fixingCommitSha: SHA, disposition: "tackled" }] }),
    /missing threadId/,
  );
});

test("normalizeFixerDispositionHandoff throws on missing fixingCommitSha", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({ headSha: SHA, dispositions: [{ threadId: "T1", disposition: "tackled" }] }),
    /missing fixingCommitSha/,
  );
});

test("normalizeFixerDispositionHandoff throws on missing disposition", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({ headSha: SHA, dispositions: [{ threadId: "T1", fixingCommitSha: SHA }] }),
    /missing disposition/,
  );
});

test("normalizeFixerDispositionHandoff throws when dispositions is not an array (string)", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({ headSha: SHA, dispositions: "nope" }),
    /dispositions must be an array/,
  );
});

test("normalizeFixerDispositionHandoff throws when dispositions is not an array (object)", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({ headSha: SHA, dispositions: {} }),
    /dispositions must be an array/,
  );
});

test("normalizeFixerDispositionHandoff treats absent dispositions as legitimately empty", () => {
  const normalized = normalizeFixerDispositionHandoff({ headSha: SHA });
  assert.deepEqual(normalized.dispositions, []);
});

test("normalizeFixerDispositionHandoff throws on an unrecognized disposition value (typo)", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({
      headSha: SHA,
      dispositions: [{ threadId: "T1", fixingCommitSha: SHA, disposition: "tacled" }],
    }),
    /unrecognized disposition: tacled/,
  );
});

test("normalizeFixerDispositionHandoff throws on duplicate threadId", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({
      headSha: SHA,
      dispositions: [
        { threadId: "T1", fixingCommitSha: SHA, disposition: "tackled" },
        { threadId: "T1", fixingCommitSha: SHA, disposition: "tackled" },
      ],
    }),
    /duplicate threadId: T1/,
  );
});

test("normalizeFixerDispositionHandoff throws on duplicate fingerprint", () => {
  assert.throws(
    () => normalizeFixerDispositionHandoff({
      headSha: SHA,
      dispositions: [
        { threadId: "T1", fingerprint: "fp1", fixingCommitSha: SHA, disposition: "tackled" },
        { threadId: "T2", fingerprint: "fp1", fixingCommitSha: SHA, disposition: "tackled" },
      ],
    }),
    /duplicate fingerprint: fp1/,
  );
});

test("normalizeFixerDispositionHandoff accepts a well-formed handoff", () => {
  const normalized = normalizeFixerDispositionHandoff({
    headSha: ` ${SHA} `,
    dispositions: [
      { threadId: "T1", fixingCommitSha: SHA, disposition: "TACKLED", validation: "unit tests pass" },
      { threadId: "T2", fixingCommitSha: SHA, disposition: "deferred" },
    ],
  });
  assert.equal(normalized.headSha, SHA);
  assert.equal(normalized.dispositions.length, 2);
  assert.equal(normalized.dispositions[0].disposition, "tackled");
  assert.equal(normalized.dispositions[0].validation, "unit tests pass");
  assert.equal(normalized.dispositions[1].fingerprint, null);
});

// ---------------------------------------------------------------------------
// evaluateFixerDisposition — happy path (AC row 3) + containment (AC row 2)
// ---------------------------------------------------------------------------

function tackledHandoff(overrides = {}) {
  return normalizeFixerDispositionHandoff({
    headSha: SHA,
    dispositions: [{ threadId: "T1", fixingCommitSha: SHA, disposition: "tackled", ...overrides }],
  });
}

test("evaluateFixerDisposition: ok when contained, replied, and resolved", () => {
  const result = evaluateFixerDisposition({
    handoff: tackledHandoff(),
    liveThreads: [{ threadId: "T1", isResolved: true, replyBodies: [`Fixed in commit ${SHA}.`] }],
    containment: { [SHA]: true },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.incomplete, []);
  assert.deepEqual(result.forbiddenActions, []);
  assert.equal(result.nextAction, null);
});

test("evaluateFixerDisposition: uncontained commit cannot authorize resolution (AC row 2)", () => {
  const result = evaluateFixerDisposition({
    handoff: tackledHandoff(),
    liveThreads: [{ threadId: "T1", isResolved: true, replyBodies: [`Fixed in commit ${SHA}.`] }],
    containment: { [SHA]: false },
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete.length, 1);
  assert.equal(result.incomplete[0].failedStep, FIXER_DISPOSITION_FAILED_STEP.COMMIT_NOT_CONTAINED);
});

test("evaluateFixerDisposition: missing containment fact (unknown SHA) fails closed, same as uncontained", () => {
  const result = evaluateFixerDisposition({
    handoff: tackledHandoff(),
    liveThreads: [{ threadId: "T1", isResolved: true, replyBodies: [`Fixed in commit ${SHA}.`] }],
    containment: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete[0].failedStep, FIXER_DISPOSITION_FAILED_STEP.COMMIT_NOT_CONTAINED);
});

test("evaluateFixerDisposition: reply missing even though resolved (bogus/uncontained-evidence style gap)", () => {
  const result = evaluateFixerDisposition({
    handoff: tackledHandoff(),
    liveThreads: [{ threadId: "T1", isResolved: true, replyBodies: [] }],
    containment: { [SHA]: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete[0].failedStep, FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING);
});

test("evaluateFixerDisposition: replied but not resolved", () => {
  const result = evaluateFixerDisposition({
    handoff: tackledHandoff(),
    liveThreads: [{ threadId: "T1", isResolved: false, replyBodies: [`Fixed in commit ${SHA}.`] }],
    containment: { [SHA]: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete[0].failedStep, FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED);
});

// ---------------------------------------------------------------------------
// AC row 4 — fires even when unresolvedThreadCount reads 0 (bogus evidence)
// ---------------------------------------------------------------------------

test("evaluateFixerDisposition blocks even when the live thread already reads isResolved:true but with no matching evidence", () => {
  // Live GitHub state shows the thread resolved (unresolvedThreadCount would
  // read 0 from the caller's perspective) but the reply never carried the
  // claimed commit's evidence — the ledger's claim is simply wrong.
  const result = evaluateFixerDisposition({
    handoff: tackledHandoff(),
    liveThreads: [{ threadId: "T1", isResolved: true, replyBodies: ["Acknowledged, will look into it."] }],
    containment: { [SHA]: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete[0].failedStep, FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING);
  assert.ok(result.forbiddenActions.includes("request_copilot_review"));
  assert.ok(result.forbiddenActions.includes("rerequest_copilot_review"));
});

test("evaluateFixerDisposition: missing_from_handoff when a live thread is claimed tackled but absent from the handoff", () => {
  const result = evaluateFixerDisposition({
    handoff: normalizeFixerDispositionHandoff({ headSha: SHA, dispositions: [] }),
    liveThreads: [{ threadId: "T9", isResolved: false, replyBodies: [], claimedTackled: true }],
    containment: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete[0].threadId, "T9");
  assert.equal(result.incomplete[0].expectedCommit, null);
  assert.equal(result.incomplete[0].failedStep, FIXER_DISPOSITION_FAILED_STEP.MISSING_FROM_HANDOFF);
});

// ---------------------------------------------------------------------------
// AC row 6 — unrelated threads are preserved (never evaluated/resolved)
// ---------------------------------------------------------------------------

test("evaluateFixerDisposition never touches untackled/deferred/rejected/foreign/newly-arrived threads", () => {
  const handoff = normalizeFixerDispositionHandoff({
    headSha: SHA,
    dispositions: [
      { threadId: "T1", fixingCommitSha: SHA, disposition: "tackled" },
      { threadId: "T2", fixingCommitSha: SHA, disposition: "deferred" },
      { threadId: "T3", fixingCommitSha: SHA, disposition: "rejected" },
    ],
  });
  const result = evaluateFixerDisposition({
    handoff,
    liveThreads: [
      { threadId: "T1", isResolved: true, replyBodies: [`Fixed in commit ${SHA}.`] },
      // T2/T3 stay unresolved with no reply evidence at all — must NOT surface
      // as incomplete since they were never claimed tackled.
      { threadId: "T2", isResolved: false, replyBodies: [] },
      { threadId: "T3", isResolved: false, replyBodies: [] },
      // A brand-new thread that arrived after the fixer push, with no
      // handoff entry at all and no out-of-band claim either.
      { threadId: "T-new", isResolved: false, replyBodies: [] },
    ],
    containment: { [SHA]: true },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.incomplete, []);
});

// ---------------------------------------------------------------------------
// AC row 8 — operator visibility: names every incomplete thread/commit/step
// ---------------------------------------------------------------------------

test("evaluateFixerDisposition names every incomplete thread, its expected commit, and its failed step in reason", () => {
  const handoff = normalizeFixerDispositionHandoff({
    headSha: SHA,
    dispositions: [
      { threadId: "T1", fixingCommitSha: SHA, disposition: "tackled" },
      { threadId: "T2", fixingCommitSha: "0000000deadbeef000000000000000000000000", disposition: "tackled" },
    ],
  });
  const result = evaluateFixerDisposition({
    handoff,
    liveThreads: [
      { threadId: "T1", isResolved: false, replyBodies: [`Fixed in commit ${SHA}.`] },
      { threadId: "T2", isResolved: false, replyBodies: [] },
    ],
    containment: { [SHA]: true, "0000000deadbeef000000000000000000000000": false },
  });
  assert.equal(result.ok, false);
  assert.equal(result.incomplete.length, 2);
  assert.equal(result.nextAction, COMPLETE_FIXER_DISPOSITION_ACTION);
  assert.match(result.reason, /thread T1 \(expected commit abc1234def5670000000000000000000000000000, failed step: not_resolved\)/);
  assert.match(result.reason, /thread T2 \(expected commit 0000000deadbeef000000000000000000000000, failed step: commit_not_contained\)/);
  assert.match(result.reason, new RegExp(`only legal next action is ${COMPLETE_FIXER_DISPOSITION_ACTION}`));
});

// ---------------------------------------------------------------------------
// AC row 9 — cross-harness: the shared decision has no I/O and no side effects
// ---------------------------------------------------------------------------

test("evaluateFixerDisposition is pure: identical input always yields identical output, no mutation", () => {
  const handoff = tackledHandoff();
  const liveThreads = [{ threadId: "T1", isResolved: true, replyBodies: [`Fixed in commit ${SHA}.`] }];
  const containment = { [SHA]: true };
  const first = evaluateFixerDisposition({ handoff, liveThreads, containment });
  const second = evaluateFixerDisposition({ handoff, liveThreads, containment });
  assert.deepEqual(first, second);
  // Inputs were not mutated by the evaluator.
  assert.equal(liveThreads[0].isResolved, true);
  assert.equal(containment[SHA], true);
});

// ---------------------------------------------------------------------------
// forbidden-action token drift guard: fixer-disposition.mjs's literal tokens
// must equal pr-gate-coordination.mjs's PR_CHECKPOINT_ACTION values (no
// circular import between the two, so this test is the single source of
// truth that keeps them from silently drifting apart).
// ---------------------------------------------------------------------------

test("FIXER_DISPOSITION_FORBIDDEN_ACTIONS tokens match PR_CHECKPOINT_ACTION values", () => {
  const knownActionValues = new Set(Object.values(PR_CHECKPOINT_ACTION));
  for (const token of FIXER_DISPOSITION_FORBIDDEN_ACTIONS) {
    assert.ok(knownActionValues.has(token), `${token} is not a known PR_CHECKPOINT_ACTION value`);
  }
});

test("COMPLETE_FIXER_DISPOSITION_ACTION matches PR_CHECKPOINT_ACTION.COMPLETE_FIXER_DISPOSITION", () => {
  assert.equal(COMPLETE_FIXER_DISPOSITION_ACTION, PR_CHECKPOINT_ACTION.COMPLETE_FIXER_DISPOSITION);
});
