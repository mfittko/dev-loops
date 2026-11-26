import assert from "node:assert/strict";
import { test } from "bun:test";
import { evaluatePrGateCoordination } from "../src/loop/pr-gate-coordination.mjs";
import { DISPOSITION, STATE } from "../src/loop/copilot-loop-state.mjs";

// Issue 3097 AC5: the reason texts name the sanctioned wrapper, never raw `gh pr ready` (RAW-GH-PR-READY-BYPASS).
const head = "abc123456789";
const marker = (verdict) => ({ visible: true, headSha: "abc1234", verdict, contractComplete: true });
const draftAt = (overrides = {}) => evaluatePrGateCoordination({
  pr: 10, currentHeadSha: head, prDraft: true, lifecycleState: STATE.PR_DRAFT, loopDisposition: DISPOSITION.ACTION_REQUIRED, ciStatus: "success",
  draftGate: marker("findings_present"), draftGateMarker: marker("findings_present"), unresolvedGateThreadCount: 0, ...overrides,
});
const clean = { draftGate: marker("clean"), draftGateMarker: marker("clean") };

test("no reason names raw gh pr ready in the draft-ready, cap-fixed-ready, draft-gate-next and refused-ready states", () => {
  const states = {
    draftReady: draftAt(clean),
    capFixedReady: draftAt({ draftCapRoundFixed: true }),
    draftGateNext: draftAt(),
    refusedReady: draftAt({
      ...clean,
      sizeBudget: { outcome: "block", wholeLogicLoc: 1961, thresholds: { absoluteHardLoc: 2000 }, waivable: true, reasons: ["over"] },
    }),
  };
  for (const [name, result] of Object.entries(states)) {
    assert.doesNotMatch(result.reason, /gh pr ready/, name);
  }
  assert.match(states.draftReady.reason, /dev-loops pr ready-for-review/);
  assert.match(states.capFixedReady.reason, /dev-loops pr ready-for-review/);
  assert.match(states.draftGateNext.reason, /dev-loops pr ready-for-review/);
  assert.match(states.refusedReady.reason, /dev-loops pr ready-for-review. is refused/);
});
