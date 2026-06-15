import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTONOMY_GATE_ACTION_MAP,
  actionRequiresApproval,
  CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION,
  ACTION_PRIORITY,
  SUBAGENT_ACTIONS,
  buildActionQueue,
  buildSummary,
  detectPrState,
  runConductorCycle,
  parseCliArgs,
} from "../../scripts/loop/run-conductor-cycle.mjs";
import { PR_CHECKPOINT_ACTION, PR_CHECKPOINT } from "@dev-loops/core/loop/pr-gate-coordination";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/run-conductor-cycle.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// ---------------------------------------------------------------------------
// Unit: action mapping
// ---------------------------------------------------------------------------

test("all PR_CHECKPOINT_ACTION values have a conductor action mapping", () => {
  const gateActionValues = Object.values(PR_CHECKPOINT_ACTION);
  const missing = gateActionValues.filter((val) => !(val in CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION));
  assert.deepEqual(missing, [], `Missing mappings for: ${missing.join(", ")}`);
});

test("CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION maps unresolved feedback to fix_threads", () => {
  assert.equal(CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK], "fix_threads");
  assert.equal(CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS], "fix_threads");
});

test("CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION maps pre-approval to run_pre_approval", () => {
  assert.equal(CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE], "run_pre_approval");
});

test("CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION maps merge to merge", () => {
  assert.equal(CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY], "merge");
});

test("CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION maps wait states to watch", () => {
  assert.equal(CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW], "watch");
  assert.equal(CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[PR_CHECKPOINT_ACTION.WAIT_FOR_CI], "watch");
});

// ---------------------------------------------------------------------------
// Unit: priority
// ---------------------------------------------------------------------------

test("ACTION_PRIORITY orders merge > fix_threads > run_pre_approval > draft_gate", () => {
  assert.ok(ACTION_PRIORITY.merge > ACTION_PRIORITY.fix_threads);
  assert.ok(ACTION_PRIORITY.fix_threads > ACTION_PRIORITY.run_pre_approval);
  assert.ok(ACTION_PRIORITY.run_pre_approval > ACTION_PRIORITY.draft_gate);
});

test("ACTION_PRIORITY orders request_review > watch > await_approval > blocked > done", () => {
  assert.ok(ACTION_PRIORITY.request_review > ACTION_PRIORITY.watch);
  assert.ok(ACTION_PRIORITY.watch > ACTION_PRIORITY.await_approval);
  assert.ok(ACTION_PRIORITY.await_approval >= ACTION_PRIORITY.blocked);
  assert.ok(ACTION_PRIORITY.blocked > ACTION_PRIORITY.done);
});

test("ACTION_PRIORITY has error at the lowest priority", () => {
  assert.ok(ACTION_PRIORITY.error < 0);
  for (const key of Object.keys(ACTION_PRIORITY)) {
    if (key !== "error") {
      assert.ok(ACTION_PRIORITY[key] > ACTION_PRIORITY.error, `${key} should be > error`);
    }
  }
});

// ---------------------------------------------------------------------------
// Unit: SUBAGENT_ACTIONS
// ---------------------------------------------------------------------------

test("SUBAGENT_ACTIONS includes fix_threads, draft_gate, request_review, rerequest_review, run_pre_approval", () => {
  assert.ok(SUBAGENT_ACTIONS.has("fix_threads"));
  assert.ok(SUBAGENT_ACTIONS.has("draft_gate"));
  assert.ok(SUBAGENT_ACTIONS.has("request_review"));
  assert.ok(SUBAGENT_ACTIONS.has("rerequest_review"));
  assert.ok(SUBAGENT_ACTIONS.has("run_pre_approval"));
});

test("SUBAGENT_ACTIONS does not include watch, merge, done, blocked", () => {
  assert.equal(SUBAGENT_ACTIONS.has("watch"), false);
  assert.equal(SUBAGENT_ACTIONS.has("merge"), false);
  assert.equal(SUBAGENT_ACTIONS.has("done"), false);
  assert.equal(SUBAGENT_ACTIONS.has("blocked"), false);
  assert.equal(SUBAGENT_ACTIONS.has("await_approval"), false);
  assert.equal(SUBAGENT_ACTIONS.has("resolve_conflicts"), false);
});

