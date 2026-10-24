import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadDevLoopConfig, resolveGateAngleContract } from "@dev-loops/core/config";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { pullWorkOrder, pullReceiptPath, workOrderDigest } from "../../scripts/github/_work-order-protocol.mjs";
import "../../scripts/github/pull-work-order.mjs";
import { buildGateEmitPlanPath, writeGateContext } from "../../scripts/github/write-gate-context.mjs";
import { runIdFreeEnv } from "../_helpers.mjs";
import { parseResidualEvidenceArgs, snapshotResidualEvidence, verifyResidualEvidenceSnapshot } from "../../scripts/github/reconcile-residual-evidence.mjs";

const HEAD = "b".repeat(40), BASE = "a".repeat(40);
const TARGET = { repo: "o/r", pr: 7, headSha: HEAD };
const hash = (bytes) => sha256Hex(bytes).slice(7);
const put = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
};

async function fixture(fn, harness = "pi", alterReads) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "residual-evidence-")));
  try {
    const tmpRoot = path.join(root, "tmp");
    const key = { ...TARGET, gate: "draft_gate", tmpRoot };
    const act = ["1".repeat(16), "2".repeat(16)].map((fingerprint) => ({ fingerprint, angle: "coverage", severity: "medium", summary: fingerprint, judgeDisposition: "act" }));
    const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: act });
    const delta = { reviewBaselineHead: BASE, candidateHead: HEAD, actSetId: sequence.actSetId, outcome: "bounded_out",
      actionableItems: sequence.actItems.map(({ ref }) => ({ ref, status: "cannot_verify", evidence: ["qualification missing"] })),
      newFindings: [], widenedReads: [] };
    const decision = { ...delta, invocation: 3, nextStep: "push_to_gate", items: delta.actionableItems.map(({ ref, status }) => ({ ref, status })) };
    const fixerDir = path.join(tmpRoot, "gate-fixer", "o-r", "pr-7");
    const fixerPlan = path.join(fixerDir, "fixer-emit-plan.json");
    const reads = ["act-list", "delta-result"].map((kind, i) => ({ kind, path: path.join(fixerDir, `${kind}.json`), sha256: hash(JSON.stringify([act, delta][i])), required: true }));
    for (const [i, read] of reads.entries()) await put(read.path, [act, delta][i]);
    const fixer = { executionIdentity: "f1799999999000-1234abcd",
      workOrderRef: `fixer:o/r#7:${BASE}:f1799999999000-1234abcd`,
      workOrder: { role: "fixer", phase: "full", source: "act-list", target: { repo: "o/r", pr: 7 }, headSha: BASE,
        requiredReads: reads, outputRefs: [path.join(fixerDir, "f1799999999000-1234abcd", "fixer-disposition.json")] } };
    fixer.workOrder.authority = { sourceDigest: sha256Hex(act).slice(7), deltaResultDigest: sha256Hex(delta).slice(7) };
    fixer.workOrderDigest = workOrderDigest(fixer.workOrder);
    await put(fixerPlan, fixer);
    const handoff = JSON.stringify({ headSha: HEAD, dispositions: [{ threadId: "PRRT_one", disposition: "deferred", fixingCommitSha: HEAD }] });
    await put(pullReceiptPath(tmpRoot, fixer.workOrderRef), { role: "fixer", workOrderRef: fixer.workOrderRef,
      workOrderDigest: fixer.workOrderDigest, executionIdentity: fixer.executionIdentity, subject: { planPath: fixerPlan } });
    await put(fixer.workOrder.outputRefs[0], handoff);
    await put(`${fixer.workOrder.outputRefs[0]}.constructed`, sha256Hex(handoff));
    const decisionPath = path.join(tmpRoot, "gate-delta", `${BASE}.json`);
    await put(decisionPath, decision);
    const supplemental = path.join(root, "qualification.json");
    await put(supplemental, { harness, effectiveModel: "unknown", resumedQualified: false });
    const { config } = await loadDevLoopConfig({ repoRoot: root });
    const { mandatoryAngles } = resolveGateAngleContract(config, "draft");
    const names = [...new Set([...mandatoryAngles, "coverage", "threat-model"])];
    const planPath = buildGateEmitPlanPath(key);
    const rawDiff = "tmp/raw.diff";
    await put(path.join(root, rawDiff), "supplemental diff\n");
    const bundle = await writeGateContext({ ...TARGET, gate: "draft_gate", angles: names,
      fanoutDispatch: { groups: names.map((name) => ({ name, angles: [name] })) },
      diffPath: rawDiff, prBody: "Snapshot assessment scope", validationPosture: "targeted" }, { repoRoot: root });
    const prefix = await readFile(path.join(root, bundle.prefixPath), "utf8");
    assert.ok(bundle.artifact.requiredReads.some((r) => !path.isAbsolute(r.path) && r.required));
    assert.ok(bundle.artifact.requiredReads.some((r) => r.required === false && r.sha256));
    assert.ok(bundle.artifact.requiredReads.some((r) => r.kind === "context" && !r.sha256));
    if (alterReads) {
      alterReads(bundle.artifact.requiredReads);
      await put(path.join(root, bundle.path), bundle.artifact);
    }
    execFileSync(process.execPath, [new URL("../../scripts/github/emit-fanout-dispatch.mjs", import.meta.url).pathname,
      "--repo", "o/r", "--pr", "7", "--gate", "draft_gate", "--head-sha", HEAD], { cwd: root });
    const plan = JSON.parse(await readFile(planPath)), units = plan.units;
    const rootBody = act.map((a) => `<!-- dev-loops:finding ${a.fingerprint} -->`).join("\n");
    const assessment = { ...TARGET, reviewBaselineHead: BASE, actSetId: sequence.actSetId,
      deltaResultSha256: hash(JSON.stringify(delta)), decisionSha256: hash(JSON.stringify(decision)),
      roots: [{ threadId: "PRRT_one", rootCommentId: "PRRC_one", rootSha256: hash(rootBody),
        members: sequence.actItems.map(({ ref }) => ({ ref, conclusion: "resolved", evidence: ["qualification.json:1"] })) }],
      supplementalFiles: [{ path: supplemental, sha256: hash(await readFile(supplemental)) }],
      limitations: ["Unknown effective model and effort; configured resumed execution unqualified."] };
    for (const unit of units) {
      await pullWorkOrder({ ref: unit.workOrderRef, digest: unit.workOrderDigest, execution: unit.executionIdentity, cwd: root, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
      await put(path.join(tmpRoot, `checkpoint-context-sentinel-${unit.scope}-${HEAD}.json`), { scope: unit.scope, round: HEAD, prefixHash: hash(prefix) });
      const result = { angle: unit.angles[0], headSha: HEAD, verdict: "clean", findings: [], ...(unit.angles[0] === "coverage" ? { residualEvidenceAssessment: assessment } : {}) };
      await put(unit.workOrder.outputRefs[0], result);
    }
    const calls = [], mutations = [];
    const state = { head: HEAD };
    const deps = { repoRoot: root, env: runIdFreeEnv(), ghCommand: "gh", runChild: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("POST") || args.includes("PATCH") || args.includes("DELETE") || args.some((a) => /mutation\s*\{/.test(a))) mutations.push(args);
      const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
      if (args[0] === "pr" && args[1] === "view") return ok({ headRefOid: state.head });
      if (args.includes("user")) return ok({ login: "owner" });
      if (args.includes("graphql")) return ok({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: [{ id: "PRRT_one", isResolved: false, comments: {
          nodes: [{ id: "PRRC_one", databaseId: 1, author: { login: "owner" }, body: rootBody },
            { id: "PRRC_two", databaseId: 2, author: { login: "owner" }, body: `Residual delta status: cannot_verify ${HEAD}` }],
          pageInfo: { hasNextPage: false },
        } }, ...(state.extraRoots ?? [])], pageInfo: { hasNextPage: false },
      } } } } });
      throw new Error(`Unexpected read: ${command} ${args.join(" ")}`);
    } };
    const options = { ...TARGET, baseline: BASE, angle: "coverage", fixerPlan, record: true };
    const resultPath = units.find((u) => u.angles[0] === "coverage").workOrder.outputRefs[0];
    await fn({ root, tmpRoot, options, deps, state, calls, mutations, plan, planPath, resultPath, assessment, decisionPath, supplemental, fixer, bundle, rootBody });
    assert.deepEqual(mutations, []);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("distinct live roots sharing fingerprints retain every root and member", async () => fixture(async (f) => {
  f.state.extraRoots = [{ id: "PRRT_shared", isResolved: false, comments: {
    nodes: [{ id: "PRRC_shared", databaseId: 3, author: { login: "owner" }, body: f.rootBody },
      { id: "PRRC_shared_reply", databaseId: 4, author: { login: "owner" }, body: `Residual delta status: cannot_verify ${HEAD}` }], pageInfo: { hasNextPage: false },
  } }];
  f.assessment.roots.push({ ...f.assessment.roots[0], threadId: "PRRT_shared", rootCommentId: "PRRC_shared" });
  const result = JSON.parse(await readFile(f.resultPath));
  await put(f.resultPath, { ...result, residualEvidenceAssessment: f.assessment });
  const recorded = await snapshotResidualEvidence(f.options, f.deps);
  assert.equal(recorded.threads.length, 2);
  const roots = [...f.assessment.roots];
  f.assessment.roots.pop();
  await put(f.resultPath, { ...result, residualEvidenceAssessment: f.assessment });
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /partial or foreign residual roots/);
  f.assessment.roots = roots;
  f.assessment.roots[1].members = [];
  await put(f.resultPath, { ...result, residualEvidenceAssessment: f.assessment });
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /member assessment/);
}));

