import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { createEvidenceRun, deltaEvidenceKey, evidenceRunRecordPath, sealEvidence, verifyEvidence } from "@dev-loops/core/loop/evidence-seal";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { runCli as sealCli } from "../../scripts/loop/seal-evidence.mjs";
import { runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { A, B, boundArgs } from "./_delta-coverage-fixture.mjs";

const ACT = { ref: "act-1", severity: "low", angle: "correctness", summary: "s", judgeDisposition: "act" };
const ACT_LIST = [{ ...ACT, fingerprint: fingerprintFinding(ACT) }];
const ACT_SET_ID = startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST }).actSetId;
const result = (over = {}) => ({ reviewBaselineHead: A, candidateHead: B, actSetId: ACT_SET_ID, actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }], newFindings: [], widenedReads: [], outcome: "locally_clear", ...over });
const KEY = deltaEvidenceKey(A, B);

function setup(parsed = result()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-"));
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify(parsed));
  createEvidenceRun(dir, KEY, { reviewBaselineHead: A, candidateHead: B, actSetId: ACT_SET_ID });
  return { dir, file };
}
const reason = (fn) => { try { fn(); } catch (error) { return error.reason; } return null; };

test("a sealed file verifies and the record sits under evidence-runs", () => {
  const { dir, file } = setup();
  sealEvidence(dir, KEY, file, result());
  verifyEvidence(dir, KEY, file, result());
  assert.ok(fs.existsSync(evidenceRunRecordPath(dir, KEY)));
});

test("the seal CLI derives the key from the heads and seals", () => {
  const { dir, file } = setup();
  sealCli(["--kind", "delta", "--file", file, "--tmp-root", dir], { stdout: { write() {} } });
  verifyEvidence(dir, KEY, file, result());
});

test("typed refusals: missing run, unsealed, digest mismatch, foreign run", () => {
  const { dir, file } = setup();
  assert.equal(reason(() => verifyEvidence(dir, "delta-none", file, result())), "evidence_run_missing");
  assert.equal(reason(() => verifyEvidence(dir, KEY, file, result())), "evidence_unsealed");
  sealEvidence(dir, KEY, file, result());
  fs.writeFileSync(file, `${JSON.stringify(result())} `);
  assert.equal(reason(() => verifyEvidence(dir, KEY, file, result())), "evidence_digest_mismatch");
  assert.equal(reason(() => sealEvidence(dir, KEY, file, result({ candidateHead: "f".repeat(40) }))), "evidence_foreign_run");
  assert.equal(reason(() => verifyEvidence(dir, KEY, file, result({ actSetId: "0".repeat(16) }))), "evidence_foreign_run");
});

// PR 2876 replays against the real checker.
const withCli = async (edit) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-cli-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const resultPath = path.join(dir, "result.json");
  fs.writeFileSync(resultPath, JSON.stringify(result()));
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--result", resultPath, "--invocation", "1"]);
  edit(resultPath);
  return runDeltaCli(bound.args, { ...bound.seam, stdout: { write() {} } });
};

test("PR 2876 case 1: a finding added after sealing gives evidence_digest_mismatch", async () => {
  await assert.rejects(withCli((file) => fs.writeFileSync(file, JSON.stringify(result({ newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] })))), /evidence_digest_mismatch/);
});

test("PR 2876 case 2: a result with a rewritten actSetId gives evidence_foreign_run", async () => {
  await assert.rejects(withCli((file) => fs.writeFileSync(file, JSON.stringify(result({ actSetId: "0".repeat(16) })))), /evidence_foreign_run/);
});

test("PR 2876 case 2b: heads and actSetId copied from the input shape cannot reseal a sealed run", () => {
  const { dir, file } = setup();
  sealEvidence(dir, KEY, file, result());
  const copied = result();
  fs.writeFileSync(file, JSON.stringify({ ...copied, newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] }));
  assert.equal(reason(() => sealEvidence(dir, KEY, file, copied)), "evidence_foreign_run");
  assert.equal(reason(() => verifyEvidence(dir, KEY, file, copied)), "evidence_digest_mismatch");
});

test("emit-fixer-work-order refuses an unsealed --delta-result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_run_missing/);
});

test("a sealed record is final: re-seal of identical bytes and re-seal after an edit are refused, and a producer re-run keeps the seal", () => {
  const { dir, file } = setup();
  sealEvidence(dir, KEY, file, result());
  assert.equal(reason(() => sealEvidence(dir, KEY, file, result())), "evidence_foreign_run");
  fs.writeFileSync(file, `${JSON.stringify(result())} `);
  assert.equal(reason(() => sealEvidence(dir, KEY, file, result())), "evidence_foreign_run");
  createEvidenceRun(dir, KEY, { reviewBaselineHead: A, candidateHead: B, actSetId: ACT_SET_ID });
  assert.equal(reason(() => verifyEvidence(dir, KEY, file, result())), "evidence_digest_mismatch");
});

test("a consumer path that differs from the sealed path is evidence_foreign_run", () => {
  const { dir, file } = setup();
  sealEvidence(dir, KEY, file, result());
  const copy = path.join(dir, "copy.json");
  fs.copyFileSync(file, copy);
  assert.equal(reason(() => verifyEvidence(dir, KEY, copy, result())), "evidence_foreign_run");
});

test("check-pre-push-delta --result on an unsealed run gives evidence_unsealed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-unsealed-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const resultPath = path.join(dir, "result.json");
  fs.writeFileSync(resultPath, JSON.stringify(result()));
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--result", resultPath, "--invocation", "1"]);
  const tmpRoot = bound.seam.tmpRoot ?? resolveGateArtifactTmpRoot(bound.args[bound.args.indexOf("--worktree") + 1]);
  fs.rmSync(evidenceRunRecordPath(tmpRoot, KEY), { force: true });
  createEvidenceRun(tmpRoot, KEY, { reviewBaselineHead: A, candidateHead: B, actSetId: ACT_SET_ID });
  await assert.rejects(runDeltaCli(bound.args, { ...bound.seam, stdout: { write() {} } }), /evidence_unsealed/);
});

test("a malformed result reports the schema error, not evidence_run_missing", async () => {
  await assert.rejects(withCli((file) => fs.writeFileSync(file, JSON.stringify({ outcome: "locally_clear" }))), (error) => !/evidence_run_missing/.test(error.message));
});

test("emit-fixer-work-order refuses an edited (evidence_digest_mismatch) and a foreign (evidence_foreign_run) --delta-result", async () => {
  // The edit case rewrites the sealed file; the foreign case hands the emitter a byte-identical copy at another path.
  for (const [foreign, expected] of [[false, /evidence_digest_mismatch/], [true, /evidence_foreign_run/]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-"));
    const actList = path.join(dir, "act-list.json");
    const sealedPath = path.join(dir, "result.json");
    const deltaResult = foreign ? path.join(dir, "copy.json") : sealedPath;
    fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
    const sealed = result({ candidateHead: A });
    fs.writeFileSync(sealedPath, JSON.stringify(sealed));
    const key = deltaEvidenceKey(A, A);
    createEvidenceRun(dir, key, { reviewBaselineHead: A, candidateHead: A, actSetId: ACT_SET_ID });
    sealEvidence(dir, key, sealedPath, sealed);
    fs.writeFileSync(deltaResult, JSON.stringify(foreign ? sealed : { ...sealed, newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] }));
    await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), expected);
  }
});
