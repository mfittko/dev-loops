import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectAgentStall,
  resolveAgentStallThresholdMs,
  buildAgentStallRecoveryBrief,
  DEFAULT_AGENT_STALL_THRESHOLD_MS,
  AGENT_STALL_STATUS,
  AGENT_STALL_REASON,
} from "../src/loop/agent-stall.mjs";

const NOW = 1_750_000_000_000;
const MIN = 60_000;

test("detectAgentStall: active turn progress is NOT stalled", () => {
  const v = detectAgentStall({ lastActivityAt: NOW - 10_000, now: NOW });
  assert.equal(v.status, AGENT_STALL_STATUS.NOT_STALLED);
  assert.equal(v.reason, AGENT_STALL_REASON.ACTIVE_TURNS);
  assert.equal(v.stalled, false);
});

test("detectAgentStall: turn age over threshold with no heartbeat IS stalled", () => {
  const v = detectAgentStall({ lastActivityAt: NOW - 6 * MIN, now: NOW });
  assert.equal(v.status, AGENT_STALL_STATUS.STALLED);
  assert.equal(v.reason, AGENT_STALL_REASON.BELOW_THRESHOLD);
  assert.equal(v.stalled, true);
});

test("detectAgentStall: sanctioned long watch is NOT falsely bailed (AC2)", () => {
  // stale turn progress, but fresh runner heartbeat => sanctioned watch
  const v = detectAgentStall({
    lastActivityAt: NOW - 6 * MIN,
    sanctionedWatchAt: NOW - 10_000,
    now: NOW,
  });
  assert.equal(v.status, AGENT_STALL_STATUS.NOT_STALLED);
  assert.equal(v.reason, AGENT_STALL_REASON.SANCTIONED_WATCH);
  assert.equal(v.stalled, false);
});

test("detectAgentStall: pending supervisor request is never a stall (AC1)", () => {
  const v = detectAgentStall({
    lastActivityAt: NOW - 6 * MIN,
    pendingRequest: true,
    now: NOW,
  });
  assert.equal(v.status, AGENT_STALL_STATUS.NOT_STALLED);
  assert.equal(v.reason, AGENT_STALL_REASON.PENDING_REQUEST);
  assert.equal(v.stalled, false);
});

test("detectAgentStall: no turn signal and no heartbeat yields no_evidence", () => {
  const v = detectAgentStall({ now: NOW });
  assert.equal(v.status, AGENT_STALL_STATUS.NO_EVIDENCE);
  assert.equal(v.reason, AGENT_STALL_REASON.NO_SIGNAL);
  assert.equal(v.stalled, false);
});

test("detectAgentStall: parseable date strings are accepted", () => {
  const v = detectAgentStall({
    lastActivityAt: new Date(NOW - 6 * MIN).toISOString(),
    now: NOW,
  });
  assert.equal(v.stalled, true);
});

test("detectAgentStall: boundary at threshold is NOT stalled (<= threshold)", () => {
  const v = detectAgentStall({ lastActivityAt: NOW - 5 * MIN, now: NOW, thresholdMs: 5 * MIN });
  assert.equal(v.stalled, false);
  assert.equal(v.reason, AGENT_STALL_REASON.ACTIVE_TURNS);
  // just over the boundary IS stalled
  const v2 = detectAgentStall({ lastActivityAt: NOW - (5 * MIN + 1), now: NOW, thresholdMs: 5 * MIN });
  assert.equal(v2.stalled, true);
});

test("detectAgentStall: stale turn + stale heartbeat => stalled (not sanctioned watch)", () => {
  const v = detectAgentStall({
    lastActivityAt: NOW - 6 * MIN,
    sanctionedWatchAt: NOW - 6 * MIN - 1000,
    now: NOW,
  });
  assert.equal(v.status, AGENT_STALL_STATUS.STALLED);
  assert.equal(v.stalled, true);
});

test("resolveAgentStallThresholdMs: default / override / invalid", () => {
  assert.equal(resolveAgentStallThresholdMs(), DEFAULT_AGENT_STALL_THRESHOLD_MS);
  assert.equal(resolveAgentStallThresholdMs(5), 5 * MIN);
  assert.equal(resolveAgentStallThresholdMs("10"), 10 * MIN);
  assert.equal(resolveAgentStallThresholdMs(0), DEFAULT_AGENT_STALL_THRESHOLD_MS);
  assert.equal(resolveAgentStallThresholdMs(-3), DEFAULT_AGENT_STALL_THRESHOLD_MS);
  assert.equal(resolveAgentStallThresholdMs("abc"), DEFAULT_AGENT_STALL_THRESHOLD_MS);
});

test("buildAgentStallRecoveryBrief: carries worktree state + recovery brief (AC3)", () => {
  const brief = buildAgentStallRecoveryBrief({
    runId: "run-abc",
    cwd: "/repo/tmp/worktrees/dev-loops/issue-1669",
    lastAction: "implementing fixer follow-up",
    reason: "below_threshold",
  });
  assert.equal(brief.runId, "run-abc");
  assert.equal(brief.cwd, "/repo/tmp/worktrees/dev-loops/issue-1669");
  assert.equal(brief.lastAction, "implementing fixer follow-up");
  assert.match(brief.brief, /Recovery dispatch/);
  assert.match(brief.brief, /issue-1669/);
  assert.match(brief.brief, /implementing fixer follow-up/);
});

test("buildAgentStallRecoveryBrief: tolerates missing inputs", () => {
  const brief = buildAgentStallRecoveryBrief({});
  assert.equal(brief.runId, null);
  assert.equal(brief.cwd, null);
  assert.match(brief.brief, /unknown last action/);
});