// ---------------------------------------------------------------------------
// Unit: buildActionQueue
// ---------------------------------------------------------------------------

test("buildActionQueue sorts by priority descending, then PR number ascending", () => {
  const results = [
    { pr: 10, priority: 30, action: "watch" },
    { pr: 5, priority: 90, action: "fix_threads" },
    { pr: 7, priority: 100, action: "merge" },
    { pr: 3, priority: 90, action: "fix_threads" },
    { pr: 8, priority: 30, action: "watch" },
  ];

  const queue = buildActionQueue(results);
  assert.equal(queue[0].pr, 7);  // merge (100)
  assert.equal(queue[1].pr, 3);  // fix_threads (90), lower PR first
  assert.equal(queue[2].pr, 5);  // fix_threads (90)
  assert.equal(queue[3].pr, 8);  // watch (30), lower PR first
  assert.equal(queue[4].pr, 10); // watch (30)
});

test("buildActionQueue returns empty array for empty input", () => {
  assert.deepEqual(buildActionQueue([]), []);
});

test("buildActionQueue handles single item", () => {
  const queue = buildActionQueue([{ pr: 1, priority: 100, action: "merge" }]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].pr, 1);
});

// ---------------------------------------------------------------------------
// Unit: buildSummary
// ---------------------------------------------------------------------------

test("buildSummary counts actions correctly", () => {
  const actions = [
    { pr: 1, action: "merge", requiresSubagent: false },
    { pr: 2, action: "fix_threads", requiresSubagent: true },
    { pr: 3, action: "watch", requiresSubagent: false },
    { pr: 4, action: "blocked", requiresSubagent: false },
    { pr: 5, action: "done", requiresSubagent: false },
    { pr: 6, action: "run_pre_approval", requiresSubagent: true },
    { pr: 7, action: "error", requiresSubagent: false },
  ];

  const summary = buildSummary(actions);
  assert.equal(summary.readyToMerge, 1);
  assert.equal(summary.needsSubagent, 2);
  assert.equal(summary.waiting, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.done, 1);
  assert.equal(summary.errors, 1);
});

test("buildSummary handles empty action list", () => {
  const summary = buildSummary([]);
  assert.equal(summary.needsSubagent, 0);
  assert.equal(summary.readyToMerge, 0);
  assert.equal(summary.waiting, 0);
  assert.equal(summary.blocked, 0);
  assert.equal(summary.done, 0);
  assert.equal(summary.errors, 0);
});

test("buildSummary counts await_approval and resolve_conflicts as blocked", () => {
  const summary = buildSummary([
    { pr: 1, action: "await_approval", requiresSubagent: false },
    { pr: 2, action: "resolve_conflicts", requiresSubagent: false },
  ]);
  assert.equal(summary.blocked, 2);
});

// ---------------------------------------------------------------------------
// Unit: detectPrState (with mock detectors)
// ---------------------------------------------------------------------------