for (const kind of ["act-list", "delta-result"]) test(`refuses repinned ${kind} with changed semantic identity`, async () => fixture(async (f) => {
  const read = f.fixer.workOrder.requiredReads.find((r) => r.kind === kind);
  const value = JSON.parse(await readFile(read.path));
  if (kind === "act-list") value[0].summary = "replacement finding";
  else value.actionableItems[0].evidence = ["replacement evidence"];
  await put(read.path, value);
  read.sha256 = hash(await readFile(read.path));
  await put(f.options.fixerPlan, f.fixer);
  f.assessment.deltaResultSha256 = f.fixer.workOrder.requiredReads[1].sha256;
  const result = JSON.parse(await readFile(f.resultPath));
  await put(f.resultPath, { ...result, residualEvidenceAssessment: f.assessment });
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /semantic authority/);
}));

for (const kind of ["evidence", "raw-diff"]) test(`refuses post-pull replacement of ${kind} and its plan pin`, async () => fixture(async (f) => {
  for (const unit of f.plan.units) {
    const read = unit.workOrder.requiredReads.find((r) => r.kind === kind);
    await put(path.resolve(f.root, read.path), "replacement reviewer evidence");
    read.sha256 = hash("replacement reviewer evidence");
    read.bytes = Buffer.byteLength("replacement reviewer evidence");
    assert.equal(workOrderDigest(unit.workOrder), unit.workOrderDigest);
  }
  await put(f.planPath, f.plan);
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /reviewer read.*materialization/);
}));

