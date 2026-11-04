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

  describe("soft cap (GATE-EXEC-SOFT-CAP, ADR 0251)", () => {
    const fix = { judgeFix: "the remedy and the test to add" };
    const at = (round) => ({ pr: 2944, round, cap: 4 });
    const blockerReasons = (findings, c) => pastCapBlockers(findings, c).map((b) => b.reason);
    const sd = ["severity_disagreement"];

    test("medium, low, nit and unknown-severity act items never block, with or without judgeFix, new or resurfaced", () => {
      for (const round of [4, 5]) {
        for (const severity of ["medium", "low", "nit", "critical", undefined]) {
          assert.deepEqual(pastCapBlockers([act(severity), act(severity, fix), act(severity, { resurfaces: "abcd" })], at(round)), [], `${severity} round ${round}`);
        }
      }
      assert.deepEqual(reasons([act("medium"), act("low"), act("low")]), []);
      assert.deepEqual(pastCapBlockers([{ summary: "no severity", judgeDisposition: "act" }], at(4)), []);
    });

    test("a failOpen act item does not block", () => {
      assert.deepEqual(pastCapBlockers([act("medium", { failOpen: true }), act("low", { ...fix, failOpen: true })], at(4)), []);
    });

    test("a high act item without judgeFix blocks; at the cap round a high with judgeFix goes to the fixer, after it a high blocks", () => {
      assert.deepEqual(reasons([act("high")]), ["round_cap_reached/new_act"]);
      assert.deepEqual(blockerReasons([act("high")], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("high", { judgeFix: "  " })], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("high", { judgeFix: true })], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("high", { ...fix, resurfaces: "abcd" })], at(5)), ["resurfaced"]);
      assert.deepEqual(pastCapBlockers([act("high", fix)], at(4)), []);
      assert.deepEqual(blockerReasons([act("high", fix)], at(5)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("high", fix)], { pr: 1, round: 4, cap: 0 }), ["new_act"]);
    });

    test("a question-severity act item blocks, even with judgeFix at the cap round", () => {
      assert.deepEqual(blockerReasons([act("question", fix)], at(4)), ["new_act"]);
      assert.deepEqual(blockerReasons([act("question", { resurfaces: "abcd" })], at(4)), ["resurfaced"]);
    });

    test("mediums, lows and nits after the cap round do not block but a high does", () => {
      assert.deepEqual(pastCapBlockers([act("medium"), act("low", fix), act("nit"), act("medium", { resurfaces: "abcd" })], at(5)), []);
      assert.deepEqual(blockerReasons([act("medium"), act("low"), act("high")], at(5)), ["new_act"]);
    });

    test("a medium defer without a follow-up, a medium reject without a reason and a defer to the PR itself do not block", () => {
      assert.deepEqual(pastCapBlockers([closed("medium", "defer"), closed("medium", "defer", { followUpIssueNumber: 0 })], at(4)), []);
      assert.deepEqual(pastCapBlockers([closed("medium", "reject"), closed("medium", "reject", { judgeReason: "  " })], at(4)), []);
      assert.deepEqual(pastCapBlockers([closed("medium", "defer", { followUpIssueNumber: 2944 })], at(4)), []);
      assert.deepEqual(pastCapBlockers([closed("medium", "defer", { followUpIssueNumber: 17 })]), []);
      assert.deepEqual(reasons([closed("low", "defer"), closed("nit", "reject")]), []);
    });

    test("a high defer or reject blocks as severity_disagreement", () => {
      assert.deepEqual(blockerReasons([closed("high", "defer", { followUpIssueNumber: 7 })], at(4)), sd);
      assert.deepEqual(blockerReasons([closed("high", "reject", { judgeReason: "why" })], at(4)), sd);
    });

    test("a failOpen defer or reject blocks at any severity", () => {
      assert.deepEqual(blockerReasons([closed("medium", "reject", { judgeReason: "r", failOpen: true })], at(4)), sd);
      assert.deepEqual(blockerReasons([closed("medium", "defer", { followUpIssueNumber: 7, failOpen: true })], at(4)), sd);
      assert.deepEqual(blockerReasons([closed("low", "reject", { judgeReason: "r", failOpen: true })], at(4)), sd);
    });

    test("a missing disposition or an unknown severity on a closed finding blocks", () => {
      assert.deepEqual(reasons([{ severity: "low", summary: "x" }]), ["round_cap_reached/severity_disagreement"]);
      assert.deepEqual(reasons([closed("critical", "reject")]), ["round_cap_reached/severity_disagreement"]);
    });

    test("the PR 2940 round 4 and PR 2944 round 4 ledger shapes compose no blocker", () => {
      const r = { judgeReason: "recorded reason" };
      const ledger = [
        closed("medium", "reject", r), closed("medium", "reject", { ...r, resurfaces: "0123456789abcdef" }),
        closed("medium", "defer", { followUpIssueNumber: 2937 }), closed("medium", "defer", { followUpIssueNumber: 2940 }),
        ...Array.from({ length: 4 }, () => closed("low", "reject", r)),
        act("medium", { ...fix, resurfaces: "64c4d8f93e0f7ffd" }), act("medium", fix), act("low", fix), act("nit", fix),
      ];
      assert.deepEqual(pastCapBlockers(ledger, { pr: 2940, round: 4, cap: 4 }), []);
      assert.deepEqual(pastCapBlockers(ledger, { pr: 2940, round: 5, cap: 4 }), []);
    });
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