test("detectPrState returns correctly shaped action entry for fix_threads", async () => {
  const pr = { number: 42, title: "Test PR", url: "https://github.com/o/r/pull/42", isDraft: false, headRefName: "feature/x" };

  const mockGateState = {
    lifecycleState: "unresolved_feedback_present",
    loopDisposition: "unresolved_feedback",
    gateBoundary: PR_CHECKPOINT.FEEDBACK_RESOLUTION,
    nextAction: PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK,
    reason: "Fix threads needed",
    allowedNextActions: [PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK],
    forbiddenActions: [PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY],
    draftGate: { visible: true, verdict: "clean", headSha: "abc123" },
    preApprovalGate: { visible: false, verdict: null, headSha: null },
    mergeStateStatus: "CLEAN",
    conflictFiles: [],
    currentHeadSha: "abc123",
  };

  const mockSnapshot = { ciStatus: "success", unresolvedThreadCount: 2 };

  const mockDetectGate = async () => mockGateState;
  const mockDetectSnapshot = async () => mockSnapshot;

  const result = await detectPrState(pr, {
    repo: "owner/repo",
    detectGateImpl: mockDetectGate,
    detectSnapshotImpl: mockDetectSnapshot,
  });

  assert.equal(result.pr, 42);
  assert.equal(result.action, "fix_threads");
  assert.equal(result.priority, 90);
  assert.equal(result.requiresSubagent, true);
  assert.equal(result.state, "unresolved_feedback_present");
  assert.equal(result.lifecycleState, "unresolved_feedback_present");
  assert.equal(result.gateBoundary, PR_CHECKPOINT.FEEDBACK_RESOLUTION);
  assert.equal(result.snapshot.ciStatus, "success");
  assert.equal(result.gateState.currentHeadSha, "abc123");
  assert.deepEqual(result.handoffContract, {
    ownership: "subagent",
    stopBoundary: "subagent_exit",
    resumePolicy: "resume_after_subagent_exit",
  });
  assert.equal(result.error, undefined);
});

test("detectPrState returns merge action with correct flags", async () => {
  const pr = { number: 1, title: "Ready", url: "url", isDraft: false, headRefName: "feat" };

  const mockGateState = {
    lifecycleState: "pr_ready_no_feedback",
    loopDisposition: "clean_converged",
    gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
    nextAction: PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    reason: null,
    allowedNextActions: [PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY],
    forbiddenActions: [],
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGate: { visible: true, verdict: "clean" },
    mergeStateStatus: "CLEAN",
    conflictFiles: [],
    currentHeadSha: "sha",
  };

  const mockSnapshot = { ciStatus: "success" };
  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => mockGateState,
    detectSnapshotImpl: async () => mockSnapshot,
  });

  assert.equal(result.action, "merge");
  assert.equal(result.priority, 100);
  assert.equal(result.requiresSubagent, false);
  assert.deepEqual(result.handoffContract, {
    ownership: "human",
    stopBoundary: "merge_boundary",
    resumePolicy: "resume_after_merge_authorization",
  });
});

test("detectPrState returns watch for waiting_for_copilot_review", async () => {
  const pr = { number: 2, title: "W", url: "u", isDraft: false, headRefName: "f" };

  const mockGateState = {
    lifecycleState: "waiting_for_copilot_review",
    loopDisposition: "pending",
    gateBoundary: PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
    nextAction: PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
    reason: null,
    allowedNextActions: [PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW],
    forbiddenActions: [],
    draftGate: null,
    preApprovalGate: null,
    mergeStateStatus: null,
    conflictFiles: [],
    currentHeadSha: null,
  };

  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => mockGateState,
    detectSnapshotImpl: async () => null,
  });

  assert.equal(result.action, "watch");
  assert.equal(result.priority, 30);
  assert.equal(result.requiresSubagent, false);
  assert.deepEqual(result.handoffContract, {
    ownership: "parent",
    stopBoundary: "watch_boundary",
    resumePolicy: "resume_after_state_refresh",
  });
});

test("detectPrState handles gate detection failure gracefully", async () => {
  const pr = { number: 99, title: "Fail", url: "u", isDraft: false, headRefName: "f" };

  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => { throw new Error("gh exploded"); },
    detectSnapshotImpl: async () => null,
  });

  assert.equal(result.pr, 99);
  assert.equal(result.action, "error");
  assert.equal(result.priority, ACTION_PRIORITY.error);
  assert.equal(result.requiresSubagent, false);
  assert.ok(result.error.includes("gh exploded"));
});