test("concurrent identical recordings publish one complete snapshot", async () => fixture(async (f) => {
  f.assessment.limitations.push("Large assessment. ".repeat(16384));
  const result = JSON.parse(await readFile(f.resultPath));
  await put(f.resultPath, { ...result, residualEvidenceAssessment: f.assessment });
  const records = await Promise.all(Array.from({ length: 8 }, () => snapshotResidualEvidence(f.options, f.deps)));
  assert.equal(new Set(records.map((r) => r.snapshotPath)).size, 1);
  assert.deepEqual(JSON.parse(await readFile(records[0].snapshotPath)).assessment, f.assessment);
  assert.deepEqual(await readdir(path.dirname(records[0].snapshotPath)), [path.basename(records[0].snapshotPath)]);
}));

for (const harness of ["pi", "claude", "codex"]) test(`records original pulled ${harness} evidence without touching history`, async () => fixture(async (f) => {
  const paths = [f.decisionPath, f.options.fixerPlan, pullReceiptPath(f.tmpRoot, f.fixer.workOrderRef),
    ...f.fixer.workOrder.requiredReads.map((r) => r.path), ...f.fixer.workOrder.outputRefs,
    `${f.fixer.workOrder.outputRefs[0]}.constructed`];
  const before = await Promise.all(paths.map((p) => readFile(p)));
  const result = await snapshotResidualEvidence(f.options, f.deps);
  assert.equal(result.recorded, true);
  assert.equal(result.applied, false);
  assert.equal(result.status, "unqualified");
  assert.equal(Object.hasOwn(result, "accepted"), false);
  assert.equal(Object.hasOwn(result, "reconciliationPath"), false);
  const record = JSON.parse(await readFile(result.snapshotPath));
  assert.equal(record.kind, "residual-evidence-snapshot");
  assert.equal(record.status, "unqualified");
  assert.ok(record.provenance.requiredReads.some((r) => r.status === "unpinned-context"));
  assert.deepEqual(record.assessment, f.assessment);
  assert.ok(record.sources.some((s) => s.path === f.resultPath && hash(Buffer.from(s.base64, "base64")) === s.sha256));
  assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), before);
  assert.equal((await snapshotResidualEvidence(f.options, f.deps)).snapshotPath, result.snapshotPath);
  const inspect = await snapshotResidualEvidence({ ...f.options, record: false }, f.deps);
  assert.equal(inspect.recorded, false);
  assert.equal(inspect.snapshotPath, null);
  assert.equal(f.calls.some((c) => c.args.some((a) => a.includes("check-pre-push-delta"))), false);
}, harness));

