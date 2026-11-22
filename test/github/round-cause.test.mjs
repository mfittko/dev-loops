import assert from "node:assert/strict";
import { test } from "bun:test";
import { ROUND_CAUSES, deriveRoundCause, resolveRoundCause } from "../../scripts/github/_round-cause.mjs";
import { withTempDir } from "../_helpers.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const prior = (extra = {}) => ({ headSha: A, ...extra });

test("ROUND_CAUSES lists the five causes", () => {
  assert.deepEqual([...ROUND_CAUSES], ["first", "developer_findings", "system_rerun", "base_refresh", "body_only"]);
});

test("T1 no prior round is first", () => {
  assert.equal(deriveRoundCause({ prior: undefined, headSha: A, baseOnly: false }), "first");
});

test("T2 same head with equal or missing digests is system_rerun", () => {
  assert.equal(deriveRoundCause({ prior: prior({ prBodySha256: D1 }), headSha: A.toUpperCase(), prBodySha256: D1 }), "system_rerun");
  assert.equal(deriveRoundCause({ prior: prior(), headSha: A, prBodySha256: D1 }), "system_rerun");
  assert.equal(deriveRoundCause({ prior: prior({ prBodySha256: D1 }), headSha: A }), "system_rerun");
});

test("T3 same head with different digests is body_only", () => {
  assert.equal(deriveRoundCause({ prior: prior({ prBodySha256: D1 }), headSha: A, prBodySha256: D2 }), "body_only");
});

test("T4 a base-only head move is base_refresh even when the prior had act items", () => {
  const withAct = prior({ findings: [{ judgeDisposition: "act" }] });
  assert.equal(deriveRoundCause({ prior: withAct, headSha: B, baseOnly: true }), "base_refresh");
});

test("T5 and T6 a head move that is not base-only is developer_findings", () => {
  assert.equal(deriveRoundCause({ prior: prior({ findings: [{ judgeDisposition: "act" }] }), headSha: B, baseOnly: false }), "developer_findings");
  assert.equal(deriveRoundCause({ prior: prior({ findings: [] }), headSha: B, baseOnly: false }), "developer_findings");
});

test("T7 a throwing base probe never throws and is not base_refresh", async () => {
  await withTempDir(async (dir) => {
    const { writeGateFindingsLog } = await import("../../scripts/github/write-gate-findings-log.mjs");
    const args = { repo: "o/r", pr: 1, gate: "draft_gate", verdict: "clean", findings: "[]", tmpRoot: dir, contextTmpRoot: dir };
    await writeGateFindingsLog({ ...args, headSha: A }, { repoRoot: dir });
    const cause = await resolveRoundCause({ ...args, headSha: B, roundIdentity: { completed: true } }, { repoRoot: dir, baseOnlyMerge: async () => { throw new Error("git"); } });
    assert.equal(cause, "developer_findings");
  });
});

test("T8 the base probe is not called for a first or same-head round", async () => {
  await withTempDir(async (dir) => {
    const { writeGateFindingsLog } = await import("../../scripts/github/write-gate-findings-log.mjs");
    const args = { repo: "o/r", pr: 1, gate: "draft_gate", verdict: "clean", findings: "[]", tmpRoot: dir, contextTmpRoot: dir };
    let calls = 0;
    const baseOnlyMerge = async () => { calls += 1; return true; };
    assert.equal(await resolveRoundCause({ ...args, headSha: A, roundIdentity: { completed: true } }, { repoRoot: dir, baseOnlyMerge }), "first");
    await writeGateFindingsLog({ ...args, headSha: A }, { repoRoot: dir });
    assert.equal(await resolveRoundCause({ ...args, headSha: A, roundIdentity: { completed: true } }, { repoRoot: dir, baseOnlyMerge }), "system_rerun");
    assert.equal(calls, 0);
  });
});