test("detectPrState tolerates snapshot failure when gate succeeds", async () => {
  const pr = { number: 50, title: "OK", url: "u", isDraft: false, headRefName: "f" };

  const mockGateState = {
    lifecycleState: "pr_draft",
    loopDisposition: "action_required",
    gateBoundary: PR_CHECKPOINT.DRAFT_REVIEW,
    nextAction: PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
    reason: "draft gate needed",
    allowedNextActions: [PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE],
    forbiddenActions: [],
    draftGate: null,
    preApprovalGate: null,
    mergeStateStatus: null,
    conflictFiles: [],
    currentHeadSha: null,
  };

  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => mockGateState,
    detectSnapshotImpl: async () => { throw new Error("snapshot fail"); },
  });

  assert.equal(result.action, "draft_gate");
  assert.equal(result.snapshot, null);
  assert.equal(result.error, undefined);
});

// ---------------------------------------------------------------------------
// Integration: runConductorCycle with mock detectors
// ---------------------------------------------------------------------------

test("runConductorCycle produces ordered queue for mixed PR states", async () => {
  const mockPrs = [
    { number: 10, title: "Wait PR", url: "u10", isDraft: false, headRefName: "w" },
    { number: 5, title: "Fix PR", url: "u5", isDraft: false, headRefName: "f" },
    { number: 7, title: "Merge PR", url: "u7", isDraft: false, headRefName: "m" },
  ];

  const mockListPrs = async () => mockPrs;

  const mockDetectPr = async (pr) => {
    if (pr.number === 7) {
      return {
        pr: 7, title: "Merge PR", url: "u7", isDraft: false, headRefName: "m",
        action: "merge", priority: 100, state: "pr_ready_no_feedback",
        lifecycleState: "pr_ready_no_feedback", loopDisposition: "clean_converged",
        gateBoundary: "final_approval_ready", reason: null, snapshot: null,
        gateState: {}, requiresSubagent: false,
        handoffContract: {
          ownership: "human",
          stopBoundary: "merge_boundary",
          resumePolicy: "resume_after_merge_authorization",
        },
      };
    }
    if (pr.number === 5) {
      return {
        pr: 5, title: "Fix PR", url: "u5", isDraft: false, headRefName: "f",
        action: "fix_threads", priority: 90, state: "unresolved_feedback_present",
        lifecycleState: "unresolved_feedback_present", loopDisposition: "unresolved_feedback",
        gateBoundary: "feedback_resolution", reason: null, snapshot: null,
        gateState: {}, requiresSubagent: true,
        handoffContract: {
          ownership: "subagent",
          stopBoundary: "subagent_exit",
          resumePolicy: "resume_after_subagent_exit",
        },
      };
    }
    return {
      pr: 10, title: "Wait PR", url: "u10", isDraft: false, headRefName: "w",
      action: "watch", priority: 30, state: "waiting_for_copilot_review",
      lifecycleState: "waiting_for_copilot_review", loopDisposition: "pending",
      gateBoundary: "post_draft_external_review", reason: null, snapshot: null,
      gateState: {}, requiresSubagent: false,
      handoffContract: {
        ownership: "parent",
        stopBoundary: "watch_boundary",
        resumePolicy: "resume_after_state_refresh",
      },
    };
  };

  const result = await runConductorCycle(
    { repo: "test/repo" },
    { listPrsImpl: mockListPrs, detectPrStateImpl: mockDetectPr },
  );

  assert.equal(result.ok, true);
  assert.equal(result.prCount, 3);
  assert.equal(result.actions.length, 3);

  assert.equal(result.actions[0].pr, 7);
  assert.equal(result.actions[0].action, "merge");
  assert.equal(result.actions[0].handoffContract.ownership, "human");
  assert.equal(result.actions[1].pr, 5);
  assert.equal(result.actions[1].action, "fix_threads");
  assert.equal(result.actions[1].handoffContract.ownership, "subagent");
  assert.equal(result.actions[2].pr, 10);
  assert.equal(result.actions[2].action, "watch");
  assert.equal(result.actions[2].handoffContract.resumePolicy, "resume_after_state_refresh");

  assert.equal(result.summary.readyToMerge, 1);
  assert.equal(result.summary.needsSubagent, 1);
  assert.equal(result.summary.waiting, 1);
});

