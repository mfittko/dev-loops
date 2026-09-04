import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  TRACKER_PR_STATE,
  REVERSE_SYNC_ACTION,
  normalizeTrackerPrSnapshot,
  interpretTrackerPrState,
} from "../src/loop/tracker-pr-state.mjs";

// ---------------------------------------------------------------------------
// normalizeTrackerPrSnapshot
// ---------------------------------------------------------------------------

test("normalizeTrackerPrSnapshot rejects non-object input", () => {
  assert.throws(() => normalizeTrackerPrSnapshot(null), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeTrackerPrSnapshot(undefined), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeTrackerPrSnapshot("string"), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeTrackerPrSnapshot(42), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeTrackerPrSnapshot([]), /Snapshot must be a non-null object/);
  assert.throws(() => normalizeTrackerPrSnapshot([{ trackerItemExists: true }]), /Snapshot must be a non-null object/);
});

test("normalizeTrackerPrSnapshot returns safe defaults for an empty object", () => {
  const result = normalizeTrackerPrSnapshot({});
  assert.deepEqual(result, {
    trackerItemExists: false,
    trackerItemId: null,
    prExists: false,
    prNumber: null,
    prDraft: false,
    prMerged: false,
    prClosed: false,
    prHeadSha: null,
    draftGateCommentVisible: false,
    draftGateCommentHeadSha: null,
    draftGateCommentVerdict: null,
  });
});

test("normalizeTrackerPrSnapshot parses only explicit boolean-like values", () => {
  const result = normalizeTrackerPrSnapshot({
    trackerItemExists: 1,
    prExists: " true ",
    prDraft: 0,
    prMerged: "false",
    prClosed: "yes",
  });
  assert.equal(result.trackerItemExists, true);
  assert.equal(result.prExists, true);
  assert.equal(result.prDraft, false);
  assert.equal(result.prMerged, false);
  assert.equal(result.prClosed, false);
});

test("normalizeTrackerPrSnapshot sets trackerItemId only when trackerItemExists is true and value is non-empty string", () => {
  const withItem = normalizeTrackerPrSnapshot({ trackerItemExists: true, trackerItemId: "PROJ-42" });
  assert.equal(withItem.trackerItemId, "PROJ-42");

  const noItem = normalizeTrackerPrSnapshot({ trackerItemExists: false, trackerItemId: "PROJ-42" });
  assert.equal(noItem.trackerItemId, null);

  const emptyId = normalizeTrackerPrSnapshot({ trackerItemExists: true, trackerItemId: "  " });
  assert.equal(emptyId.trackerItemId, null);

  const numericId = normalizeTrackerPrSnapshot({ trackerItemExists: true, trackerItemId: 42 });
  assert.equal(numericId.trackerItemId, null);
});

test("normalizeTrackerPrSnapshot treats junk boolean-like strings as safe false defaults", () => {
  const result = normalizeTrackerPrSnapshot({
    trackerItemExists: "nope",
    prExists: "yes",
    prDraft: "draft",
    prMerged: "merged",
    prClosed: "closed",
  });

  assert.deepEqual(result, {
    trackerItemExists: false,
    trackerItemId: null,
    prExists: false,
    prNumber: null,
    prDraft: false,
    prMerged: false,
    prClosed: false,
    prHeadSha: null,
    draftGateCommentVisible: false,
    draftGateCommentHeadSha: null,
    draftGateCommentVerdict: null,
  });
});

test("normalizeTrackerPrSnapshot trims whitespace from trackerItemId", () => {
  const result = normalizeTrackerPrSnapshot({ trackerItemExists: true, trackerItemId: "  STORY-7  " });
  assert.equal(result.trackerItemId, "STORY-7");
});

test("normalizeTrackerPrSnapshot normalizes prNumber independently as a positive integer", () => {
  const withPr = normalizeTrackerPrSnapshot({ prExists: true, prNumber: 17 });
  assert.equal(withPr.prNumber, 17);

  const contradictoryRaw = normalizeTrackerPrSnapshot({ prExists: false, prNumber: 17 });
  assert.equal(contradictoryRaw.prNumber, 17);
  assert.equal(contradictoryRaw.prExists, false);

  const negativeNumber = normalizeTrackerPrSnapshot({ prExists: true, prNumber: -5 });
  assert.equal(negativeNumber.prNumber, null);

  const zeroNumber = normalizeTrackerPrSnapshot({ prExists: true, prNumber: 0 });
  assert.equal(zeroNumber.prNumber, null);

  const floatNumber = normalizeTrackerPrSnapshot({ prExists: true, prNumber: 7.9 });
  assert.equal(floatNumber.prNumber, null);
});

