import { describe, expect, test } from "bun:test";
import { CAP_ROUND_FIXED_NEXT_ACTION, capRoundShape, decideCapRound, isCapRound, isRoundRefused } from "../src/loop/review-round-cap.mjs";

describe("review-round-cap", () => {
  const cap = 4;
  test.each([
    ["clean before the cap stops early", { round: 2, clean: true }, { allowed: true, stopsEarly: true, fixerRuns: false, nextAfterFix: null }],
    ["cap round with findings lets the fixer run", { round: 4, clean: false, hasFindings: true }, { allowed: true, stopsEarly: false, fixerRuns: true, nextAfterFix: "mark_ready_for_review" }],
    ["round N+1 is refused", { round: 5, clean: false, hasFindings: true }, { allowed: false, stopsEarly: false, fixerRuns: false, nextAfterFix: null }],
    ["below the cap with findings runs the fixer", { round: 1, clean: false, hasFindings: true }, { allowed: true, stopsEarly: false, fixerRuns: true, nextAfterFix: null }],
  ])("%s", (_name, input, expected) => {
    expect(capRoundShape({ cap, ...input })).toEqual(expected);
  });

  test("next action after the cap-round fix is the pre_approval path", () => {
    expect(CAP_ROUND_FIXED_NEXT_ACTION).toBe("mark_ready_for_review");
  });

  test("cap 0 disables the cap", () => {
    expect(isCapRound(3, 0)).toBe(false);
    expect(isRoundRefused(99, 0)).toBe(false);
  });
});

describe("decideCapRound (GATE-EXEC-CAP-BRAKES)", () => {
  const ok = { logicLoc: 10, addedFiles: 0, maxLines: 60 };
  for (const [gate, cap] of [["draft_gate", 4], ["pre_approval_gate", 2]]) {
    const base = { gate, cap, actCounts: [], fixBudget: ok, wholeLogicLoc: 100, forecastWloc: 360 };
    test.each([
      ["a round up to the cap is a full round", { round: cap }, { action: "full_round" }],
      ["round cap+1 within the fix budget is the scoped final round", { round: cap + 1 }, { action: "scoped_final_round" }],
      ["round cap+1 over the logic LOC budget goes to the operator", { round: cap + 1, fixBudget: { ...ok, logicLoc: 61 } }, { action: "operator", reason: "cap_fix_over_budget", numbers: { logicLoc: 61, maxLines: 60, addedFiles: 0 } }],
      ["round cap+1 that adds a file goes to the operator", { round: cap + 1, fixBudget: { ...ok, addedFiles: 1 } }, { action: "operator", reason: "cap_fix_over_budget", numbers: { logicLoc: 10, maxLines: 60, addedFiles: 1 } }],
      ["a round after the scoped round goes to the operator", { round: cap + 2 }, { action: "operator", reason: "round_cap_reached", numbers: { round: cap + 2, cap } }],
      ["a cap of 0 disables the round cap", { round: 9, cap: 0 }, { action: "full_round" }],
      ["3 then 3 acts is non-convergence", { round: 2, actCounts: [3, 3] }, { action: "operator", reason: "non_convergence", numbers: { previous: 3, current: 3 } }],
      ["3 then 4 acts is non-convergence", { round: 2, actCounts: [3, 4] }, { action: "operator", reason: "non_convergence", numbers: { previous: 3, current: 4 } }],
      ["3 then 2 acts continues", { round: 2, actCounts: [3, 2] }, { action: "full_round" }],
      ["one closed round never trips non-convergence", { round: 2, actCounts: [3] }, { action: "full_round" }],
      ["wholeLogicLoc above twice the forecast stops", { round: 1, wholeLogicLoc: 721 }, { action: "operator", reason: "growth_past_forecast", numbers: { wholeLogicLoc: 721, forecastWloc: 360 } }],
      ["wholeLogicLoc at twice the forecast continues", { round: 1, wholeLogicLoc: 720 }, { action: "full_round" }],
      ["no forecast never trips growth", { round: 1, wholeLogicLoc: 9999, forecastWloc: null }, { action: "full_round" }],
    ])(`${gate}: %s`, (_name, input, expected) => {
      expect(decideCapRound({ ...base, ...input })).toEqual(expected);
    });
  }
});