test("runConductorCycle returns queue_complete-like result for zero PRs", async () => {
  const result = await runConductorCycle(
    { repo: "test/repo" },
    { listPrsImpl: async () => [], detectPrStateImpl: async () => ({}) },
  );

  assert.equal(result.prCount, 0);
  assert.equal(result.actions.length, 0);
  assert.equal(result.summary.readyToMerge, 0);
});

test("runConductorCycle handles errors on individual PRs without failing the cycle", async () => {
  const mockPrs = [
    { number: 1, title: "Good", url: "u1", isDraft: false, headRefName: "g" },
    { number: 2, title: "Bad", url: "u2", isDraft: false, headRefName: "b" },
  ];

  const mockListPrs = async () => mockPrs;

  let callCount = 0;
  const mockDetectPr = async (pr) => {
    callCount += 1;
    if (pr.number === 2) {
      return {
        pr: 2, title: "Bad", url: "u2", isDraft: false, headRefName: "b",
        action: "error", priority: -1, state: null, lifecycleState: null,
        loopDisposition: null, gateBoundary: null, reason: null, snapshot: null,
        gateState: null, requiresSubagent: false, error: "Boom",
      };
    }
    return {
      pr: 1, title: "Good", url: "u1", isDraft: false, headRefName: "g",
      action: "watch", priority: 30, state: "waiting_for_copilot_review",
      lifecycleState: "waiting_for_copilot_review", loopDisposition: "pending",
      gateBoundary: "post_draft_external_review", reason: null, snapshot: null,
      gateState: {}, requiresSubagent: false,
    };
  };

  const result = await runConductorCycle(
    { repo: "test/repo" },
    { listPrsImpl: mockListPrs, detectPrStateImpl: mockDetectPr },
  );

  assert.equal(result.prCount, 2);
  assert.equal(result.actions.length, 2);
  assert.equal(callCount, 2);
  assert.equal(result.actions[0].pr, 1); // good PR first (higher priority)
  assert.equal(result.actions[1].pr, 2); // error PR last
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.waiting, 1);
});

// ---------------------------------------------------------------------------
// CLI: argument parsing
// ---------------------------------------------------------------------------

test("parseCliArgs requires --repo", () => {
  assert.throws(() => parseCliArgs([]), /requires --repo/);
});

test("parseCliArgs rejects unknown flags", () => {
  assert.throws(
    () => parseCliArgs(["--repo", "owner/repo", "--unknown"]),
    /Unknown argument/,
  );
});

test("parseCliArgs rejects invalid repo slug", () => {
  assert.throws(
    () => parseCliArgs(["--repo", "not-a-valid-slug"]),
    /--repo must match/,
  );
});

test("parseCliArgs accepts valid repo slug", () => {
  const opts = parseCliArgs(["--repo", "owner/repo"]);
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.help, false);
});

test("parseCliArgs handles --help", () => {
  const opts = parseCliArgs(["--help"]);
  assert.equal(opts.help, true);
});

// ---------------------------------------------------------------------------
// CLI: gh stub integration (basic smoke tests)
// ---------------------------------------------------------------------------

