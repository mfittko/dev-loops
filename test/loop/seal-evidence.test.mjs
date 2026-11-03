import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { createEvidenceRun, deltaEvidenceKey, evidenceRunRecordPath, mintEvidenceRunId, sealEvidence as sealWithBytes, verifyEvidence } from "@dev-loops/core/loop/evidence-seal";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { runCli as sealCli } from "../../scripts/loop/seal-evidence.mjs";
import { runCli as runDeltaCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { emitFixerWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { A, B, boundArgs, coverageRepo } from "./_delta-coverage-fixture.mjs";

const ACT = { ref: "act-1", severity: "low", angle: "correctness", summary: "s", judgeDisposition: "act" };
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
  createEvidenceRun(dir, KEY, EXPECTED, file);
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

// PR 2876 replays against the real checker.
const withCli = async (editFile) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-cli-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const resultPath = path.join(dir, "result.json");
  fs.writeFileSync(resultPath, JSON.stringify(result()));
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--result", resultPath, "--invocation", "1"]);
  editFile(resultPath);
  return runDeltaCli(bound.args, { ...bound.seam, ...quiet });
};

test("PR 2876 case 1: a finding added after sealing gives evidence_digest_mismatch", async () => {
  await assert.rejects(withCli((file) => edit(file, { newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] })), /evidence_digest_mismatch/);
});

test("a result with a rewritten actSetId gives evidence_foreign_run", async () => {
  await assert.rejects(withCli((file) => edit(file, { actSetId: "0".repeat(16) })), /evidence_foreign_run/);
});

test("PR 2876 case 2: a foreign result with its heads rewritten to the current run keeps its own run id and gives evidence_foreign_run", async () => {
  await assert.rejects(withCli((file) => edit(file, { runId: "fedcba9876543210" })), /evidence_foreign_run/);
});

test("PR 2876 case 2 with heads that name no run (one head, then both heads) gives evidence_run_missing", async () => {
  await assert.rejects(withCli((file) => edit(file, { candidateHead: "d".repeat(40) })), /evidence_run_missing/);
  await assert.rejects(withCli((file) => edit(file, { reviewBaselineHead: "e".repeat(40), candidateHead: "d".repeat(40) })), /evidence_run_missing/);
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
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_run_missing/);
});

test("a sealed record is final: re-seal of identical bytes and re-seal after an edit are refused, and re-creating the run keeps the seal", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_foreign_run");
  fs.writeFileSync(file, `${JSON.stringify(result())} `);
  assert.equal(reason(() => sealEvidence(dir, file, result())), "evidence_foreign_run");
  createEvidenceRun(dir, KEY, EXPECTED, file);
  assert.equal(reason(() => verify(dir, file, result())), "evidence_digest_mismatch");
});

test("recovery at the same heads: a refused result, a re-run of the input run and a second seal verify through the real CLIs, with no record deleted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-recovery-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const findingsLog = path.join(dir, "findings.json");
  fs.writeFileSync(findingsLog, JSON.stringify({ headSha: A, provenance: { perAngle: [{ angle: "correctness" }] } }));
  const resultPath = path.join(dir, "result.json");
  const tmpRoot = resolveGateArtifactTmpRoot(coverageRepo);
  const inputRun = async () => {
    const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", findingsLog, "--result-path", resultPath]);
    return (await runDeltaCli(bound.args, { ...bound.seam, ...quiet })).input;
  };
  const reviewedRun = async (input) => {
    fs.writeFileSync(resultPath, JSON.stringify({ ...input.resultShape, actionableItems: input.actItems.map(({ ref }) => ({ ref, status: "resolved", evidence: ["e"] })), newFindings: [], widenedReads: [], outcome: "locally_clear" }));
    const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--result", resultPath, "--invocation", "1"], {}, { seal: false });
    sealCli(["--kind", "delta", "--file", resultPath], { ...quiet, cwd: coverageRepo });
    return bound;
  };

  const first = await inputRun();
  const firstBound = await reviewedRun(first);
  edit(resultPath, { newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] });
  await assert.rejects(runDeltaCli(firstBound.args, { ...firstBound.seam, ...quiet }), /evidence_digest_mismatch/);

  const second = await inputRun();
  assert.notEqual(second.runId, first.runId, "a re-run of the producer mints a new run id");
  assert.ok(fs.existsSync(evidenceRunRecordPath(tmpRoot, deltaEvidenceKey(A, B, first.runId))), "the old record stays");
  const secondBound = await reviewedRun(second);
  const out = await runDeltaCli(secondBound.args, { ...secondBound.seam, ...quiet });
  assert.equal(out.ok, true);
});

