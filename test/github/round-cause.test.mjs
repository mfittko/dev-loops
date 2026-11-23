import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";
import { ROUND_CAUSES, deriveRoundCause, resolveRoundCause } from "../../scripts/github/_round-cause.mjs";
import { buildGateContextPath } from "../../scripts/github/_gate-artifact-paths.mjs";
import { withTempDir } from "../_helpers.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const prior = (extra = {}) => ({ headSha: A, ...extra });
const ID = { repo: "o/r", pr: 1, gate: "draft_gate" };
const writeBaseCtx = async (dir, headSha) => {
  const file = path.resolve(dir, buildGateContextPath({ ...ID, headSha, tmpRoot: dir }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ baseFreshness: { status: "current", base: "main" } }));
};

test("ROUND_CAUSES lists the six causes", () => {
  assert.deepEqual([...ROUND_CAUSES], ["first", "developer_findings", "system_rerun", "base_refresh", "body_only", "other_head_move"]);
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

test("T5 a head move after a round with an act item is developer_findings", () => {
  assert.equal(deriveRoundCause({ prior: prior({ findings: [{ judgeDisposition: "defer" }, { judgeDisposition: "act" }] }), headSha: B, baseOnly: false }), "developer_findings");
});

test("T6 a head move after a round without an act item is other_head_move", () => {
  assert.equal(deriveRoundCause({ prior: prior({ findings: [] }), headSha: B, baseOnly: false }), "other_head_move");
  assert.equal(deriveRoundCause({ prior: prior({ findings: [{ judgeDisposition: "defer" }, { judgeDisposition: "reject" }] }), headSha: B, baseOnly: false }), "other_head_move");
  assert.equal(deriveRoundCause({ prior: prior(), headSha: B, baseOnly: false }), "other_head_move");
});

test("T6b a same-head rerun record wins over the no-prior and head-move rules, not the same-head digest rule", () => {
  assert.equal(deriveRoundCause({ prior: undefined, headSha: B, sameHeadRerun: "system_rerun" }), "system_rerun");
  assert.equal(deriveRoundCause({ prior: prior({ findings: [{ judgeDisposition: "act" }] }), headSha: B, sameHeadRerun: "body_only" }), "body_only");
  assert.equal(deriveRoundCause({ prior: prior({ prBodySha256: D1 }), headSha: A, prBodySha256: D2, sameHeadRerun: "system_rerun" }), "body_only");
  assert.equal(deriveRoundCause({ prior: prior({ prBodySha256: D1 }), headSha: A, prBodySha256: D1, sameHeadRerun: "body_only" }), "system_rerun");
});

test("T7 a throwing base probe is called once, never throws and is not base_refresh", async () => {
  await withTempDir(async (dir) => {
    const { writeGateFindingsLog } = await import("../../scripts/github/write-gate-findings-log.mjs");
    const args = { ...ID, verdict: "clean", findings: "[]", tmpRoot: dir, contextTmpRoot: dir };
    await writeGateFindingsLog({ ...args, headSha: A }, { repoRoot: dir });
    await writeBaseCtx(dir, B);
    let calls = 0;
    const baseOnlyMerge = async () => { calls += 1; throw new Error("git"); };
    const { roundCause } = await resolveRoundCause({ ...args, headSha: B, roundIdentity: { completed: true } }, { repoRoot: dir, baseOnlyMerge });
    assert.equal(calls, 1);
    assert.equal(roundCause, "other_head_move");
  });
});

test("T8 the base probe is not called for a first or same-head round and is called once for a head move", async () => {
  await withTempDir(async (dir) => {
    const { writeGateFindingsLog } = await import("../../scripts/github/write-gate-findings-log.mjs");
    const args = { ...ID, verdict: "clean", findings: "[]", tmpRoot: dir, contextTmpRoot: dir };
    await writeBaseCtx(dir, A);
    await writeBaseCtx(dir, B);
    let calls = 0;
    const baseOnlyMerge = async () => { calls += 1; return true; };
    const cause = async (headSha) => (await resolveRoundCause({ ...args, headSha, roundIdentity: { completed: true } }, { repoRoot: dir, baseOnlyMerge })).roundCause;
    assert.equal(await cause(A), "first");
    await writeGateFindingsLog({ ...args, headSha: A }, { repoRoot: dir });
    assert.equal(await cause(A), "system_rerun");
    assert.equal(calls, 0);
    assert.equal(await cause(B), "base_refresh");
    assert.equal(calls, 1);
  });
});

test("T9 a prior ledger with a seal mismatch is excluded with a warning and never throws", async () => {
  await withTempDir(async (dir) => {
    const { writeGateFindingsLog } = await import("../../scripts/github/write-gate-findings-log.mjs");
    const args = { ...ID, verdict: "clean", findings: "[]", tmpRoot: dir, contextTmpRoot: dir };
    const written = await writeGateFindingsLog({ ...args, headSha: A }, { repoRoot: dir });
    const file = path.resolve(dir, written.path);
    await writeFile(file, `${await readFile(file, "utf8")} `);
    const result = await resolveRoundCause({ ...args, headSha: B, roundIdentity: { completed: true } }, { repoRoot: dir });
    assert.equal(result.roundCause, "first");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], new RegExp(`draft_gate-${A}\\.json`));
  });
});
