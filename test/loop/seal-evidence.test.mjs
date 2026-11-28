import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { createEvidenceRun, deltaEvidenceKey, evidenceRunRecordPath, sealEvidence as sealWithBytes, verifyEvidence } from "@dev-loops/core/loop/evidence-seal";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { runCli as sealCli } from "../../scripts/loop/seal-evidence.mjs";
import { emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { A, B } from "./_delta-coverage-fixture.mjs";

const ACT = { ref: "act-1", severity: "low", angle: "correctness", summary: "s", file: "src/a.mjs", judgeDisposition: "act" };
const ACT_LIST = [{ ...ACT, fingerprint: fingerprintFinding(ACT) }];
const ACT_SET_ID = startDeltaSequence({ reviewBaselineHead: A, actList: ACT_LIST }).actSetId;
const RUN_ID = "0123456789abcdef";
const result = (over = {}) => ({ reviewBaselineHead: A, candidateHead: B, actSetId: ACT_SET_ID, runId: RUN_ID, actionableItems: [{ ref: "act-1", status: "resolved", evidence: ["e"] }], newFindings: [], widenedReads: [], outcome: "locally_clear", ...over });
const KEY = deltaEvidenceKey(A, B, RUN_ID);
const EXPECTED = { reviewBaselineHead: A, candidateHead: B, actSetId: ACT_SET_ID, runId: RUN_ID };
const shaOf = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sealEvidence = (dir, file, parsed, bytes = fs.readFileSync(file)) => sealWithBytes(dir, file, parsed, bytes);
const verify = (dir, file, parsed) => verifyEvidence(dir, file, parsed, shaOf(file));
const quiet = { stdout: { write() {} } };

function setup(parsed = result()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-"));
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify(parsed));
  createEvidenceRun(dir, EXPECTED, file);
  return { dir, file };
}
const reason = (fn) => { try { fn(); } catch (error) { return error.reason; } return null; };
const edit = (file, over) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...over }));

test("a sealed file verifies and the record sits under evidence-runs", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  verify(dir, file, result());
  assert.ok(fs.existsSync(evidenceRunRecordPath(dir, KEY)));
});

test("the seal CLI derives the key from the heads and run id and seals; a relative --file resolves against the injected cwd", () => {
  const { dir, file } = setup();
  sealCli(["--kind", "delta", "--file", "result.json", "--tmp-root", dir], { ...quiet, cwd: dir });
  verify(dir, file, result());
});

test("typed refusals: missing run, unsealed, digest mismatch, foreign run", () => {
  const { dir, file } = setup();
  assert.equal(reason(() => verify(dir, file, result({ candidateHead: "d".repeat(40) }))), "evidence_run_missing");
  assert.equal(reason(() => verify(dir, file, result())), "evidence_unsealed");
  sealEvidence(dir, file, result());
  fs.writeFileSync(file, `${JSON.stringify(result())} `);
  assert.equal(reason(() => verify(dir, file, result())), "evidence_digest_mismatch");
  assert.equal(reason(() => sealEvidence(dir, file, result({ candidateHead: "f".repeat(40) }))), "evidence_run_missing");
  assert.equal(reason(() => sealEvidence(dir, file, result({ actSetId: "0".repeat(16) }))), "evidence_foreign_run");
  assert.equal(reason(() => verify(dir, file, result({ actSetId: "0".repeat(16) }))), "evidence_foreign_run");
  assert.equal(reason(() => verify(dir, file, result({ runId: "fedcba9876543210" }))), "evidence_foreign_run");
});

test("a consumer decides on the digest of the bytes it parsed, not on a second read of the path", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  const parsedBytesDigest = shaOf(file);
  edit(file, { newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] });
  verifyEvidence(dir, file, result(), parsedBytesDigest); // the bytes that were parsed are the sealed ones: the later edit does not change this verdict
  assert.equal(reason(() => verifyEvidence(dir, file, result(), shaOf(file))), "evidence_digest_mismatch");
  assert.throws(() => verifyEvidence(dir, file, result()), /requires the sha256/);
});

test("verifyEvidence checks the current-run pointer of the parsed heads before it reads the record", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  const foreign = result({ runId: "fedcba9876543210" });
  assert.equal(reason(() => verify(dir, file, foreign)), "evidence_foreign_run");
});

test("a truncated run record gives a typed evidence_malformed refusal, and record and pointer writes leave no temp file", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  assert.deepEqual(fs.readdirSync(path.join(dir, "evidence-runs")).filter((name) => name.endsWith(".tmp")), []);
  fs.writeFileSync(evidenceRunRecordPath(dir, KEY), '{"key":');
  assert.equal(reason(() => verify(dir, file, result())), "evidence_malformed");
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_malformed");
});

test("PR 2876 case 2b: heads and actSetId copied from the input shape cannot reseal a sealed run", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  const copied = result();
  fs.writeFileSync(file, JSON.stringify({ ...copied, newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] }));
  assert.equal(reason(() => sealEvidence(dir, file, copied)), "evidence_foreign_run");
  assert.equal(reason(() => verify(dir, file, copied)), "evidence_digest_mismatch");
});

