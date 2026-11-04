import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  BLOCKED_ON,
  evaluatePrGateCoordination,
  PR_CHECKPOINT_ACTION,
} from "../../packages/core/src/loop/pr-gate-coordination.mjs";
import { DISPOSITION, STATE } from "../../packages/core/src/loop/copilot-loop-state.mjs";

// Issue 3105 slice 1: no-dead-end invariant. Every report_blocked result names who decides
// (`blockedOn`) or the command an agent can run (`agentRemedy.command`), unless it is a listed
// known gap. The finding-class and override dimensions have no evaluator input yet; slices 2
// and 8 add them to this walk.

export const isTypedOrKnownGap = (input, result) => result.nextAction !== PR_CHECKPOINT_ACTION.REPORT_BLOCKED
  || Object.values(BLOCKED_ON).includes(result.blockedOn)
  || (typeof result.agentRemedy?.command === "string" && result.agentRemedy.command.length > 0)
  || KNOWN_GAPS.some((gap) => gap.matches(input, result));

// Each entry names the slice that removes it. Remove the entry in that slice.
const KNOWN_GAPS = [
  {
    id: "draft-round-cap-refusal",
    slice: "5-6",
    matches: (input, result) => input.draftRoundRefused === true && result.reason.includes("Round N+1 never runs"),
  },
  {
    id: "copilot-cap-ci",
    slice: "9",
    matches: (_input, result) => result.reason.startsWith("round_cap_reached at"),
  },
  {
    id: "unmappable-state-default",
    slice: "9",
    matches: (_input, result) => result.reason.includes("could not map lifecycle state"),
  },
];

const gate = (headSha, verdict) => ({ visible: true, headSha, verdict, contractComplete: true });
const HEAD = "abc123456789";
const CLEAN = gate("abc1234", "clean");

function* walk() {
  const draftCapFacts = [{}, { draftRoundRefused: true }, { draftCapRoundFixed: true }, { draftRoundRefused: true, draftCapRoundFixed: true }];
  for (const lifecycleState of Object.values(STATE)) {
    for (const prDraft of [true, false]) {
      for (const ciStatus of ["success", "failure", "pending", "none", "crediblyGreen"]) {
        for (const copilotReviewRoundCount of [0, 2, 3]) {
          for (const unresolvedThreadCount of [0, 3, null]) {
            for (const cap of draftCapFacts) {
              for (const unresolvedGateThreadCount of [0, 2, -1]) {
                for (const withGate of [false, true]) {
                  for (const prTitle of ["plain", "WIP: x"]) {
                    yield {
                      pr: 7,
                      repo: "o/r",
                      currentHeadSha: HEAD,
                      prDraft,
                      lifecycleState,
                      loopDisposition: DISPOSITION.ACTION_REQUIRED,
                      ciStatus,
                      maxCopilotRounds: 2,
                      copilotReviewRoundCount,
                      unresolvedThreadCount,
                      unresolvedGateThreadCount,
                      ...cap,
                      ...(withGate ? { draftGate: CLEAN, draftGateMarker: CLEAN } : {}),
                      prTitle,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

test("every report_blocked result is typed or a listed known gap", () => {
  const hits = new Map(KNOWN_GAPS.map((gap) => [gap.id, 0]));
  const violations = [];
  let blocked = 0;
  for (const input of walk()) {
    const result = evaluatePrGateCoordination(input);
    if (result.nextAction !== PR_CHECKPOINT_ACTION.REPORT_BLOCKED) continue;
    blocked += 1;
    const typed = Object.values(BLOCKED_ON).includes(result.blockedOn) || Boolean(result.agentRemedy?.command);
    if (!typed) {
      for (const gap of KNOWN_GAPS) if (gap.matches(input, result)) hits.set(gap.id, hits.get(gap.id) + 1);
    }
    if (!isTypedOrKnownGap(input, result) && violations.length < 5) {
      violations.push({ input, reason: result.reason });
    }
  }
  assert.ok(blocked > 0);
  assert.deepEqual(violations, []);
  for (const [id, count] of hits) assert.ok(count > 0, `stale known-gap entry: ${id}`);
});

test("the predicate flags a typed result with its remedy stripped", () => {
  const input = { pr: 7, repo: "o/r", currentHeadSha: HEAD, prDraft: false, lifecycleState: STATE.PR_READY_NO_FEEDBACK, prTitle: "WIP: x", draftGate: CLEAN, draftGateMarker: CLEAN, ciStatus: "success", maxCopilotRounds: 0 };
  const typed = evaluatePrGateCoordination(input);
  assert.equal(typed.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
  assert.ok(isTypedOrKnownGap(input, typed));
  const { agentRemedy: _drop, ...stripped } = typed;
  assert.equal(isTypedOrKnownGap(input, stripped), false);
});
