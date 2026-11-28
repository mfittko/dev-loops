// No refusal on the delta sequence path ends at an operator `rm` of a sequence marker: each names an agent-runnable next step.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, test } from "bun:test";
import { recoveryHint, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { pullReceiptPath } from "../../scripts/github/_work-order-protocol.mjs";
import { writeSealedGateDeltaRecord } from "../../scripts/loop/_gate-delta-record.mjs";
import { closeGateSequence, fixerGraceMs } from "../../scripts/loop/close-gate-sequence.mjs";
import { SANCTIONED_COMMANDS } from "../../scripts/loop/sanctioned-commands.mjs";
import { withTempDir } from "../_helpers.mjs";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const T0 = Date.parse("2026-11-01T10:00:00Z");
// A host value above the default grace would make the aged timestamps below fall inside the grace.
const HOST_STALE_MAX_AGE = process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
delete process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS;
afterAll(() => { if (HOST_STALE_MAX_AGE !== undefined) process.env.DEVLOOPS_STALE_RUNNER_MAX_AGE_MS = HOST_STALE_MAX_AGE; });

const FORBIDDEN = [/\brm\b/i, /delete the marker/i, /deleting the marker/i, /ask the operator/i];
const sanctionedNames = Object.values(SANCTIONED_COMMANDS).flatMap((group) => Object.values(group)).filter((file) => typeof file === "string").map((file) => path.basename(file));
// A remedy names a sanctioned command (by its script name), one of the loop commands below, or a rerun of the refusing command.
const LOOP_COMMANDS = ["gate close-sequence", "loop pre-push-delta", "emit --phase", "emit-fixer-work-order.mjs"];
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

test("the under-lock recheck and unreadableLive refusals name an agent step and none names a marker delete or an operator", async () => {
  const aged = () => Date.now() + fixerGraceMs() + 60_000; // past the dispatch grace of the marker just written
  const sealed = (tmpRoot, ex, over) => writeSealedGateDeltaRecord(tmpRoot, HEAD, {
    reviewBaselineHead: HEAD, candidateHead: CANDIDATE, actSetId: "0123456789abcdef", invocation: 3, outcome: "bounded_out", nextStep: "push_to_gate", items: [],
    origin: { workOrderRef: ex.workOrderRef, workOrderDigest: "sha256:x", executionIdentity: ex.executionIdentity }, ...over,
  });
  // A busy lock makes the close wait; the wait callback rewrites the sealed record and frees the lock, so only the under-lock recheck sees it.
  const lockWithRewrite = (tmpRoot, rewrite) => {
    const lockDir = path.join(tmpRoot, "gate-delta", `${HEAD}.sequence-lock`);
    mkdirSync(lockDir, { recursive: true });
    return { waitMs: 5000, sleep: async () => { rewrite(); rmSync(lockDir, { recursive: true, force: true }); } };
  };
  const handedBack = (tmpRoot, ex) => {
    const receipt = pullReceiptPath(tmpRoot, ex.workOrderRef);
    mkdirSync(path.dirname(receipt), { recursive: true });
    writeFileSync(receipt, JSON.stringify({ executionIdentity: ex.executionIdentity, pulledAt: new Date(T0 - 60 * 60_000).toISOString() }));
    writeFileSync(ex.outputRef, "{}");
  };
  const refusals = [];
  await withTempDir(async (tmpRoot) => { // BOUNDED_OUT rewritten under the lock
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    handedBack(tmpRoot, ex);
    sealed(tmpRoot, ex, {});
    refusals.push(await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), lock: lockWithRewrite(tmpRoot, () => sealed(tmpRoot, ex, { outcome: "needs_fix", nextStep: "fix_and_rereview" })) })));
  });
  for (const nextStep of ["push", "fix_and_rereview"]) await withTempDir(async (tmpRoot) => { // unreadableLive, with and without an execution
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, execution: ex });
    handedBack(tmpRoot, ex);
    sealed(tmpRoot, ex, { outcome: nextStep === "push" ? "locally_clear" : "needs_fix", nextStep });
    refusals.push(await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: aged })));
    writeFileSync(path.join(tmpRoot, "gate-delta", `${HEAD}.sequence`), "{not json");
    refusals.push(await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: aged })));
  });
  await withTempDir(async (tmpRoot) => { // unreadableLive rewritten under the lock
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, execution: ex });
    handedBack(tmpRoot, ex);
    refusals.push(await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: aged, lock: lockWithRewrite(tmpRoot, () => sealed(tmpRoot, ex, { outcome: "needs_fix", nextStep: "fix_and_rereview" })) })));
  });
  assert.deepEqual(refusals.map((r) => r.refusal), Array(refusals.length).fill("sequence_live"));
  assert.equal(refusals.length, 6);
  assert.match(refusals[1].remedy, /--phase full/);
  for (const [i, r] of refusals.entries()) assertAgentStep(`close-sequence recheck ${i}`, r.remedy);
});

test("every push-authority refusal text names an agent step and none names a marker delete or an operator", () => {
  const marker = "/m/gate-delta/x.sequence";
  const hints = [
    ["branch marker", recoveryHint(HEAD, marker, "issue-a")],
    ["no-branch marker", recoveryHint(HEAD, marker, undefined)],
    ["non-hex baseline", recoveryHint("not-a-sha", marker, "issue-a")],
  ];
  for (const [label, text] of hints) assertAgentStep(`push authority ${label}`, text);
  // The no-branch and non-hex texts name the close command that handles an unreadable marker.
  for (const [, text] of hints.slice(1)) assert.match(text, /gate close-sequence/);
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