// ---------------------------------------------------------------------------
// Transition graph integrity via interpretTrackerPrState behavior
// ---------------------------------------------------------------------------

test("interpretTrackerPrState allowedTransitions only contains known states for each reachable state", () => {
  const allStates = new Set(Object.values(TRACKER_PR_STATE));

  // One representative snapshot per state
  const snapshots = [
    { trackerItemExists: false },                                               // -> NO_TRACKER_ITEM
    { trackerItemExists: true },                                                // -> READY_NO_PR
    { trackerItemExists: true, prExists: true, prDraft: true },                 // -> DRAFT_PR_OPEN
    {                                                                           // -> PR_REVIEWABLE
      trackerItemExists: true, prExists: true,
      prHeadSha: "abc1234",
      draftGateCommentVisible: true,
      draftGateCommentHeadSha: "abc1234",
      draftGateCommentVerdict: "clean",
    },
    { trackerItemExists: true, prExists: true, prMerged: true },                // -> PR_MERGED
    { trackerItemExists: true, prExists: true, prClosed: true },                // -> PR_CLOSED_UNMERGED
    { trackerItemExists: false, prExists: true },                               // -> BLOCKED_NEEDS_USER_DECISION
  ];

  const reachedStates = new Set();
  for (const snap of snapshots) {
    const result = interpretTrackerPrState(snap);
    reachedStates.add(result.state);
    for (const target of result.allowedTransitions) {
      assert.ok(
        allStates.has(target),
        `allowedTransitions for ${result.state} contains unknown state: ${target}`,
      );
    }
  }

  for (const state of allStates) {
    assert.ok(
      reachedStates.has(state),
      `state ${state} was not reached by any representative snapshot`,
    );
  }
});

// ---------------------------------------------------------------------------
// REVERSE_SYNC_ACTION coverage
// ---------------------------------------------------------------------------

test("REVERSE_SYNC_ACTION covers every TRACKER_PR_STATE", () => {
  const valid = new Set(Object.values(TRACKER_PR_STATE));
  for (const state of valid) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(REVERSE_SYNC_ACTION, state),
      `missing reverse-sync action for state: ${state}`,
    );
    assert.equal(typeof REVERSE_SYNC_ACTION[state], "string");
  }
});

test("REVERSE_SYNC_ACTION maps lifecycle states to correct canonical actions", () => {
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.NO_TRACKER_ITEM], "none");
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.READY_NO_PR], "none");
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.DRAFT_PR_OPEN], "set_in_progress");
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.PR_REVIEWABLE], "set_reviewable");
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.PR_MERGED], "set_done");
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.PR_CLOSED_UNMERGED], "none");
  assert.equal(REVERSE_SYNC_ACTION[TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION], "none");
});

// ---------------------------------------------------------------------------
// interpretTrackerPrState — routing
// ---------------------------------------------------------------------------

test("interpretTrackerPrState routes to no_tracker_item when trackerItemExists is false", () => {
  const result = interpretTrackerPrState({ trackerItemExists: false });
  assert.equal(result.state, TRACKER_PR_STATE.NO_TRACKER_ITEM);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.reverseSyncAction, "none");
});

test("interpretTrackerPrState routes tracker-missing + PR-present snapshots to blocked_needs_user_decision", () => {
  const result = interpretTrackerPrState({ trackerItemExists: false, prExists: true, prNumber: 5 });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.reverseSyncAction, "none");
});

test("interpretTrackerPrState routes to ready_no_pr when tracker item exists and no PR yet", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: false,
  });
  assert.equal(result.state, TRACKER_PR_STATE.READY_NO_PR);
  assert.deepEqual(result.allowedTransitions, [TRACKER_PR_STATE.DRAFT_PR_OPEN]);
  assert.equal(result.reverseSyncAction, "none");
});

test("interpretTrackerPrState routes to draft_pr_open when draft PR exists", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prDraft: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.DRAFT_PR_OPEN);
  assert.deepEqual(result.allowedTransitions, [TRACKER_PR_STATE.PR_REVIEWABLE]);
  assert.equal(result.reverseSyncAction, "set_in_progress");
});

test("interpretTrackerPrState routes to pr_reviewable when PR is open and not draft", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prHeadSha: "abc1234",
    prDraft: false,
    prMerged: false,
    prClosed: false,
    draftGateCommentVisible: true,
    draftGateCommentHeadSha: "abc1234",
    draftGateCommentVerdict: "clean",
  });
  assert.equal(result.state, TRACKER_PR_STATE.PR_REVIEWABLE);
  assert.ok(result.allowedTransitions.includes(TRACKER_PR_STATE.PR_MERGED));
  assert.ok(result.allowedTransitions.includes(TRACKER_PR_STATE.PR_CLOSED_UNMERGED));
  assert.ok(result.allowedTransitions.includes(TRACKER_PR_STATE.DRAFT_PR_OPEN));
  assert.equal(result.reverseSyncAction, "set_reviewable");
});

