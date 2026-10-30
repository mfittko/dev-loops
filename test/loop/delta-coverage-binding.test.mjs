import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "bun:test";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";
import { runCli } from "../../scripts/loop/check-pre-push-delta.mjs";
import { A, B, boundArgs, coverageRepo, git } from "./_delta-coverage-fixture.mjs";
import { checkFixPushAuthority } from "../../scripts/loop/check-fix-push-authority.mjs";
import { readSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { initGitFixture } from "../_helpers.mjs";

test("authenticated no_commit and foreign-head exits close only their own sequence and permit the push", async () => {
  for (const outcome of ["no_commit", "head_moved"]) {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delta-closure-")));
    initGitFixture(cwd, { branch: "issue-1" });
    const A = git(cwd, "rev-parse", "HEAD");
    git(cwd, "commit", "--allow-empty", "-m", "developer change");
    const act = { severity: "low", angle: "correctness", summary: outcome, judgeDisposition: "act" };
    act.fingerprint = fingerprintFinding(act);
    const actPath = path.join(cwd, `${outcome}.json`), coverage = path.join(cwd, `${outcome}-coverage.json`), log = path.join(cwd, `${outcome}-log.json`);
    fs.writeFileSync(actPath, JSON.stringify([act]));
    fs.writeFileSync(coverage, JSON.stringify({ headSha: A, siteCoverage: [] }));
    fs.writeFileSync(log, JSON.stringify({ headSha: A, provenance: { perAngle: [{ angle: "correctness" }] } }));
    const fixture = await boundArgs(["--act-list", actPath, "--baseline", A, "--site-coverage", coverage, "--spec-identity", "s", "--findings-log", log, "--worktree", cwd]);
    const options = { stdout: { write() {} }, ...(outcome === "no_commit" ? { revParse: (_cwd, rev) => rev === "HEAD" ? A : rev } : {}) };
    assert.equal(checkFixPushAuthority(cwd).ok, false);
    assert.match(checkFixPushAuthority(cwd).reason, /check-pre-push-delta\.mjs .*--baseline [0-9a-f]{40} .*no_commit/, "the refusal names the close command");
    const planBytes = fs.readFileSync(fixture.unit.planPath), receiptBytes = fs.readFileSync(fixture.pulled.receiptPath), outputBytes = fs.readFileSync(fixture.output);
    if (outcome === "head_moved") assert.equal(checkFixPushAuthority(cwd).ok, false, "a marker with an unpushed fix commit still refuses before the close");
    for (const defect of ["execution", "branch", "PR", "receipt", "malformed"]) {
      const plan = JSON.parse(planBytes);
      if (defect === "execution") plan.executionIdentity = "f1-00000000";
      if (defect === "branch") plan.workOrder.mutationAuthority.branch = "other";
      if (defect === "PR") plan.workOrder.target.pr++;
      fs.writeFileSync(fixture.unit.planPath, JSON.stringify(plan));
      if (defect === "receipt") fs.unlinkSync(fixture.pulled.receiptPath);
      if (defect === "malformed") fs.writeFileSync(fixture.output, "{");
      await assert.rejects(runCli(fixture.args, options), undefined, defect);
      assert.notEqual(readSequenceMarker(fixture.tmpRoot, A), null, defect);
      fs.writeFileSync(fixture.unit.planPath, planBytes);
      fs.writeFileSync(fixture.pulled.receiptPath, receiptBytes);
      fs.writeFileSync(fixture.output, outputBytes);
    }
    const result = await runCli(fixture.args, options);
    assert.equal(result.outcome, outcome);
    assert.equal(result.nextStep, "push_to_gate");
    assert.equal(readSequenceMarker(fixture.tmpRoot, A), null);
    assert.equal(checkFixPushAuthority(cwd).ok, true);
    if (outcome === "no_commit") {
      // PR 2992 shape (ADR 0216): after the close, the push of a base-refresh merge on the baseline is allowed.
      git(cwd, "branch", "base-side", A);
      git(cwd, "checkout", "-q", "base-side");
      git(cwd, "commit", "--allow-empty", "-m", "base moves");
      git(cwd, "checkout", "-q", "issue-1");
      git(cwd, "merge", "--no-ff", "-m", "merge base", "base-side");
      assert.equal(checkFixPushAuthority(cwd).ok, true, "the base-refresh merge push is allowed once the sequence is closed");
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("pulled coverage binding preserves raw identity through the input, result and decision", async () => {
  const act = { severity: "low", angle: "correctness", summary: "binding", judgeDisposition: "act", siteQuery: "git grep x" };
  act.fingerprint = fingerprintFinding(act);
  const actPath = path.join(coverageRepo, "act.json"), coverage = path.join(coverageRepo, "coverage.json"), log = path.join(coverageRepo, "log.json");
  const siteCoverage = [{ fingerprint: act.fingerprint, returnedSites: ["a.mjs"], sites: [{ site: "a.mjs", kind: "site", status: "fixed", reason: "" }] }];
  fs.writeFileSync(actPath, JSON.stringify([act]));
  fs.writeFileSync(coverage, JSON.stringify({ headSha: B, siteCoverage }));
  fs.writeFileSync(log, JSON.stringify({ headSha: A, provenance: { perAngle: [{ angle: "correctness" }] } }));
  const fixture = await boundArgs(["--act-list", actPath, "--baseline", A, "--site-coverage", coverage, "--spec-identity", "s", "--findings-log", log]);
  const options = { stdout: { write() {} }, staleSurface: () => [], tmpRoot: fixture.tmpRoot };
  const { input } = await runCli(fixture.args, options);
  assert.deepEqual(input.siteCoverage, siteCoverage);
  for (const key of Object.keys(fixture.binding)) { assert.deepEqual(input[key], fixture.binding[key]); assert.deepEqual(input.resultShape[key], fixture.binding[key]); }
  const result = path.join(coverageRepo, "delta.json");
  fs.writeFileSync(result, JSON.stringify({ ...input.resultShape, actionableItems: [{ ref: act.fingerprint, status: "resolved", evidence: ["tested"] }], newFindings: [], widenedReads: [], outcome: "locally_clear" }));
  const resultArgs = [...fixture.args, "--result", result, "--invocation", "1"];
  await runCli(resultArgs, options);
  const decisionPath = path.join(fixture.tmpRoot, "gate-delta", `${A}.json`);
  const decision = JSON.parse(fs.readFileSync(decisionPath));
  for (const key of Object.keys(fixture.binding)) assert.deepEqual(decision[key], fixture.binding[key]);
  for (const defect of ["coverageProtocol", "siteCoverageDigest", "handbackBytesDigest", "origin", "all"]) {
    const altered = JSON.parse(fs.readFileSync(result));
    for (const key of defect === "all" ? Object.keys(fixture.binding) : [defect]) delete altered[key];
    const original = fs.readFileSync(result), before = fs.readFileSync(decisionPath);
    fs.writeFileSync(result, JSON.stringify(altered));
    await assert.rejects(runCli([...resultArgs.slice(0, -1), "3"], options), /coverage binding/i);
    assert.deepEqual(fs.readFileSync(decisionPath), before);
    fs.writeFileSync(result, original);
  }
  for (const key of Object.keys(fixture.binding)) {
    const original = fs.readFileSync(result), altered = JSON.parse(original);
    altered[key] = key === "origin" ? { ...altered.origin, workOrderDigest: `sha256:${"0".repeat(64)}` } : "0".repeat(64);
    fs.writeFileSync(result, JSON.stringify(altered));
    await assert.rejects(runCli([...resultArgs.slice(0, -1), "3"], options), /coverage binding/i);
    fs.writeFileSync(result, original);
  }
  for (const modeArgs of [fixture.args, resultArgs]) for (const omitted of [["--fixer-plan"], ["--site-coverage"], ["--fixer-plan", "--site-coverage"]]) {
    const args = [...modeArgs], before = fs.readFileSync(decisionPath);
    for (const flag of omitted) args.splice(args.indexOf(flag), 2);
    await assert.rejects(runCli(args, options), /requires both/);
    assert.deepEqual(fs.readFileSync(decisionPath), before);
  }
  const files = [fixture.unit.planPath, fixture.unit.promptPath, fixture.output, fixture.pulled.receiptPath, actPath, result];
  const originals = files.map((file) => fs.readFileSync(file));
  const edit = (file, fn) => { const value = JSON.parse(fs.readFileSync(file)); fn(value); fs.writeFileSync(file, JSON.stringify(value)); };
  const planEdit = (fn) => edit(fixture.unit.planPath, fn);
  const receiptEdit = (fn) => edit(fixture.pulled.receiptPath, fn);
  const unrelated = git(coverageRepo, "commit-tree", `${B}^{tree}`, "-m", "unrelated candidate");
  const cases = {
    wrongRole: () => planEdit((p) => { p.workOrder.role = "judge"; }),
    wrongPhase: () => planEdit((p) => { p.workOrder.phase = "full"; }),
    wrongTarget: () => planEdit((p) => { p.workOrder.target.pr++; }),
    wrongExecution: () => planEdit((p) => { p.executionIdentity = "f1-00000000"; }),
    wrongDigest: () => planEdit((p) => { p.workOrderDigest = `sha256:${"0".repeat(64)}`; }),
    wrongBaseline: () => planEdit((p) => { p.workOrder.headSha = B; }),
    wrongBranch: () => planEdit((p) => { p.workOrder.mutationAuthority.branch = "other"; }),
    localFieldMutation: () => planEdit((p) => { p.workOrder.executionRules.contract = "/different/agents/fixer.agent.md"; }),
    changedMaterialization: () => fs.appendFileSync(fixture.unit.promptPath, "changed"),
    changedSource: () => fs.appendFileSync(actPath, " "),
    changedSourceAuthority: () => planEdit((p) => { p.workOrder.authority.sourceDigest = "0".repeat(64); }),
    missingReceipt: () => fs.unlinkSync(fixture.pulled.receiptPath),
    wrongReceiptRole: () => receiptEdit((r) => { r.role = "judge"; }),
    wrongReceiptUnit: () => receiptEdit((r) => { r.workOrderRef = "fixer:other/repo#1"; }),
    wrongReceiptExecution: () => receiptEdit((r) => { r.executionIdentity = "f1-00000000"; }),
    wrongReceiptDigest: () => receiptEdit((r) => { r.workOrderDigest = `sha256:${"0".repeat(64)}`; }),
    wrongReceiptMaterialization: () => receiptEdit((r) => { r.materializationHash = `sha256:${"0".repeat(64)}`; }),
    wrongReceiptTarget: () => receiptEdit((r) => { r.subject.pr++; }),
    wrongReceiptPhase: () => receiptEdit((r) => { r.subject.phase = "full"; }),
    wrongReceiptBranch: () => receiptEdit((r) => { r.subject.branch = "other"; }),
    wrongReceiptBaseline: () => receiptEdit((r) => { r.subject.headSha = B; }),
    wrongReceiptPlan: () => receiptEdit((r) => { r.subject.planPath = actPath; }),
    beforePull: () => fs.utimesSync(fixture.output, new Date(0), new Date(0)),
    byteMutation: () => fs.appendFileSync(fixture.output, "\n"),
    coverageMutation: () => edit(fixture.output, (r) => { r.siteCoverage[0].sites[0].reason = "changed"; }),
    candidateMutation: () => edit(fixture.output, (r) => { r.headSha = A; }),
    unrelatedCandidate: () => { edit(fixture.output, (r) => { r.headSha = unrelated; }); edit(result, (r) => { r.candidateHead = unrelated; }); },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    for (let i = 0; i < files.length; i++) fs.writeFileSync(files[i], originals[i]);
    // Restoring the report after its receipt preserves the genuine after-pull ordering.
    fs.writeFileSync(fixture.output, originals[2]);
    mutate();
    const before = fs.readFileSync(decisionPath);
    await assert.rejects(runCli([...resultArgs.slice(0, -1), "3"], options), undefined, label);
    assert.deepEqual(fs.readFileSync(decisionPath), before, label);
  }
  for (let i = 0; i < files.length; i++) fs.writeFileSync(files[i], originals[i]);
  fs.writeFileSync(fixture.output, originals[2]);
  const copied = path.join(coverageRepo, "copied-plan.json");
  fs.writeFileSync(copied, originals[0]);
  const copyArgs = [...resultArgs]; copyArgs[copyArgs.indexOf("--fixer-plan") + 1] = copied;
  await assert.rejects(runCli(copyArgs, options), /canonical current/);
  copyArgs[copyArgs.indexOf("--fixer-plan") + 1] = `${copied}.missing`;
  await assert.rejects(runCli(copyArgs, options), /ENOENT/);
  const copiedOutput = path.join(coverageRepo, "copied-output.json");
  fs.writeFileSync(copiedOutput, originals[2]);
  const locatorArgs = [...resultArgs]; locatorArgs[locatorArgs.indexOf("--site-coverage") + 1] = copiedOutput;
  await assert.rejects(runCli(locatorArgs, options), /noncanonical/);
  const copiedAct = path.join(coverageRepo, "copied-act.json"); fs.writeFileSync(copiedAct, originals[4]);
  const sourceArgs = [...resultArgs]; sourceArgs[sourceArgs.indexOf("--act-list") + 1] = copiedAct;
  await assert.rejects(runCli(sourceArgs, options), /ACT source/);
});

test("THREAD cannot opt into the ACT coverage protocol", async () => {
  const file = path.join(coverageRepo, "threads.json"), result = path.join(coverageRepo, "thread-result.json");
  fs.writeFileSync(file, JSON.stringify({ ok: true, repo: "o/r", pr: 7, threads: [{ threadId: "T1", isResolved: false }] }));
  fs.writeFileSync(result, JSON.stringify({ coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: sha256Hex([]).slice(7), handbackBytesDigest: "a".repeat(64),
    origin: { workOrderRef: `fixer:o/r#7:${A}:f1-00000000`, workOrderDigest: `sha256:${"b".repeat(64)}`, executionIdentity: "f1-00000000" } }));
  await assert.rejects(runCli(["--threads-file", file, "--repo", "o/r", "--pr", "7", "--baseline", A, "--result", result, "--invocation", "3", "--worktree", coverageRepo]), /THREAD cannot/);
});