test("PR 2876 case 2c: a foreign file with matching heads, act set and run id at another path cannot be sealed", () => {
  const { dir, file } = setup();
  const foreign = path.join(dir, "scratch-x.json");
  fs.writeFileSync(foreign, JSON.stringify(result()));
  assert.equal(reason(() => sealEvidence(dir, foreign, result())), "evidence_foreign_run");
  sealEvidence(dir, file, result());
  verify(dir, file, result());
});

test("emit-fixer-work-order refuses a --delta-result with no run record with evidence_run_missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "commit_only", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_run_missing/);
});

test("a sealed record is final: re-seal of identical bytes and re-seal after an edit are refused, and re-creating the run keeps the seal", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_foreign_run");
  fs.writeFileSync(file, `${JSON.stringify(result())} `);
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_foreign_run");
  createEvidenceRun(dir, EXPECTED, file);
  assert.equal(reason(() => verify(dir, file, result())), "evidence_digest_mismatch");
});

test("a consumer path that differs from the sealed path is evidence_foreign_run, and a symlinked spelling of the sealed path verifies", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  const copy = path.join(dir, "copy.json");
  fs.copyFileSync(file, copy);
  assert.equal(reason(() => verify(dir, copy, result())), "evidence_foreign_run");
  const link = path.join(os.tmpdir(), `seal-evidence-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(dir, link);
  try { verify(dir, path.join(link, "result.json"), result()); } finally { fs.rmSync(link, { force: true }); }
});

test("sealing through a symlinked directory verifies through the real path", () => {
  const { dir, file } = setup();
  const link = path.join(os.tmpdir(), `seal-evidence-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(dir, link);
  try { sealEvidence(dir, path.join(link, "result.json"), result()); } finally { fs.rmSync(link, { force: true }); }
  verify(dir, file, result());
});

test("a non-array actionableItems or newFindings gives evidence_malformed, not a TypeError", async () => {
  for (const over of [{ actionableItems: {} }, { actionableItems: "x" }, { actionableItems: 1 }, { actionableItems: null }, { newFindings: "none" }, { newFindings: {} }, { newFindings: 1 }, { newFindings: null }]) {
    const { dir, file } = setup(result(over));
    assert.throws(() => sealCli(["--kind", "delta", "--file", file, "--tmp-root", dir], quiet), (error) => error.reason === "evidence_malformed" && /\[\] is required/.test(error.message), JSON.stringify(over));
    assert.equal(fs.existsSync(`${evidenceRunRecordPath(dir, KEY)}.sealed`), false);
  }
});

test("the seal is one-time: a claimed seal marker refuses a second sealer even when the record still reads unsealed", () => {
  const { dir, file } = setup();
  fs.writeFileSync(`${evidenceRunRecordPath(dir, KEY)}.sealed`, "");
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_foreign_run");
});

test("a missing current-run pointer with a sealed record gives evidence_run_missing", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  fs.rmSync(path.join(dir, "evidence-runs", `current-delta-${A}-${B}.txt`));
  assert.equal(reason(() => verify(dir, file, result())), "evidence_run_missing");
});

test("emit-fixer-work-order refuses a null --delta-result with evidence_malformed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-null-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, "null");
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "commit_only", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_malformed/);
});

test("seal-evidence --help prints usage and exits cleanly", () => {
  let out = "";
  sealCli(["--help"], { stdout: { write: (s) => { out += s; } } });
  assert.match(out, /Usage: seal-evidence\.mjs/);
});

test("deltaEvidenceKey accepts canonical full SHAs and rejects every other head form", () => {
  const sha1 = "0123456789abcdef0123456789abcdef01234567";
  const sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.equal(deltaEvidenceKey(sha1, sha256, RUN_ID), `delta-${sha1}-${sha256}-${RUN_ID}`);
  for (const head of ["", "undefined", undefined, null, "abc123", "x/../../../other", "0123456789abcdef0123456789abcdef0123456 ", sha1.toUpperCase(), ` ${sha1}`]) {
    assert.equal(reason(() => deltaEvidenceKey(head, sha1, RUN_ID)), "evidence_malformed", `baseline ${JSON.stringify(head)}`);
    assert.equal(reason(() => deltaEvidenceKey(sha1, head, RUN_ID)), "evidence_malformed", `candidate ${JSON.stringify(head)}`);
  }
  for (const id of [undefined, "", "../../x", "ABCDEF0123456789", "0123"]) assert.equal(reason(() => deltaEvidenceKey(sha1, sha1, id)), "evidence_malformed", `run id ${JSON.stringify(id)}`);
});

