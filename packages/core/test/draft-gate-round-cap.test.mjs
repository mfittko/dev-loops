import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { capClosedFor, isPastRoundCap, pastCapBlockers } from "../src/loop/gate-fanin.mjs";

const act = (severity, extra = {}) => ({ severity, summary: `${severity} act`, judgeDisposition: "act", ...extra });
const closed = (severity, judgeDisposition, extra = {}) => ({ severity, summary: `${severity} ${judgeDisposition}`, judgeDisposition, ...extra });
const ctx = { round: 4, cap: 4 };
const reasons = (findings) => pastCapBlockers(findings, ctx).map((b) => `${b.kind}/${b.reason}`);

describe("draft_gate round cap", () => {
  test("isPastRoundCap: count at or above the cap, never with cap 0", () => {
    assert.equal(isPastRoundCap(3, 4), false);
    assert.equal(isPastRoundCap(4, 4), true);
    assert.equal(isPastRoundCap(9, 0), false);
  });

  test("a new high or medium act item blocks with round_cap_reached", () => {
    assert.deepEqual(reasons([act("high")]), ["round_cap_reached/new_act"]);
    assert.deepEqual(reasons([act("medium")]), ["round_cap_reached/new_act"]);
  });

  test("an all-low and an all-nit act list raise no blocker (the low/nit convergence rule applies)", () => {
    assert.deepEqual(reasons([act("low"), act("low")]), []);
    assert.deepEqual(reasons([act("nit")]), []);
  });

  test("a mixed round blocks every new act item", () => {
    assert.deepEqual(reasons([act("medium"), act("low"), act("low")]), Array(3).fill("round_cap_reached/new_act"));
  });

  test("a re-surfaced act item is not new", () => {
    assert.deepEqual(reasons([act("medium", { resurfaces: "abcd" })]), []);
  });

  test("defer and reject of low or nit are cap-closed without a blocker; high or medium is a severity_disagreement", () => {
    assert.deepEqual(reasons([closed("low", "defer"), closed("nit", "reject")]), []);
    assert.deepEqual(reasons([closed("medium", "reject")]), ["round_cap_reached/severity_disagreement"]);
    assert.deepEqual(reasons([closed("high", "defer")]), ["round_cap_reached/severity_disagreement"]);
  });

  test("a missing disposition or an unknown severity is a severity_disagreement", () => {
    assert.deepEqual(reasons([{ severity: "low", summary: "x" }]), ["round_cap_reached/severity_disagreement"]);
    assert.deepEqual(reasons([closed("critical", "reject")]), ["round_cap_reached/severity_disagreement"]);
  });

  test("capClosedFor records defer and reject, never act, and never a locatable question", () => {
    assert.deepEqual(capClosedFor(closed("low", "defer"), ctx), { judgeDisposition: "defer", severity: "low", round: 4, cap: 4 });
    assert.deepEqual(capClosedFor(closed("nit", "reject"), ctx), { judgeDisposition: "reject", severity: "nit", round: 4, cap: 4 });
    assert.equal(capClosedFor(act("low"), ctx), null);
    assert.equal(capClosedFor(closed("question", "reject", { file: "a.mjs", line: 3 }), ctx), null);
    assert.notEqual(capClosedFor(closed("question", "reject"), ctx), null);
  });
});