test("run-conductor-cycle CLI reports empty queue when no open PRs exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-rc-cycle-empty-"));

  try {
    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "[]\n",
    }]);

    const { code, stdout, stderr } = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(code, 0);
    assert.equal(stderr, "");

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.prCount, 0);
    assert.deepEqual(payload.actions, []);
    assert.equal(payload.summary.needsSubagent, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-conductor-cycle CLI fails gracefully on gh pr list failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-rc-cycle-gh-fail-"));

  try {
    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stderr: "gh network error\n",
      exitCode: 1,
    }]);

    const { code, stdout, stderr } = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(code, 1);
    assert.equal(stdout, "");
    const payload = JSON.parse(stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /gh command failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("run-conductor-cycle CLI fails closed on non-array pr list response", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-rc-cycle-bad-list-"));

  try {
    const { env } = await writeGhStubHelper(tempDir, [{
      assertArgs: ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,headRefName,author"],
      stdout: "not-an-array\n",
    }]);

    const { code, stdout, stderr } = await runNode(["--repo", "owner/repo"], { env });

    assert.equal(code, 1);
    assert.equal(stdout, "");
    const payload = JSON.parse(stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Invalid JSON input/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
test("AUTONOMY_GATE_ACTION_MAP maps merge to [merge]", () => {
  assert.deepEqual(AUTONOMY_GATE_ACTION_MAP.merge, ["merge"]);
});

test("AUTONOMY_GATE_ACTION_MAP maps pre-approval to [run_pre_approval]", () => {
  assert.deepEqual(AUTONOMY_GATE_ACTION_MAP["pre-approval"], ["run_pre_approval"]);
});

test("AUTONOMY_GATE_ACTION_MAP maps draft-pr to [draft_gate, request_review, rerequest_review]", () => {
  const expected = ["draft_gate", "request_review", "rerequest_review"];
  assert.deepEqual(AUTONOMY_GATE_ACTION_MAP["draft-pr"], expected);
});

test("AUTONOMY_GATE_ACTION_MAP has empty array for refinement", () => {
  assert.deepEqual(AUTONOMY_GATE_ACTION_MAP.refinement, []);
});

// ---------------------------------------------------------------------------
// Unit: actionRequiresApproval
// ---------------------------------------------------------------------------

test("actionRequiresApproval returns true for merge when stopAt includes merge (default)", () => {
  assert.equal(actionRequiresApproval("merge"), true);
  assert.equal(actionRequiresApproval("merge", ["merge"]), true);
});

test("actionRequiresApproval returns false for merge when stopAt is empty", () => {
  assert.equal(actionRequiresApproval("merge", []), false);
});

test("actionRequiresApproval returns false for watch regardless of stopAt", () => {
  assert.equal(actionRequiresApproval("watch"), false);
  assert.equal(actionRequiresApproval("watch", ["merge"]), false);
  assert.equal(actionRequiresApproval("watch", ["merge", "pre-approval", "draft-pr"]), false);
});

test("actionRequiresApproval returns true for run_pre_approval when pre-approval is in stopAt", () => {
  assert.equal(actionRequiresApproval("run_pre_approval", ["merge"]), false);
  assert.equal(actionRequiresApproval("run_pre_approval", ["merge", "pre-approval"]), true);
});

test("actionRequiresApproval returns true for draft_gate, request_review, rerequest_review when draft-pr is in stopAt", () => {
  assert.equal(actionRequiresApproval("draft_gate", ["merge"]), false);
  assert.equal(actionRequiresApproval("request_review", ["merge"]), false);
  assert.equal(actionRequiresApproval("rerequest_review", ["merge"]), false);

  const stopAt = ["merge", "draft-pr"];
  assert.equal(actionRequiresApproval("draft_gate", stopAt), true);
  assert.equal(actionRequiresApproval("request_review", stopAt), true);
  assert.equal(actionRequiresApproval("rerequest_review", stopAt), true);
});

test("actionRequiresApproval handles unknown action names safely", () => {
  assert.equal(actionRequiresApproval("unknown_action", ["merge"]), false);
});

test("actionRequiresApproval handles unknown gate names in stopAt safely", () => {
  assert.equal(actionRequiresApproval("merge", ["unknown_gate"]), false);
  assert.equal(actionRequiresApproval("merge", ["merge", "unknown_gate"]), true);
});

// ---------------------------------------------------------------------------
// Unit: detectPrState — requiresApproval with autonomyStopAt
// ---------------------------------------------------------------------------

test("detectPrState flags merge as requiresApproval with default stopAt", async () => {
  const pr = { number: 1, title: "R", url: "u", isDraft: false, headRefName: "f" };
  const mockGateState = {
    lifecycleState: "pr_ready_no_feedback",
    loopDisposition: "clean_converged",
    gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
    nextAction: PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    reason: null,
    allowedNextActions: [PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY],
    forbiddenActions: [],
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGate: { visible: true, verdict: "clean" },
    mergeStateStatus: "CLEAN",
    conflictFiles: [],
    currentHeadSha: "sha",
  };

  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => mockGateState,
    detectSnapshotImpl: async () => ({ ciStatus: "success" }),
  });

  assert.equal(result.action, "merge");
  assert.equal(result.requiresApproval, true);
});

test("detectPrState does NOT flag merge as requiresApproval when stopAt is empty", async () => {
  const pr = { number: 1, title: "R", url: "u", isDraft: false, headRefName: "f" };
  const mockGateState = {
    lifecycleState: "pr_ready_no_feedback",
    loopDisposition: "clean_converged",
    gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
    nextAction: PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    reason: null,
    allowedNextActions: [PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY],
    forbiddenActions: [],
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGate: { visible: true, verdict: "clean" },
    mergeStateStatus: "CLEAN",
    conflictFiles: [],
    currentHeadSha: "sha",
  };

  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => mockGateState,
    detectSnapshotImpl: async () => ({ ciStatus: "success" }),
    autonomyStopAt: [],
  });

  assert.equal(result.action, "merge");
  assert.equal(result.requiresApproval, false);
});

