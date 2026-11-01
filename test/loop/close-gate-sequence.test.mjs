// close-gate-sequence: a sanctioned close of an abandoned fix sequence; a live sequence is never closable.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { readSequenceMarker, recoveryHint, sequenceMarkerPath, writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { pullReceiptPath } from "../../scripts/github/_work-order-protocol.mjs";
import { FIXER_GRACE_MS, closeGateSequence, sequenceClosurePath } from "../../scripts/loop/close-gate-sequence.mjs";
import { withTempDir } from "../_helpers.mjs";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const T0 = Date.parse("2026-11-01T10:00:00Z");
const execution = (dir) => ({ executionIdentity: "f1-abcd1234", workOrderRef: "fixer:o/r#7:head:f1-abcd1234", outputRef: path.join(dir, "out.json") });
const pr = (oid, name = "feat") => async () => ({ pr: { headRefOid: oid, headRefName: name } });
const base = (tmpRoot, extra = {}) => ({ tmpRoot, head: HEAD, repo: "o/r", pr: 7, actor: "tester", now: () => T0, fetchPr: pr(MOVED), ...extra });
const pull = (tmpRoot, ex, pulledAt) => {
  const file = pullReceiptPath(tmpRoot, ex.workOrderRef);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ executionIdentity: ex.executionIdentity, pulledAt }));
};

test("a moved PR head closes: the record is written, then the marker is removed", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    const result = await closeGateSequence(base(tmpRoot));
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(sequenceClosurePath(tmpRoot, HEAD), "utf8")), { baselineHead: HEAD, executionIdentity: ex.executionIdentity, condition: "HEAD_MOVED", actor: "tester", closedAt: "2026-11-01T10:00:00.000Z" });
    assert.equal(existsSync(sequenceMarkerPath(tmpRoot, HEAD)), false);
  });
});

test("an old marker without an execution still closes on a moved head", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    assert.equal((await closeGateSequence(base(tmpRoot))).condition, "HEAD_MOVED");
  });
});

test("a live sequence (head unchanged, fixer dispatched recently) is refused and keeps its marker", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD) }));
    assert.equal(result.refusal, "SEQUENCE-LIVE");
    assert.ok(result.remedy);
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a running fixer is refused even when the head moved", async () => {
  await withTempDir(async (tmpRoot) => {
    const ex = execution(tmpRoot);
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: ex });
    pull(tmpRoot, ex, new Date(T0 - 60_000).toISOString());
    const result = await closeGateSequence(base(tmpRoot));
    assert.equal(result.refusal, "FIXER-RUNNING");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("a work order never pulled past the dispatch grace closes as FIXER_NEVER_PULLED", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat", execution: execution(tmpRoot) });
    const result = await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD), now: () => Date.now() + FIXER_GRACE_MS + 1000 }));
    assert.equal(result.condition, "FIXER_NEVER_PULLED");
  });
});

test("unproven abandonment is refused: no execution, no branch, no PR, wrong branch, absent marker", async () => {
  await withTempDir(async (tmpRoot) => {
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD, branch: "feat" });
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: pr(HEAD) }))).refusal, "ABANDONMENT-UNPROVEN");
    assert.equal((await closeGateSequence(base(tmpRoot, { pr: undefined }))).refusal, "ABANDONMENT-UNPROVEN");
    assert.equal((await closeGateSequence(base(tmpRoot, { fetchPr: pr(MOVED, "other") }))).refusal, "ABANDONMENT-UNPROVEN");
    assert.equal((await closeGateSequence(base(tmpRoot, { head: MOVED }))).refusal, "SEQUENCE-ABSENT");
    writeSequenceMarker({ tmpRoot, baselineHead: HEAD });
    assert.equal((await closeGateSequence(base(tmpRoot))).refusal, "ABANDONMENT-UNPROVEN");
    assert.notEqual(readSequenceMarker(tmpRoot, HEAD), null);
  });
});

test("the hook refusal text names the close command", () => {
  assert.match(recoveryHint("/x/gate-delta/h.sequence"), /dev-loops gate close-sequence/);
});