test("the input run records the briefed result path and seal-evidence refuses any other path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-path-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const findingsLog = path.join(dir, "findings.json");
  fs.writeFileSync(findingsLog, JSON.stringify({ headSha: A, provenance: { perAngle: [{ angle: "correctness" }] } }));
  const briefed = path.join(dir, "result.json");
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", findingsLog, "--result-path", briefed]);
  const { input } = await runDeltaCli(bound.args, { ...bound.seam, ...quiet });
  const foreign = path.join(dir, "scratch-x.json");
  fs.writeFileSync(foreign, JSON.stringify({ ...input.resultShape, outcome: "locally_clear" }));
  assert.throws(() => sealCli(["--kind", "delta", "--file", foreign], { ...quiet, cwd: coverageRepo }), /evidence_foreign_run/);
  fs.copyFileSync(foreign, briefed);
  sealCli(["--kind", "delta", "--file", briefed], { ...quiet, cwd: coverageRepo });
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

test("check-pre-push-delta --result on an unsealed run gives evidence_unsealed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-unsealed-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const resultPath = path.join(dir, "result.json");
  const runId = mintEvidenceRunId(); // a fresh id: the worktree tmp root is shared across test files
  fs.writeFileSync(resultPath, JSON.stringify(result({ runId })));
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--result", resultPath, "--invocation", "1"], {}, { seal: false });
  const tmpRoot = bound.seam.tmpRoot ?? resolveGateArtifactTmpRoot(bound.args[bound.args.indexOf("--worktree") + 1]);
  createEvidenceRun(tmpRoot, deltaEvidenceKey(A, B, runId), { ...EXPECTED, runId }, resultPath);
  await assert.rejects(runDeltaCli(bound.args, { ...bound.seam, ...quiet }), /evidence_unsealed/);
});

test("a malformed result gives the typed evidence_malformed, not evidence_run_missing", async () => {
  await assert.rejects(withCli((file) => edit(file, { reviewBaselineHead: "" })), (error) => /evidence_malformed/.test(error.message) && !/evidence_run_missing/.test(error.message));
});

test("--result refuses every falsy or non-object JSON result with evidence_malformed and writes no gate-delta record", async () => {
  for (const body of ["null", "false", "0", '""', "[]"]) {
    await assert.rejects(withCli((file) => fs.writeFileSync(file, body)), /evidence_malformed/, body);
  }
});

test("--result refuses an empty or truncated result file with evidence_malformed", async () => {
  for (const body of ["", '{"reviewBaselineHead":']) {
    await assert.rejects(withCli((file) => fs.writeFileSync(file, body)), /evidence_malformed/, JSON.stringify(body));
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

test("a failed input run leaves the current-run pointer on the earlier run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-input-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const log = path.join(dir, "log.json");
  fs.writeFileSync(log, JSON.stringify({ headSha: A, executionMode: "inline_single_agent", findings: [{ angle: "correctness" }] }));
  const args = ["--act-list", actList, "--baseline", A, "--spec-identity", "s"];
  const first = await boundArgs([...args, "--findings-log", log]);
  const tmpRoot = first.seam.tmpRoot ?? resolveGateArtifactTmpRoot(first.args[first.args.indexOf("--worktree") + 1]);
  const pointer = path.join(tmpRoot, "evidence-runs", `current-delta-${A}-${B}.txt`);
  const { input } = await runDeltaCli(first.args, { ...first.seam, ...quiet });
  assert.equal(fs.readFileSync(pointer, "utf8").trim(), input.resultShape.runId);
  const second = await boundArgs([...args, "--findings-log", path.join(dir, "missing-log.json")]);
  await assert.rejects(runDeltaCli(second.args, { ...second.seam, ...quiet }));
  assert.equal(fs.readFileSync(pointer, "utf8").trim(), input.resultShape.runId);
});

test("emit-fixer-work-order refuses a null --delta-result with evidence_malformed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-null-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, "null");
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_malformed/);
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
    const key = deltaEvidenceKey(A, A, RUN_ID);
    createEvidenceRun(dir, key, { ...EXPECTED, candidateHead: A }, sealedPath);
    sealEvidence(dir, sealedPath, sealed);
    fs.writeFileSync(deltaResult, JSON.stringify(foreign ? sealed : { ...sealed, newFindings: [{ severity: "low", summary: "x", evidence: ["e"] }] }));
    await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), expected);
  }
});

