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

test("PR 2876 case 2: a result with rewritten heads gives evidence_foreign_run", async () => {
  await assert.rejects(withCli((file) => fs.writeFileSync(file, JSON.stringify(result({ actSetId: "0".repeat(16) })))), /evidence_foreign_run/);
});

test("emit-fixer-work-order refuses an unsealed --delta-result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_run_missing/);
});
