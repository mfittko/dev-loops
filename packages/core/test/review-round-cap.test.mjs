import { describe, expect, test } from "bun:test";
import { decideCapRound, isCapRound, isRoundRefused } from "../src/loop/review-round-cap.mjs";

describe("review-round-cap", () => {
  test("cap 0 disables the cap", () => {
    expect(isCapRound(3, 0)).toBe(false);
    expect(isRoundRefused(99, 0)).toBe(false);
  });
});

describe("decideCapRound (GATE-EXEC-CAP-BRAKES)", () => {
  const ok = { logicLoc: 10, addedFiles: 0, maxLines: 60 };
  for (const [gate, cap] of [["draft_gate", 4], ["pre_approval_gate", 2]]) {
    const base = { gate, cap, fixBudget: ok, wholeLogicLoc: 100, forecastWloc: 360 };
    test.each([
      ["a round up to the cap is a full round", { round: cap }, { action: "full_round" }],
      ["round cap+1 within the fix budget is the scoped final round", { round: cap + 1 }, { action: "scoped_final_round" }],
      ["round cap+1 over the logic LOC budget goes to the operator", { round: cap + 1, fixBudget: { ...ok, logicLoc: 61 } }, { action: "operator", reason: "cap_fix_over_budget", numbers: { logicLoc: 61, maxLines: 60, addedFiles: 0 } }],
      ["round cap+1 that adds a file goes to the operator", { round: cap + 1, fixBudget: { ...ok, addedFiles: 1 } }, { action: "operator", reason: "cap_fix_over_budget", numbers: { logicLoc: 10, maxLines: 60, addedFiles: 1 } }],
      ["a round after the scoped round goes to the operator", { round: cap + 2 }, { action: "operator", reason: "round_cap_reached", numbers: { round: cap + 2, cap } }],
      ["a cap of 0 disables the round cap", { round: 9, cap: 0 }, { action: "full_round" }],
      ["wholeLogicLoc above twice the forecast stops", { round: 1, wholeLogicLoc: 721 }, { action: "operator", reason: "growth_past_forecast", numbers: { wholeLogicLoc: 721, forecastWloc: 360 } }],
      ["wholeLogicLoc at twice the forecast continues", { round: 1, wholeLogicLoc: 720 }, { action: "full_round" }],
      ["no forecast never trips growth", { round: 1, wholeLogicLoc: 9999, forecastWloc: null }, { action: "full_round" }],
    ])(`${gate}: %s`, (_name, input, expected) => {
      expect(decideCapRound({ ...base, ...input })).toEqual(expected);
    });
  }
});
