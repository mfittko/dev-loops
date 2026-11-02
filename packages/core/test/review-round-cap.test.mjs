import { describe, expect, test } from "bun:test";
import { CAP_ROUND_FIXED_NEXT_ACTION, capRoundShape, isCapRound, isRoundRefused } from "../src/loop/review-round-cap.mjs";

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