test("the seal CLI refuses a result without heads, a null result, a traversal head, a missing --file and a wrong --kind, writing no run record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-bad-"));
  const write = (body) => { const file = path.join(dir, "r.json"); fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body)); return file; };
  const seal = (file) => sealCli(["--kind", "delta", "--file", file, "--tmp-root", dir], { ...quiet, cwd: dir });
  assert.throws(() => seal(write({ outcome: "locally_clear" })), /evidence_malformed/);
  assert.throws(() => seal(write("null")), /evidence_malformed/);
  assert.throws(() => seal(write(result({ candidateHead: "x/../../../other" }))), /evidence_malformed/);
  assert.throws(() => sealCli(["--kind", "delta", "--tmp-root", dir], { ...quiet, cwd: dir }), /--kind delta and --file are required/);
  assert.throws(() => sealCli(["--kind", "other", "--file", write(result()), "--tmp-root", dir], { ...quiet, cwd: dir }), /--kind delta and --file are required/);
  assert.equal(fs.existsSync(path.join(dir, "evidence-runs")), false);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("other")), []);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((name) => name.startsWith("other-")), []);
});

test("a run record without expected identity is a typed refusal, not a TypeError", () => {
  const { dir, file } = setup();
  fs.writeFileSync(evidenceRunRecordPath(dir, KEY), `${JSON.stringify({ key: KEY, sealed: null })}\n`);
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_run_missing");
  assert.equal(reason(() => verify(dir, file, result())), "evidence_run_missing");
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
    createEvidenceRun(dir, { ...EXPECTED, candidateHead: A }, sealedPath);
    sealEvidence(dir, sealedPath, sealed);
    fs.writeFileSync(deltaResult, JSON.stringify(foreign ? sealed : { ...sealed, newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] }));
    await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "commit_only", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), expected);
  }
});

test("a briefed result directory that does not exist yet is realpathed through a symlinked prefix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-late-dir-"));
  const link = path.join(os.tmpdir(), `seal-evidence-late-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(dir, link);
  try {
    createEvidenceRun(dir, EXPECTED, path.join(link, "later", "result.json"));
    const file = path.join(dir, "later", "result.json");
    fs.writeFileSync(file, JSON.stringify(result()));
    sealEvidence(dir, file, result());
    verify(dir, file, result());
  } finally { fs.rmSync(link, { force: true }); }
});

test("emit-fixer-work-order refuses a --delta-result whose run was never sealed with evidence_unsealed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-unsealed-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
  createEvidenceRun(dir, { ...EXPECTED, candidateHead: A }, deltaResult);
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "commit_only", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_unsealed/);
});

test("emit-fixer-work-order gives the typed evidence refusal for an edited sealed --delta-result before the membership check", async () => {
  const run = async (over) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-edit-"));
    const actList = path.join(dir, "act-list.json");
    const deltaResult = path.join(dir, "result.json");
    fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
    fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
    createEvidenceRun(dir, { ...EXPECTED, candidateHead: A }, deltaResult);
    sealEvidence(dir, deltaResult, result({ candidateHead: A }));
    edit(deltaResult, over);
    return emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "commit_only", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir });
  };
  await assert.rejects(run({ actionableItems: [{ ref: "act-x", status: "resolved", evidence: ["e"] }] }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_digest_mismatch/);
  await assert.rejects(run({ actSetId: "0".repeat(16) }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_foreign_run/);
});

test("a sealed result of a superseded input run is evidence_foreign_run at verify", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  verify(dir, file, result());
  createEvidenceRun(dir, { ...EXPECTED, runId: "fedcba9876543210" }, path.join(dir, "other.json"));
  assert.equal(reason(() => verify(dir, file, result())), "evidence_foreign_run");
});

test("sealEvidence seals the bytes the caller parsed, not a second read of the path", () => {
  const { dir, file } = setup();
  const parsedBytes = fs.readFileSync(file);
  edit(file, { newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] }); // the file changes after the caller parsed it
  const sealed = sealEvidence(dir, file, result(), parsedBytes);
  assert.equal(sealed.sha256, createHash("sha256").update(parsedBytes).digest("hex"));
  assert.equal(reason(() => verify(dir, file, result())), "evidence_digest_mismatch");
});

test("the seal CLI refuses a contradicting outcome and a bare-string widenedReads entry as evidence_malformed, writes no seal, then seals the corrected file", () => {
  const { dir, file } = setup(result({ actionableItems: [{ ref: "act-1", status: "cannot_verify", evidence: ["the PR body is not a repository file"] }] }));
  const sealOf = () => `${evidenceRunRecordPath(dir, KEY)}.sealed`;
  assert.throws(() => sealCli(["--kind", "delta", "--file", file, "--tmp-root", dir], quiet), (error) => error.reason === "evidence_malformed" && /locally_clear requires every act item resolved/.test(error.message));
  fs.writeFileSync(file, JSON.stringify(result({ widenedReads: ["scripts/x.mjs"] })));
  assert.throws(() => sealCli(["--kind", "delta", "--file", file, "--tmp-root", dir], quiet), (error) => error.reason === "evidence_malformed" && /widenedReads\[0\] needs a path and a reason/.test(error.message));
  assert.equal(fs.existsSync(sealOf()), false);
  fs.writeFileSync(file, JSON.stringify(result({ actionableItems: [{ ref: "act-1", status: "cannot_verify", evidence: ["x"] }], outcome: "needs_fix" })));
  sealCli(["--kind", "delta", "--file", file, "--tmp-root", dir], quiet);
  assert.equal(fs.existsSync(sealOf()), true);
});
