// No refusal on the delta sequence path ends at an operator `rm` of a sequence marker: each names an agent-runnable next step.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { renderGuardHook } from "@dev-loops/core/loop/default-branch-guard";
import { recoveryHint, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { pullReceiptPath } from "../../scripts/github/_work-order-protocol.mjs";
import { gateDeltaRecordPath } from "../../scripts/loop/_gate-delta-record.mjs";
import { closeGateSequence } from "../../scripts/loop/close-gate-sequence.mjs";
import { assertDeltaClearsFullPhase } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { SANCTIONED_COMMANDS } from "../../scripts/loop/sanctioned-commands.mjs";
import { withTempDir } from "../_helpers.mjs";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const T0 = Date.parse("2026-11-01T10:00:00Z");

const FORBIDDEN = [/\brm\b/i, /delete the marker/i, /deleting the marker/i, /ask the operator/i];
const sanctionedNames = Object.values(SANCTIONED_COMMANDS).flatMap((group) => Object.values(group)).filter((file) => typeof file === "string").map((file) => path.basename(file));
// A remedy names a sanctioned command (by its script name), one of the loop commands below, or a rerun of the refusing command.
const LOOP_COMMANDS = ["gate close-sequence", "loop pre-push-delta", "check-pre-push-delta.mjs", "emit --phase"];
const RERUN = /\b[Rr]erun\b|[Rr]e-run|\bWait for\b|Pass --repo|Pass the --/u;
const NAMES_AGENT_STEP = { test: (text) => RERUN.test(text) || [...sanctionedNames, ...LOOP_COMMANDS].some((name) => text.includes(name)) };
const assertAgentStep = (label, text) => {
  assert.ok(NAMES_AGENT_STEP.test(text), `${label} names no agent step: ${text}`);
  for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${label} matches ${pattern}: ${text}`);
};

const execution = (dir) => ({ executionIdentity: "f1-abcd1234", workOrderRef: "fixer:o/r#7:head:f1-abcd1234", outputRef: path.join(dir, "out.json") });
const pr = (oid) => async () => ({ pr: { headRefOid: oid, headRefName: "feat" } });
const base = (tmpRoot, extra = {}) => ({ tmpRoot, head: HEAD, repo: "o/r", pr: 7, actor: "tester", now: () => T0, fetchPr: pr(MOVED), branchActivityMs: () => null, ...extra });

test("every close-sequence refusal names an agent step and none names a marker delete or an operator", async () => {
  await withTempDir(async (tmpRoot) => {
    const refusals = [];
    refusals.push(await closeGateSequence(base(tmpRoot))); // sequence_absent
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    refusals.push(await closeGateSequence(base(tmpRoot, { hasCommit: () => false }))); // baseline_unknown
    refusals.push(await closeGateSequence(base(tmpRoot, { pr: undefined }))); // abandonment_unproven (no PR)
    refusals.push(await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD) }))); // abandonment_unproven (no execution)
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    refusals.push(await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD) }))); // sequence_live
    const receipt = pullReceiptPath(tmpRoot, ex.workOrderRef);
    mkdirSync(path.dirname(receipt), { recursive: true });
    writeFileSync(receipt, JSON.stringify({ executionIdentity: ex.executionIdentity, pulledAt: new Date(T0 - 60_000).toISOString() }));
    refusals.push(await closeGateSequence(base(tmpRoot))); // fixer_running
    assert.deepEqual(refusals.map((r) => r.refusal), ["sequence_absent", "baseline_unknown", "abandonment_unproven", "abandonment_unproven", "sequence_live", "fixer_running"]);
    for (const r of refusals) assertAgentStep(`close-sequence ${r.refusal}`, `${r.remedy}`);
  });
});

test("every push-authority refusal text names an agent step and none names a marker delete or an operator", () => {
  const marker = "/m/gate-delta/x.sequence";
  const hints = [
    ["branch marker", recoveryHint(HEAD, marker, "issue-a")],
    ["no-branch marker", recoveryHint(HEAD, marker, undefined)],
    ["non-hex baseline", recoveryHint("not-a-sha", marker, "issue-a")],
  ];
  const hook = renderGuardHook("pre-push", ["main"], null, "/x/check-fix-push-authority.mjs");
  const fallback = hook.split("\n").find((line) => line.includes("the push-authority check script is missing"));
  assert.ok(fallback, "the fallback hook text exists");
  for (const [label, text] of [...hints, ["fallback hook", fallback]]) assertAgentStep(`push authority ${label}`, text);
  // The no-branch and non-hex texts name the close command that handles an unreadable marker.
  for (const [, text] of hints.slice(1)) assert.match(text, /gate close-sequence/);
});

test("every --phase full delta refusal names an agent step and none names a marker delete or an operator", async () => {
  await withTempDir(async (tmpRoot) => {
    const record = { reviewBaselineHead: HEAD, candidateHead: CANDIDATE, actSetId: "set", invocation: 1, outcome: "locally_clear", nextStep: "push", items: [{ ref: "r", status: "resolved" }] };
    const writeRecord = (over = {}) => {
      mkdirSync(path.dirname(gateDeltaRecordPath(tmpRoot, HEAD)), { recursive: true });
      writeFileSync(gateDeltaRecordPath(tmpRoot, HEAD), JSON.stringify({ ...record, ...over }));
    };
    const delta = { actSetId: "set", outcome: "locally_clear", candidateHead: CANDIDATE, actionableItems: [{ ref: "r", status: "resolved" }] };
    const refusalOf = (args) => { try { assertDeltaClearsFullPhase({ tmpRoot, headSha: HEAD, ...args }); } catch (error) { return error.message; } throw new Error("no refusal"); };
    const cases = [];
    writeRecord({ nextStep: "fix_and_rereview", outcome: "needs_fix" });
    cases.push(["non-clearing record", refusalOf({ delta })]);
    writeRecord();
    cases.push(["no --delta-result", refusalOf({ delta: undefined })]);
    cases.push(["other act set", refusalOf({ delta: { ...delta, actSetId: "other" } })]);
    cases.push(["item statuses differ", refusalOf({ delta: { ...delta, actionableItems: [{ ref: "r", status: "cannot_verify" }] } })]);
    cases.push(["HEAD past the candidate", refusalOf({ delta, candidateHead: MOVED })]);
    writeRecord({ reviewBaselineHead: MOVED });
    cases.push(["baseline differs", refusalOf({ delta, candidateHead: CANDIDATE })]);
    const threads = [{ threadId: "T1" }];
    cases.push(["thread candidate differs", refusalOf({ delta: undefined, threads, candidateHead: MOVED })]);
    writeRecord({ items: [{ ref: "T9", status: "resolved" }] });
    cases.push(["unbound thread ref", refusalOf({ delta: undefined, threads, candidateHead: CANDIDATE })]);
    writeRecord({ items: [] });
    cases.push(["uncovered thread", refusalOf({ delta: undefined, threads, candidateHead: CANDIDATE })]);
    assert.match(cases.find(([label]) => label === "HEAD past the candidate")[1], /head_moved/);
    for (const [label, text] of cases) assertAgentStep(`--phase full ${label}`, text);
  });
});

test("the contract names BOUNDED_OUT and MARKER_UNREADABLE and no longer ends a marker by deleting it", () => {
  const contract = readFileSync("skills/docs/pre-pr-review-contract.md", "utf8");
  assert.match(contract, /`BOUNDED_OUT`/);
  assert.match(contract, /`MARKER_UNREADABLE`/);
  assert.doesNotMatch(contract, /deleting the marker ends it/);
  assert.doesNotMatch(contract, /ask the operator to delete/);
});

test("the --phase full evidence and membership refusals in emit-fixer-work-order name a rerun of the --result step", () => {
  const source = readFileSync("scripts/loop/emit-fixer-work-order.mjs", "utf8");
  for (const needle of ["refused (GATE-EXEC-EVIDENCE-SEALED): ${error.message}", "does not belong to this act list at ${headSha}"]) {
    const line = source.split("\n").find((l) => l.includes(needle));
    assert.ok(line, `refusal text for ${needle} exists`);
    assertAgentStep(`--phase full ${needle}`, line);
  }
});