const negatives = {
  wrongHead: async (f) => { f.state.head = BASE; },
  wrongRepo: async (f) => { f.assessment.repo = "foreign/repo"; },
  wrongPr: async (f) => { f.assessment.pr = 8; },
  wrongBaseline: async (f) => { f.assessment.reviewBaselineHead = HEAD; },
  wrongAct: async (f) => { f.assessment.actSetId = "foreign"; },
  unknownAssessment: async (f) => { f.assessment.coordinatorVerified = true; },
  contradictoryMember: async (f) => { f.assessment.roots[0].members[0].resolved = false; },
  duplicateMember: async (f) => { f.assessment.roots[0].members.push(f.assessment.roots[0].members[0]); },
  duplicateFile: async (f) => { f.assessment.supplementalFiles.push(f.assessment.supplementalFiles[0]); },
  unknownFile: async (f) => { f.assessment.supplementalFiles[0].trusted = true; },
  wrongRoot: async (f) => { f.assessment.roots[0].rootCommentId = "foreign"; },
  wrongThread: async (f) => { f.assessment.roots[0].threadId = "PRRT_foreign"; },
  wrongMember: async (f) => { f.assessment.roots[0].members[0].ref = "foreign"; },
  partial: async (f) => { f.assessment.roots[0].members.pop(); },
  unresolved: async (f) => { f.assessment.roots[0].members[0].conclusion = "cannot_verify"; },
  noAssessment: async (f) => { f.assessment = undefined; },
  noLimitations: async (f) => { delete f.assessment.limitations; },
  noSupplement: async (f) => { f.assessment.supplementalFiles = []; },
  changedSupplement: async (f) => { await put(f.supplemental, "changed"); },
  changedDelta: async (f) => { await put(f.fixer.workOrder.requiredReads[1].path, "{}"); },
  changedDecision: async (f) => { await put(f.decisionPath, "{}"); },
  changedOptionalPin: async (f) => { await put(path.join(f.root, "tmp/raw.diff"), "tampered optional bytes"); },
  aliasedOptionalRead: async (f) => {
    const raw = path.join(f.root, "tmp/raw.diff");
    await rm(raw);
    await symlink(f.supplemental, raw);
  },
  missingRequiredRead: async (f) => { await rm(path.join(f.root, f.bundle.evidencePath)); },
  contextAsSupplement: async (f) => {
    const context = path.join(f.root, f.bundle.path);
    f.assessment.supplementalFiles = [{ path: context, sha256: hash(await readFile(context)) }];
  },
  noReceipt: async (f) => { await rm(pullReceiptPath(f.tmpRoot, f.plan.units.find((u) => u.angles[0] === "coverage").workOrderRef)); },
  foreignReceipt: async (f) => {
    const p = pullReceiptPath(f.tmpRoot, f.plan.units.find((u) => u.angles[0] === "coverage").workOrderRef);
    const receipt = JSON.parse(await readFile(p));
    receipt.subject.repo = "foreign/repo";
    await put(p, receipt);
  },
  superseded: async (f) => { f.plan.roundId = "r1800000000001-1234abcd"; await put(f.planPath, f.plan); },
  retired: async (f) => { await put(path.join(f.tmpRoot, "retired-gate-rounds", HEAD, "old", "retirement.json"), { gate: "draft_gate", retiredAt: "2030-01-01T00:00:00Z" }); },
  outputOwnership: async (f) => { f.plan.units.find((u) => u.angles[0] === "coverage").workOrder.outputRefs[0] = f.supplemental; await put(f.planPath, f.plan); },
};
for (const [name, alter] of Object.entries(negatives)) test(`refuses ${name} without a snapshot`, async () => fixture(async (f) => {
  await alter(f);
  const result = JSON.parse(await readFile(f.resultPath));
  result.residualEvidenceAssessment = f.assessment;
  await put(f.resultPath, result);
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps));
  assert.deepEqual(await readdir(path.join(f.tmpRoot, "residual-evidence")).catch(() => []), []);
}));

test("refuses a carried result and a result written before its pull", async () => fixture(async (f) => {
  const result = JSON.parse(await readFile(f.resultPath));
  await put(f.resultPath, { ...result, carriedFromHead: BASE });
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps));
  await put(f.resultPath, result);
  await utimes(f.resultPath, 1, 1);
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps));
}));