test("detectPrState flags run_pre_approval with requiresApproval when pre-approval is in stopAt", async () => {
  const pr = { number: 2, title: "P", url: "u", isDraft: false, headRefName: "f" };
  const mockGateState = {
    lifecycleState: "pr_draft_reviewed_clean",
    loopDisposition: "action_required",
    gateBoundary: PR_CHECKPOINT.FINAL_APPROVAL_READY,
    nextAction: PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
    reason: null,
    allowedNextActions: [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE],
    forbiddenActions: [],
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGate: null,
    mergeStateStatus: "CLEAN",
    conflictFiles: [],
    currentHeadSha: "sha",
  };

  const result = await detectPrState(pr, {
    repo: "r",
    detectGateImpl: async () => mockGateState,
    detectSnapshotImpl: async () => ({ ciStatus: "success" }),
    autonomyStopAt: ["merge", "pre-approval"],
  });

  assert.equal(result.action, "run_pre_approval");
  assert.equal(result.requiresApproval, true);
});

// ---------------------------------------------------------------------------
// Integration: runConductorCycle passes autonomyStopAt through
// ---------------------------------------------------------------------------

test("runConductorCycle includes autonomyStopAt in output", async () => {
  const result = await runConductorCycle(
    { repo: "test/repo", autonomyStopAt: ["merge", "draft-pr"] },
    { listPrsImpl: async () => [], detectPrStateImpl: async () => ({}) },
  );

  assert.deepEqual(result.autonomyStopAt, ["merge", "draft-pr"]);
});

test("runConductorCycle passes autonomyStopAt to detectPrState", async () => {
  let capturedStopAt = null;
  const mockDetectPr = async (_pr, opts) => {
    capturedStopAt = opts.autonomyStopAt;
    return { pr: 1, action: "watch", priority: 30, requiresSubagent: false, requiresApproval: false };
  };

  await runConductorCycle(
    { repo: "test/repo", autonomyStopAt: ["merge", "draft-pr"] },
    {
      listPrsImpl: async () => [{ number: 1, title: "T", url: "u", isDraft: false, headRefName: "f", authorLogin: "a" }],
      detectPrStateImpl: mockDetectPr,
    },
  );

  assert.deepEqual(capturedStopAt, ["merge", "draft-pr"]);
});

test("runConductorCycle uses default stopAt [merge] when none provided", async () => {
  let capturedStopAt = null;
  const mockDetectPr = async (_pr, opts) => {
    capturedStopAt = opts.autonomyStopAt;
    return { pr: 1, action: "watch", priority: 30, requiresSubagent: false, requiresApproval: false };
  };

  await runConductorCycle(
    { repo: "test/repo" },
    {
      listPrsImpl: async () => [{ number: 1, title: "T", url: "u", isDraft: false, headRefName: "f", authorLogin: "a" }],
      detectPrStateImpl: mockDetectPr,
    },
  );

  assert.deepEqual(capturedStopAt, ["merge"]);
});
