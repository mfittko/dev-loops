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
const reasons = (findings) => pastCapBlockers(findings).map((b) => `${b.kind}/${b.reason}`);

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
      closed("medium", "defer", { followUpIssueNumber: 2940 }),
      ...Array.from({ length: 4 }, () => closed("low", "reject", r)),
      ...Array.from({ length: 4 }, () => closed("nit", "reject", r)),
    ];
    assert.equal(ledger.length, 13);
    assert.deepEqual(pastCapBlockers(ledger), []);
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
