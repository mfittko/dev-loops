import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "bun:test";
import { capClosedFor, isPastRoundCap, pastCapBlockers } from "../src/loop/gate-fanin.mjs";
import { countCompletedRounds } from "../../../scripts/github/write-gate-context.mjs";

const act = (severity, extra = {}) => ({ severity, summary: `${severity} act`, judgeDisposition: "act", ...extra });
const closed = (severity, judgeDisposition, extra = {}) => ({ severity, summary: `${severity} ${judgeDisposition}`, judgeDisposition, ...extra });
const ctx = { round: 4, cap: 4 };
const reasons = (findings) => pastCapBlockers(findings, { pr: 9999 }).map((b) => `${b.kind}/${b.reason}`);

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

  test("a re-surfaced high or medium act item blocks as resurfaced; re-surfaced low and nit follow the low/nit rule", () => {
    assert.deepEqual(reasons([act("medium", { resurfaces: "abcd" })]), ["round_cap_reached/resurfaced"]);
    assert.deepEqual(reasons([act("high", { resurfaces: "abcd" }), act("low", { resurfaces: "ef01" })]), ["round_cap_reached/resurfaced"]);
    assert.deepEqual(reasons([act("low", { resurfaces: "abcd" }), act("nit", { resurfaces: "ef01" })]), []);
  });

  test("defer and reject of low or nit are cap-closed without a blocker; a high is a severity_disagreement", () => {
    assert.deepEqual(reasons([closed("low", "defer"), closed("nit", "reject")]), []);
    assert.deepEqual(reasons([closed("high", "defer", { followUpIssueNumber: 7 })]), ["round_cap_reached/severity_disagreement"]);
    assert.deepEqual(reasons([closed("high", "reject", { judgeReason: "why" })]), ["round_cap_reached/severity_disagreement"]);
  });

  test("a medium rejected with a reason or deferred with a target issue is final and raises no blocker", () => {
    assert.deepEqual(reasons([closed("medium", "reject", { judgeReason: "out of scope" }), closed("medium", "defer", { followUpIssueNumber: 2940 })]), []);
  });

  test("a medium defer to the PR itself is not a target; another issue is final", () => {
    const deferred = [closed("medium", "defer", { followUpIssueNumber: 17 })];
    assert.deepEqual(pastCapBlockers(deferred, { pr: 17 }).map((b) => b.reason), ["severity_disagreement"]);
    assert.deepEqual(pastCapBlockers(deferred, { pr: 18 }), []);
  });

  test("a medium reject without a reason, a medium defer without a target and a failOpen finding still block", () => {
    const blocked = ["round_cap_reached/severity_disagreement"];
    assert.deepEqual(reasons([closed("medium", "reject")]), blocked);
    assert.deepEqual(reasons([closed("medium", "reject", { judgeReason: "  " })]), blocked);
    assert.deepEqual(reasons([closed("medium", "defer")]), blocked);
    assert.deepEqual(reasons([closed("medium", "defer", { followUpIssueNumber: 0 })]), blocked);
    assert.deepEqual(reasons([closed("medium", "reject", { judgeReason: "r", failOpen: true })]), blocked);
    assert.deepEqual(reasons([closed("low", "reject", { judgeReason: "r", failOpen: true })]), blocked);
  });

  test("replay of the PR 2940 round 4 ledger shape composes no blocker", () => {
    const r = { judgeReason: "recorded reason" };
    const ledger = [
      closed("medium", "reject", r), closed("medium", "reject", r), closed("medium", "reject", r),
      closed("medium", "reject", { ...r, resurfaces: "0123456789abcdef" }),
      closed("medium", "defer", { followUpIssueNumber: 2937 }),
      ...Array.from({ length: 4 }, () => closed("low", "reject", r)),
      ...Array.from({ length: 4 }, () => closed("nit", "reject", r)),
    ];
    assert.equal(ledger.length, 13);
    assert.deepEqual(pastCapBlockers(ledger, { pr: 2940, round: 4, cap: 4 }), []);
    // the original ledger deferred to the PR itself, which is not a target
    const selfDefer = [closed("medium", "defer", { followUpIssueNumber: 2940 })];
    assert.deepEqual(pastCapBlockers(selfDefer, { pr: 2940, round: 4, cap: 4 }).map((b) => b.reason), ["severity_disagreement"]);
  });

  test("a medium defer is not final when pr is not an integer (fail closed)", () => {
    const deferred = [closed("medium", "defer", { followUpIssueNumber: 17 })];
    assert.deepEqual(pastCapBlockers(deferred).map((b) => b.reason), ["severity_disagreement"]);
    assert.deepEqual(pastCapBlockers(deferred, { pr: Number.NaN }).map((b) => b.reason), ["severity_disagreement"]);
  });

  describe("closure round (ADR 0191, #2937 S4a)", () => {
    const fix = { judgeFix: "the remedy and the test to add" };
    const at = (round) => ({ pr: 2944, round, cap: 4 });
    // Shape of the PR 2944 draft_gate round 4 ledger at e869fb2f8: act mediums with remedies (some resurfaced), low/nit acts, a medium defer.
    const replay = () => [
      act("medium", { ...fix, resurfaces: "64c4d8f93e0f7ffd" }),
      act("medium", { ...fix, resurfaces: "a14963ebd69de8ca" }),
      act("medium", fix),
      act("low", fix), act("low", { ...fix, resurfaces: "64c4d8f93e0f7ffd" }), act("nit", fix),
      closed("medium", "defer", { ...fix, followUpIssueNumber: 2940 }),
    ];
    const blockerReasons = (findings, ctx) => pastCapBlockers(findings, ctx).map((b) => b.reason);

    test("the PR 2944 round 4 shape raises no blocker at the cap round and blocks at cap+1 and cap+2", () => {
      assert.deepEqual(pastCapBlockers(replay(), at(4)), []);
      assert.equal(blockerReasons(replay(), at(5)).filter((r) => r === "resurfaced").length, 3);
      assert.ok(blockerReasons(replay(), at(5)).length >= 3);
      assert.ok(blockerReasons(replay(), at(6)).length >= 3, "a second closure round is refused");
    });

    test("without round and cap, and for an act item with no judgeFix, the cap round blocks as before", () => {
      assert.deepEqual(blockerReasons([act("medium", fix)], {}), ["new_act"]);
      assert.deepEqual(blockerReasons([act("medium")], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("medium", { judgeFix: "  " })], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("medium", fix)], { pr: 1, round: 4, cap: 0 }), ["new_act"]);
    });

    test("a closure round with a remaining act item blocks; a new out-of-delta act blocks; the same finding judged defer with a target is final", () => {
      assert.deepEqual(blockerReasons([act("medium", { ...fix, resurfaces: "abcd" })], at(5)), ["resurfaced"]);
      assert.deepEqual(blockerReasons([act("medium", fix)], at(5)), ["new_act"]);
      assert.deepEqual(pastCapBlockers([closed("medium", "defer", { ...fix, followUpIssueNumber: 2950 })], at(5)), []);
    });

    test("at the cap round an unknown, missing or question severity act item with judgeFix still blocks; high and medium do not", () => {
      assert.deepEqual(pastCapBlockers([act("high", fix), act("medium", fix)], at(4)), []);
      assert.deepEqual(blockerReasons([act("critical", fix)], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([{ summary: "no severity", judgeDisposition: "act", ...fix }], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("question", fix)], at(4)), ["new_act"]);
    });

    test("a non-string or blank judgeFix does not count as a remedy and a non-string or blank judgeReason is not final", () => {
      for (const judgeFix of [true, 1, {}, "   "]) assert.deepEqual(blockerReasons([act("medium", { judgeFix })], at(4)), ["new_act"], String(judgeFix));
      for (const judgeReason of [1, {}, "   "]) assert.deepEqual(blockerReasons([closed("medium", "reject", { judgeReason })], at(5)), ["severity_disagreement"], String(judgeReason));
    });

    test("a failOpen act item with judgeFix at the cap round has no blocker", () => {
      assert.deepEqual(pastCapBlockers([act("medium", { ...fix, failOpen: true })], at(4)), []);
      assert.deepEqual(blockerReasons([act("medium", { failOpen: true })], at(4)), ["new_act"]);
    });

    test("a failOpen reject or defer at the cap round blocks", () => {
      const sd = ["severity_disagreement"];
      assert.deepEqual(blockerReasons([closed("medium", "reject", { judgeReason: "r", failOpen: true })], at(4)), sd);
      assert.deepEqual(blockerReasons([closed("medium", "defer", { followUpIssueNumber: 7, failOpen: true })], at(4)), sd);
    });

    test("a failOpen act item with judgeFix at round cap+1 blocks", () => {
      assert.deepEqual(blockerReasons([act("medium", { ...fix, failOpen: true })], at(5)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("medium", { ...fix, failOpen: true, resurfaces: "abcd" })], at(5)), ["resurfaced"]);
    });

    test("a high defer or reject and an unreasoned medium still block at the cap round; judged medium reject or defer stays final", () => {
      const sd = ["severity_disagreement"];
      assert.deepEqual(blockerReasons([closed("high", "defer", { followUpIssueNumber: 7 })], at(4)), sd);
      assert.deepEqual(blockerReasons([closed("high", "reject", { judgeReason: "why" })], at(4)), sd);
      assert.deepEqual(blockerReasons([closed("medium", "reject")], at(4)), sd);
      assert.deepEqual(pastCapBlockers([closed("medium", "reject", { judgeReason: "why" }), closed("medium", "defer", { followUpIssueNumber: 7 })], at(4)), []);
    });
  });

  test("a missing disposition or an unknown severity is a severity_disagreement", () => {
    assert.deepEqual(reasons([{ severity: "low", summary: "x" }]), ["round_cap_reached/severity_disagreement"]);
    assert.deepEqual(reasons([closed("critical", "reject")]), ["round_cap_reached/severity_disagreement"]);
  });

  test("countCompletedRounds counts closed and unreadable in-range ledgers plus the posted round, never a foreign ledger, a blocked ledger or a sidecar", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "draft-gate-round-count-"));
    try {
      const dir = path.join(tmpRoot, "gate-findings", "owner-repo", "pr-5");
      await mkdir(dir, { recursive: true });
      const head = (c) => c.repeat(40);
      const ledger = (h, extra) => JSON.stringify({ repo: "owner/repo", pr: 5, gate: "draft_gate", headSha: h, loggedAt: "2026-10-27T00:00:00.000Z", ...extra });
      await writeFile(path.join(dir, `draft_gate-${head("1")}.json`), ledger(head("1"), { verdict: "findings_present" }), "utf8");
      await writeFile(path.join(dir, `draft_gate-${head("2")}.json`), "{not json", "utf8");
      await writeFile(path.join(dir, `draft_gate-${head("3")}.json`), ledger(head("3"), { verdict: "findings_present", repo: "other/repo" }), "utf8");
      await writeFile(path.join(dir, `draft_gate-${head("4")}.json`), ledger(head("4"), { verdict: "blocked" }), "utf8");
      await writeFile(path.join(dir, `draft_gate-${head("6")}.json`), ledger(head("6"), { verdict: "clean" }), "utf8");
      await writeFile(path.join(dir, `draft_gate-${head("7")}.json`), ledger(head("7"), {}), "utf8");
      await writeFile(path.join(dir, `draft_gate-${head("1")}.act-list.json`), "[]", "utf8");
      const round = await countCompletedRounds({ repo: "owner/repo", pr: 5, gate: "draft_gate", headSha: head("5"), tmpRoot }, { repoRoot: tmpRoot });
      assert.equal(round, 2 + 2 + 1, "findings_present and clean closed, unparseable and missing-verdict unreadable, plus the posted round");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("capClosedFor records defer and reject, never act, and never a locatable question", () => {
    assert.deepEqual(capClosedFor(closed("low", "defer"), ctx), { judgeDisposition: "defer", severity: "low", round: 4, cap: 4 });
    assert.deepEqual(capClosedFor(closed("nit", "reject"), ctx), { judgeDisposition: "reject", severity: "nit", round: 4, cap: 4 });
    assert.equal(capClosedFor(act("low"), ctx), null);
    assert.equal(capClosedFor(closed("question", "reject", { file: "a.mjs", line: 3 }), ctx), null);
    assert.notEqual(capClosedFor(closed("question", "reject"), ctx), null);
  });
});

describe("rounds after the cap round block on any act item", () => {
  const after = { pr: 9999, round: 5, cap: 4 };
  const blockerReasons = (findings, c) => pastCapBlockers(findings, c).map((b) => b.reason);

  test("an all-low or all-nit act list blocks at cap+1 and raises none at the cap round", () => {
    assert.deepEqual(blockerReasons([act("low"), act("nit")], after), ["new_act", "new_act"]);
    assert.deepEqual(blockerReasons([act("nit", { resurfaces: "abcd" })], after), ["resurfaced"]);
    assert.deepEqual(blockerReasons([act("low")], { ...after, round: 4 }), []);
    assert.deepEqual(blockerReasons([act("low")], { ...after, round: 3 }), []);
  });
});