test("CLI rejects apply and refuses caller-supplied delivery flags", () => {
  for (const flag of ["--apply", "--accept", "--unknown", "--construct", "--delivery-ok"]) assert.throws(() => parseResidualEvidenceArgs([flag]));
  const parsed = parseResidualEvidenceArgs(["--repo", "o/r", "--pr", "7", "--head-sha", HEAD,
    "--baseline", BASE, "--angle", "coverage", "--fixer-plan", "/tmp/plan", "--jq", ".ok", "--silent"]);
  assert.equal(parsed.jq, ".ok");
  assert.equal(parsed.silent, true);
});

test("duplicate JSON assessment keys cannot smuggle a positive conclusion", async () => fixture(async (f) => {
  const result = await readFile(f.resultPath, "utf8");
  await put(f.resultPath, result.replace('"conclusion":"resolved"', '"conclusion":"cannot_verify","conclusion":"resolved"'));
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /duplicate or ambiguous JSON keys/);
}));

test("late source tampering and head movement refuse recording", async () => {
  for (const changed of ["head", "source", "sourceDuringHead", "retiredDuringHead", "reemittedDuringHead"]) await fixture(async (f) => {
    const inner = f.deps.runChild;
    f.deps.runChild = async (command, args) => {
      if (args.includes("headRefOid") && changed === "head") f.state.head = BASE;
      if (args.includes("graphql") && changed === "source") await put(f.supplemental, "late tamper");
      if (args.includes("headRefOid") && changed === "sourceDuringHead") await put(f.supplemental, "late head-query tamper");
      if (args.includes("headRefOid") && changed === "retiredDuringHead") await negatives.retired(f);
      if (args.includes("headRefOid") && changed === "reemittedDuringHead") await negatives.superseded(f);
      return inner(command, args);
    };
    await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /source changed|candidate moved|authority retired/);
    assert.deepEqual(await readdir(path.join(f.tmpRoot, "residual-evidence")).catch(() => []), []);
  });
});

test("matching-byte existing snapshot symlink refuses idempotence", async () => fixture(async (f) => {
  const result = await snapshotResidualEvidence(f.options, f.deps);
  const bytes = await readFile(result.snapshotPath);
  const target = path.join(f.root, "snapshot-target.json");
  await writeFile(target, bytes);
  await rm(result.snapshotPath);
  await symlink(target, result.snapshotPath);
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /noncanonical snapshot/);
  assert.equal(await realpath(result.snapshotPath), target);
  assert.deepEqual(await readFile(target), bytes);
}));

test("record retains original reviewer bytes after later same-head emissions", async () => fixture(async (f) => {
  const result = await snapshotResidualEvidence(f.options, f.deps);
  const before = await readFile(result.snapshotPath);
  const original = await readFile(f.resultPath);
  await put(f.resultPath, "later same-head output");
  await put(f.planPath, { ...f.plan, roundId: "r1800000000001-1234abcd" });
  const snapshot = JSON.parse(before).sources.find((s) => s.path === f.resultPath);
  assert.deepEqual(Buffer.from(snapshot.base64, "base64"), original);
  assert.deepEqual(await readFile(result.snapshotPath), before);
}));

test("available unpinned context stays qualified and missing optional reads stay absent", async () => fixture(async (f) => {
  const context = path.join(f.root, f.bundle.path);
  const original = await verifyResidualEvidenceSnapshot(f.options, f.deps);
  assert.equal(original.sources.find((s) => s.path === context).qualification, "unpinned-context");
  await rm(context);
  await rm(path.join(f.root, "tmp/raw.diff"));
  const snapshot = await verifyResidualEvidenceSnapshot(f.options, f.deps);
  const absent = snapshot.provenance.requiredReads.filter((r) => r.status === "absent");
  assert.ok(absent.some((r) => r.kind === "context"));
  assert.ok(absent.some((r) => r.kind === "raw-diff"));
  assert.equal(snapshot.sources.some((s) => s.path === context), false);
  assert.deepEqual(await readdir(path.join(f.tmpRoot, "residual-evidence")).catch(() => []), []);
}));

test("malformed source JSON refuses without a snapshot", async () => fixture(async (f) => {
  await put(f.resultPath, "{");
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps));
  assert.deepEqual(await readdir(path.join(f.tmpRoot, "residual-evidence")).catch(() => []), []);
}));

for (const kind of ["evidence", "raw-diff"]) test(`refuses missing ${kind} pin in authenticated reviewer order`, async () => fixture(async (f) => {
  await assert.rejects(snapshotResidualEvidence(f.options, f.deps), /lacks pin|unpinned substantive/);
  assert.deepEqual(await readdir(path.join(f.tmpRoot, "residual-evidence")).catch(() => []), []);
}, "pi", (reads) => { delete reads.find((r) => r.kind === kind).sha256; }));