test("interpretTrackerPrState fails closed for open non-draft PR when clean current-head draft gate comment is missing", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prHeadSha: "abc1234",
    prDraft: false,
    prMerged: false,
    prClosed: false,
    draftGateCommentVisible: true,
    draftGateCommentHeadSha: "old5678",
    draftGateCommentVerdict: "clean",
  });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.deepEqual(result.allowedTransitions, []);
});

test("interpretTrackerPrState routes to pr_merged when PR has been merged", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prMerged: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.PR_MERGED);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.reverseSyncAction, "set_done");
});

test("interpretTrackerPrState routes contradictory prMerged=true+prDraft=true to blocked_needs_user_decision", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prMerged: true,
    prDraft: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
});

test("interpretTrackerPrState routes to pr_closed_unmerged when PR is closed without merge", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prClosed: true,
    prMerged: false,
  });
  assert.equal(result.state, TRACKER_PR_STATE.PR_CLOSED_UNMERGED);
  assert.ok(result.allowedTransitions.includes(TRACKER_PR_STATE.READY_NO_PR));
  assert.equal(result.reverseSyncAction, "none");
});

test("interpretTrackerPrState treats prMerged=true+prClosed=true as pr_merged because GitHub merged PRs are also closed", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prMerged: true,
    prClosed: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.PR_MERGED);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.reverseSyncAction, "set_done");
});

test("interpretTrackerPrState routes contradictory prExists=false+prMerged=true to blocked_needs_user_decision", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: false,
    prMerged: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.reverseSyncAction, "none");
});

test("interpretTrackerPrState routes contradictory prExists=false+prNumber-present snapshots to blocked_needs_user_decision", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: false,
    prNumber: 10,
  });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
  assert.deepEqual(result.allowedTransitions, []);
  assert.equal(result.reverseSyncAction, "none");
});

test("interpretTrackerPrState routes contradictory prExists=false+prClosed=true to blocked_needs_user_decision", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: false,
    prClosed: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
});

test("interpretTrackerPrState routes contradictory prExists=false+prDraft=true to blocked_needs_user_decision", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: false,
    prDraft: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.BLOCKED_NEEDS_USER_DECISION);
});

test("interpretTrackerPrState routes closed draft PR snapshots to pr_closed_unmerged", () => {
  const result = interpretTrackerPrState({
    trackerItemExists: true,
    trackerItemId: "PROJ-1",
    prExists: true,
    prNumber: 10,
    prClosed: true,
    prDraft: true,
  });
  assert.equal(result.state, TRACKER_PR_STATE.PR_CLOSED_UNMERGED);
  assert.equal(result.reverseSyncAction, "none");
});

// ---------------------------------------------------------------------------
// interpretTrackerPrState — output shape
// ---------------------------------------------------------------------------

test("interpretTrackerPrState always returns state, allowedTransitions, nextAction, reverseSyncAction", () => {
  const snapshots = [
    {},
    { trackerItemExists: true },
    { trackerItemExists: true, prExists: true, prDraft: true },
    { trackerItemExists: true, prExists: true, prMerged: true },
  ];
  for (const snap of snapshots) {
    const result = interpretTrackerPrState(snap);
    assert.equal(typeof result.state, "string", "state must be a string");
    assert.ok(Array.isArray(result.allowedTransitions), "allowedTransitions must be an array");
    assert.equal(typeof result.nextAction, "string", "nextAction must be a string");
    assert.ok(result.nextAction.length > 0, "nextAction must not be empty");
    assert.equal(typeof result.reverseSyncAction, "string", "reverseSyncAction must be a string");
  }
});

test("interpretTrackerPrState allowedTransitions array is a fresh copy each call", () => {
  const snap = { trackerItemExists: true, prExists: false };
  const r1 = interpretTrackerPrState(snap);
  const r2 = interpretTrackerPrState(snap);
  assert.notEqual(r1.allowedTransitions, r2.allowedTransitions);
  assert.deepEqual(r1.allowedTransitions, r2.allowedTransitions);
});

test("interpretTrackerPrState is deterministic: same snapshot always yields same result", () => {
  const snap = {
    trackerItemExists: true,
    trackerItemId: "BUG-99",
    prExists: true,
    prNumber: 7,
    prDraft: false,
    prMerged: false,
    prClosed: false,
  };
  const r1 = interpretTrackerPrState(snap);
  const r2 = interpretTrackerPrState(snap);
  assert.deepEqual(r1, r2);
});