test("the delta reviewer brief names input.sealCommand and the result path binding, and the --handback list names sealCommand", () => {
  const contract = fs.readFileSync("skills/docs/pre-pr-review-contract.md", "utf8");
  const skill = fs.readFileSync("skills/dev-loop/SKILL.md", "utf8");
  for (const text of [contract, skill]) assert.match(text, /`input\.patchPath`, `input\.evidenceRule` and `input\.sealCommand`/);
  assert.match(contract, /`--result-path`/);
  assert.match(contract, /prints none of `patchPath`, `evidenceRule` or `sealCommand`/);
});

test("a briefed result directory that does not exist yet is realpathed through a symlinked prefix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-late-dir-"));
  const link = path.join(os.tmpdir(), `seal-evidence-late-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(dir, link);
  try {
    createEvidenceRun(dir, KEY, EXPECTED, path.join(link, "later", "result.json"));
    const file = path.join(dir, "later", "result.json");
    fs.writeFileSync(file, JSON.stringify(result()));
    sealEvidence(dir, file, result());
    verify(dir, file, result());
  } finally { fs.rmSync(link, { force: true }); }
});

test("the reviewer-input run refuses to start without --result-path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-nopath-"));
  const actList = path.join(dir, "act-list.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  const findingsLog = path.join(dir, "findings.json");
  fs.writeFileSync(findingsLog, JSON.stringify({ headSha: A, provenance: { perAngle: [{ angle: "correctness" }] } }));
  const bound = await boundArgs(["--act-list", actList, "--baseline", A, "--spec-identity", "spec@1", "--findings-log", findingsLog]);
  const args = bound.args.filter((arg, i, all) => arg !== "--result-path" && all[i - 1] !== "--result-path");
  await assert.rejects(runDeltaCli(args, { ...bound.seam, ...quiet }), /--result-path <path> is required/);
});

test("emit-fixer-work-order refuses a --delta-result whose run was never sealed with evidence_unsealed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-unsealed-"));
  const actList = path.join(dir, "act-list.json");
  const deltaResult = path.join(dir, "result.json");
  fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
  fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
  createEvidenceRun(dir, deltaEvidenceKey(A, A, RUN_ID), { ...EXPECTED, candidateHead: A }, deltaResult);
  await assert.rejects(emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_unsealed/);
});

test("emit-fixer-work-order gives the typed evidence refusal for an edited sealed --delta-result before the membership check", async () => {
  const run = async (over) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-evidence-emit-edit-"));
    const actList = path.join(dir, "act-list.json");
    const deltaResult = path.join(dir, "result.json");
    fs.writeFileSync(actList, JSON.stringify(ACT_LIST));
    fs.writeFileSync(deltaResult, JSON.stringify(result({ candidateHead: A })));
    const key = deltaEvidenceKey(A, A, RUN_ID);
    createEvidenceRun(dir, key, { ...EXPECTED, candidateHead: A }, deltaResult);
    sealEvidence(dir, deltaResult, result({ candidateHead: A }));
    edit(deltaResult, over);
    return emitFixerWorkOrder({ repo: "o/r", pr: 7, headSha: A, phase: "full", actListFile: actList, gate: "draft_gate", deltaResult, cwd: dir, tmpRoot: dir });
  };
  await assert.rejects(run({ actionableItems: [{ ref: "act-x", status: "resolved", evidence: ["e"] }] }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_digest_mismatch/);
  await assert.rejects(run({ actSetId: "0".repeat(16) }), /GATE-EXEC-EVIDENCE-SEALED.*evidence_foreign_run/);
});

test("a sealed result with an edited coverage field gives evidence_digest_mismatch before any coverage check", async () => {
  await assert.rejects(withCli((file) => edit(file, { siteCoverageDigest: "0".repeat(64) })), /evidence_digest_mismatch/);
});

test("a sealed result of a superseded input run is evidence_foreign_run at verify", () => {
  const { dir, file } = setup();
  sealEvidence(dir, file, result());
  verify(dir, file, result());
  createEvidenceRun(dir, deltaEvidenceKey(A, B, "fedcba9876543210"), { ...EXPECTED, runId: "fedcba9876543210" }, path.join(dir, "other.json"));
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
