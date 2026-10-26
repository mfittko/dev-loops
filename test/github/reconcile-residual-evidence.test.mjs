import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadDevLoopConfig, resolveGateAngleContract } from "@dev-loops/core/config";
import { startDeltaSequence } from "@dev-loops/core/loop/pre-push-delta-review";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { pullWorkOrder, pullReceiptPath, workOrderDigest, executionIndexPath, materializationHash } from "../../scripts/github/_work-order-protocol.mjs";
import { renderWorkOrder } from "../../scripts/loop/emit-fixer-work-order.mjs";
import { verifyFixerDisposition } from "../../scripts/github/verify-fixer-disposition.mjs";
import { consolidateFanin, toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";
import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";
import { neutralizeBareIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { consolidateGateFanin } from "../../scripts/loop/consolidate-fanin.mjs";
import "../../scripts/github/pull-work-order.mjs";
import { buildGateEmitPlanPath, writeGateContext } from "../../scripts/github/write-gate-context.mjs";
import { runIdFreeEnv } from "../_helpers.mjs";
import { resolveGateArtifactTmpRoot } from "../../scripts/loop/_repo-root-resolver.mjs";
import { parseResidualEvidenceArgs, snapshotResidualEvidence, verifyResidualEvidenceSnapshot, verifyResidualEvidenceAcceptance, acceptResidualEvidence } from "../../scripts/github/reconcile-residual-evidence.mjs";

const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const baseCommit = `tree ${tree}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nbaseline\n`;
const BASE = execFileSync("git", ["hash-object", "-t", "commit", "--stdin"], { input: baseCommit }).toString().trim();
const headCommit = baseCommit.replace(`tree ${tree}`, `tree ${tree}\nparent ${BASE}`).replace("baseline\n", "candidate\n");
const HEAD = execFileSync("git", ["hash-object", "-t", "commit", "--stdin"], { input: headCommit }).toString().trim();
const TARGET = { repo: "o/r", pr: 7, headSha: HEAD };
const hash = (bytes) => sha256Hex(bytes).slice(7);
const JUDGE_PROSE = { judgeTitle: "Title", judgeDetail: "Detail", judgeFix: "Fix", judgeReason: "Reason" };
const put = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
};

test("acceptance requires an explicit canonical snapshot and rejects mixed modes", () => {
  const args = ["--repo", "o/r", "--pr", "7", "--head-sha", HEAD, "--baseline", BASE, "--angle", "coverage", "--fixer-plan", "/plan"];
  assert.throws(() => parseResidualEvidenceArgs([...args, "--accept"]), /snapshot/);
  assert.throws(() => parseResidualEvidenceArgs([...args, "--snapshot", "/snapshot"]), /accept/);
  assert.throws(() => parseResidualEvidenceArgs([...args, "--snapshot", ""]), /snapshot requires accept/);
  assert.throws(() => parseResidualEvidenceArgs([...args, "--accept", "--snapshot", ""]), /accept requires snapshot/);
  assert.equal(parseResidualEvidenceArgs([...args, "--accept", "--snapshot", "/snapshot"]).snapshot, "/snapshot");
  assert.equal(parseResidualEvidenceArgs(args).snapshot, undefined);
  assert.throws(() => parseResidualEvidenceArgs([...args, "--accept", "--snapshot", "/snapshot", "--record"]), /mode/);
  assert.equal(typeof verifyResidualEvidenceAcceptance, "function");
});

async function fixture(fn, harness = "pi", alterReads, continuation = false, mixed = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "residual-evidence-")));
  try {
    const git = (args, input) => execFileSync("git", args, { cwd: root, input, stdio: ["pipe", "pipe", "pipe"] });
    git(["init", "--quiet"]);
    git(["mktree"], "");
    for (const input of [baseCommit, headCommit]) git(["hash-object", "-t", "commit", "-w", "--stdin"], input);
    git(["update-ref", "refs/heads/fixture", HEAD]);
    await put(path.join(root, ".devloops"), "version: 1\ngates:\n  fanout:\n    mode: per-angle\n");
    const tmpRoot = path.join(root, "tmp");
    const key = { ...TARGET, gate: "draft_gate", tmpRoot };
    const act = ["1".repeat(16), "2".repeat(16)].map((fingerprint) => ({ fingerprint, angle: "coverage", severity: "medium", summary: fingerprint, judgeDisposition: "act", judgeRationale: "AC 1", ...JUDGE_PROSE }));
    if (mixed) act.push({ ...act[0], fingerprint: "3".repeat(16) });
    const sequence = startDeltaSequence({ reviewBaselineHead: BASE, actList: act });
    const delta = { reviewBaselineHead: BASE, candidateHead: HEAD, actSetId: sequence.actSetId, outcome: "bounded_out",
      actionableItems: sequence.actItems.map(({ ref }, i) => ({ ref, status: mixed && i === 2 ? "resolved" : "cannot_verify", evidence: ["qualification missing"] })),
      newFindings: [], widenedReads: [] };
    if (continuation) delta.siteCoverageDigest = hash([]);
    const decision = { ...delta, invocation: 3, nextStep: "push_to_gate", items: delta.actionableItems.map(({ ref, status }) => ({ ref, status })) };
    const fixerDir = path.join(tmpRoot, "gate-fixer", "o-r", "pr-7");
    const fixerPlan = path.join(fixerDir, "fixer-emit-plan.json");
    const reads = ["act-list", "delta-result"].map((kind, i) => ({ kind, path: path.join(fixerDir, `${kind}.json`), sha256: hash(JSON.stringify([act, delta][i])), bytes: Buffer.byteLength(JSON.stringify([act, delta][i])), required: true }));
    for (const [i, read] of reads.entries()) await put(read.path, [act, delta][i]);
    const fixer = { executionIdentity: "f1799999999000-1234abcd",
      workOrderRef: `fixer:o/r#7:${BASE}:f1799999999000-1234abcd`,
      workOrder: { role: "fixer", phase: continuation ? "commit_only" : "full", source: "act-list", gate: "pre_approval_gate", target: { repo: "o/r", pr: 7 }, headSha: BASE,
        mutationAuthority: { branch: "fixture", allowedPaths: ["qualification.json"] }, executionRules: { contract: path.resolve(import.meta.dirname, "../../agents/fixer.agent.md"), mutation: "scoped", validation: "targeted" },
        requiredReads: reads, outputRefs: [path.join(fixerDir, "f1799999999000-1234abcd", "fixer-disposition.json")] } };
    fixer.workOrder.authority = { sourceDigest: sha256Hex(act).slice(7), deltaResultDigest: sha256Hex(delta).slice(7) };
    fixer.workOrderDigest = workOrderDigest(fixer.workOrder);
    fixer.promptPath = path.join(fixerDir, "work-orders", `${fixer.executionIdentity}.md`);
    const prompt = renderWorkOrder(fixer.workOrder);
    fixer.materializationHash = materializationHash(prompt);
    await put(fixer.promptPath, prompt);
    await put(fixerPlan, fixer);
    await put(executionIndexPath(tmpRoot, fixer.executionIdentity), Object.fromEntries(["executionIdentity", "workOrderRef", "workOrderDigest"].map((k) => [k, fixer[k]])));
    const handoff = JSON.stringify({ headSha: HEAD, siteCoverage: [], dispositions: [{ threadId: "PRRT_one", disposition: "deferred", fixingCommitSha: HEAD },
      ...(mixed ? [{ threadId: "PRRT_fixed", disposition: "tackled", fixingCommitSha: HEAD }] : [])] });
    await pullWorkOrder({ ref: fixer.workOrderRef, digest: fixer.workOrderDigest, execution: fixer.executionIdentity, cwd: root, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
    await put(fixer.workOrder.outputRefs[0], handoff);
    await put(`${fixer.workOrder.outputRefs[0]}.constructed`, sha256Hex(handoff));
    if (continuation) {
      const original = structuredClone(fixer), tuple = (p) => Object.fromEntries(["executionIdentity", "workOrderRef", "workOrderDigest"].map((k) => [k, p[k]])), origin = tuple(fixer);
      await put(path.join(fixerDir, original.executionIdentity, "original-fixer-emit-plan.json"), original);
      const makeFull = async (identity, completionExtra) => {
        fixer.executionIdentity = identity;
        fixer.workOrderRef = `fixer:o/r#7:${HEAD}:${identity}`;
        const completion = { headSha: HEAD, fixingCommitSha: HEAD, siteCoverage: [], origin, ...completionExtra,
          threadBindings: [{ threadId: "PRRT_one", fingerprints: act.map((a) => a.fingerprint) }] };
        const input = path.join(fixerDir, identity, "completion-input.json"), bytes = JSON.stringify(completion);
        await put(input, bytes);
        fixer.workOrder = { ...fixer.workOrder, phase: "full", operation: "complete", headSha: HEAD,
          mutationAuthority: { branch: "fixture", allowedPaths: [] }, requiredReads: [...reads, { kind: "completion-input", path: input, sha256: hash(bytes), bytes: Buffer.byteLength(bytes), required: true }],
          authority: { ...fixer.workOrder.authority, completionInputDigest: hash(completion), completionInputBytesDigest: hash(bytes) },
          outputRefs: [path.join(fixerDir, identity, "fixer-disposition.json")] };
        fixer.workOrderDigest = workOrderDigest(fixer.workOrder);
        fixer.promptPath = path.join(fixerDir, "work-orders", `${identity}.md`);
        const text = renderWorkOrder(fixer.workOrder);
        fixer.materializationHash = materializationHash(text);
        await put(fixer.promptPath, text);
        await put(fixerPlan, fixer);
        await put(executionIndexPath(tmpRoot, identity), tuple(fixer));
        await pullWorkOrder({ ref: fixer.workOrderRef, digest: fixer.workOrderDigest, execution: identity, cwd: root, tmpRoots: [tmpRoot], receiptTmpRoot: tmpRoot });
        await put(fixer.workOrder.outputRefs[0], handoff);
        await put(`${fixer.workOrder.outputRefs[0]}.constructed`, sha256Hex(handoff));
      };
      let legacy;
      if (continuation === "legacy" || continuation === "foreign-legacy" || continuation === "legacy-bad-marker") {
        // A distinct full-phase original: its own pulled receipt, report and .constructed marker.
        await makeFull("f1799999999002-1234abcd");
        const prior = structuredClone(fixer);
        await put(path.join(fixerDir, prior.executionIdentity, "original-fixer-emit-plan.json"), prior);
        if (continuation === "legacy-bad-marker") await put(`${prior.workOrder.outputRefs[0]}.constructed`, "altered");
        legacy = continuation === "foreign-legacy" ? { ...tuple(prior), workOrderDigest: `sha256:${"0".repeat(64)}` } : tuple(prior);
      }
      await makeFull("f1799999999001-1234abcd", legacy ? { legacyRevalidation: { originalFull: legacy } } : {});
    }
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
    const rootBody = act.slice(0, 2).map((a) => `<!-- dev-loops:finding ${a.fingerprint} -->`).join("\n");
    const assessment = { ...TARGET, reviewBaselineHead: BASE, actSetId: sequence.actSetId,
      deltaResultSha256: hash(JSON.stringify(delta)), decisionSha256: hash(JSON.stringify(decision)),
      roots: [{ threadId: "PRRT_one", rootCommentId: "PRRC_one", rootSha256: hash(rootBody),
        members: sequence.actItems.slice(0, 2).map(({ ref }) => ({ ref, conclusion: "resolved", evidence: ["qualification.json:1"] })) }],
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
    if (mixed) state.extraRoots = [{ id: "PRRT_fixed", isResolved: false, comments: { nodes: [
      { id: "PRRC_fixed", databaseId: 3, author: { login: "owner" }, body: `<!-- dev-loops:finding ${act[2].fingerprint} -->` },
    ], pageInfo: { hasNextPage: false } } }];
    const deps = { repoRoot: root, env: runIdFreeEnv(), ghCommand: "gh", runChild: async (command, args) => {
      calls.push({ command, args });
      if (command === "git") {
        const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr };
      }
      if (args.includes("POST") || args.includes("PATCH") || args.includes("DELETE") || args.some((a) => /mutation\s*\{/.test(a))) mutations.push(args);
      const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
      if (command === process.execPath && args[0].endsWith("verify-fixer-disposition.mjs")) {
        if (state.legacyOk) return ok({ ok: true, complete: true });
        const verified = await verifyFixerDisposition({ ...options, check: true }, deps);
        state.deliveryVerified = true;
        await state.duringDelivery?.();
        return ok(verified);
      }
      if (args[0] === "pr" && args[1] === "view") return ok({ headRefOid: state.head, statusCheckRollup: [{ name: "tests" }] });
      if (args.some((a) => a.includes("/check-runs"))) return ok({ check_runs: state.checks ?? [{ name: "tests", status: "completed", conclusion: "success", head_sha: HEAD }] });
      if (args.some((a) => a.includes("/status?"))) { await state.afterCi?.(); return ok({ statuses: [] }); }
      if (args.some((a) => a.includes("/compare/"))) return ok({ status: "ahead" });
      if (args.some((a) => a.includes("/comments"))) return ok(state.comments ?? []);
      if (args.some((a) => a.includes("/reviews"))) return ok([]);
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

async function acceptanceFixture(fn, harness = "pi", findings = [], continuation = false, mixed = false, resultTime) {
  return fixture(async (f) => {
    const raw = JSON.parse(await readFile(f.resultPath));
    raw.findings = findings;
    raw.verdict = findings.length ? "findings_present" : "clean";
    await put(f.resultPath, raw);
    if (resultTime) await utimes(f.resultPath, resultTime, resultTime);
    const results = await Promise.all(f.plan.units.map((u) => readFile(u.workOrder.outputRefs[0]).then(JSON.parse)));
    const consolidated = consolidateFanin({ angleResults: results });
    const projected = structuredClone(consolidated.findings);
    const truncate = (s, n = 2000) => s.length <= n ? s : `${s.slice(0, n - 2)} …`;
    for (const finding of projected) {
      for (const k of ["summary", "recommendation", "failingCase"]) if (finding[k]) finding[k] = truncate(neutralizeBareIssuePrIds(finding[k]));
      if (finding.file) finding.file = truncate(finding.file, 300);
    }
    const input = path.join(f.root, "findings-input.json");
    await put(input, { overallVerdict: consolidated.verdict, findings: toFindingsLogShape(projected).map((v) => ({ ...v, judgeDisposition: "reject", judgeRationale: "Outside this issue scope", ...JUDGE_PROSE })) });
    await consolidateGateFanin({ findingsDir: path.dirname(f.resultPath), headSha: HEAD, gate: "draft_gate", emitPlan: f.planPath, tmpRoot: f.tmpRoot, repoRoot: f.root });
    const written = await writeGateFindingsLog({ ...TARGET, gate: "draft_gate", verdict: consolidated.verdict, findingsFile: input, executionMode: "fanout_fanin" }, { repoRoot: f.root });
    const ledgerPath = path.resolve(f.root, written.path);
    if (resultTime) {
      const ledger = JSON.parse(await readFile(ledgerPath));
      ledger.loggedAt = new Date(resultTime.getTime() + 100).toISOString();
      await put(ledgerPath, ledger);
    }
    const time = new Date(Date.now() + 1000).toISOString();
    f.state.comments = [{ id: 12, updated_at: time, body: [
      "### Gate review: `draft_gate`", `**Reviewed head SHA:** \`${HEAD}\``, `**Verdict:** ${consolidated.verdict}`,
      "**Findings summary:** authenticated full round", "**Next action:** residual acceptance", "**Execution mode:** fanout_fanin",
      "**Size-budget outcome:** pass", "**Size-budget T1 slice:** not touched", "**Size-budget waiver:** none",
    ].join("\n") }];
    const snapshot = await snapshotResidualEvidence(f.options, f.deps);
    f.options = { ...f.options, accept: true, record: false, snapshot: snapshot.snapshotPath };
    await fn({ ...f, ledgerPath });
  }, harness, undefined, continuation, mixed);
}

// One base, one hour ahead of the run, so the fixer report mtime (wall clock) always precedes the pinned times.
const ORDER_BASE_MS = Math.floor(Date.now() / 1000) * 1000 + 3_600_000;
const orderTime = (offsetMs) => new Date(ORDER_BASE_MS + offsetMs).toISOString();
for (const [name, published, accepted] of [
  ["same second", orderTime(0), true],
  ["later second", orderTime(1000), true],
  ["earlier publication", orderTime(-1000), false],
  ["same-second foreign head", orderTime(0), false],
]) test(`acceptance orders second-precision publication: ${name}`, async () => acceptanceFixture(async (f) => {
  f.state.comments[0].updated_at = published;
  if (name === "same-second foreign head") f.state.comments[0].body = f.state.comments[0].body.replace(HEAD, BASE);
  if (accepted) assert.equal((await verifyResidualEvidenceAcceptance(f.options, f.deps)).status, "accepted");
  else await assert.rejects(verifyResidualEvidenceAcceptance(f.options, f.deps), /temporal order/);
}, "pi", [], false, false, new Date(ORDER_BASE_MS + 200)));

for (const draft of [undefined, null, { title: "Follow up", body: "" }, 42, [], { title: " ", body: "" }, { title: "Follow up", body: 42 }]) {
  const valid = draft == null || !Array.isArray(draft) && typeof draft === "object" && draft.title.trim() && typeof draft.body === "string";
  test(`acceptance validates optional reject draft ${JSON.stringify(draft)}`, async () => acceptanceFixture(async (f) => {
    const ledger = JSON.parse(await readFile(f.ledgerPath));
    ledger.findings[0].followUpDraft = draft;
    await put(f.ledgerPath, ledger);
    if (valid) await verifyResidualEvidenceAcceptance(f.options, f.deps);
    else await assert.rejects(verifyResidualEvidenceAcceptance(f.options, f.deps), /followUpDraft/);
  }, "pi", [{ severity: "low", summary: "retained finding" }]));
}

for (const scopeDrift of [undefined, { verdict: "within_scope", rationale: "Scoped", driftedAreas: [] }, 42, null]) {
  test(`acceptance validates empty-round scope ${JSON.stringify(scopeDrift)}`, async () => acceptanceFixture(async (f) => {
    const ledger = JSON.parse(await readFile(f.ledgerPath));
    ledger.scopeDrift = scopeDrift;
    await put(f.ledgerPath, ledger);
    if (scopeDrift === undefined || typeof scopeDrift === "object" && scopeDrift !== null) await verifyResidualEvidenceAcceptance(f.options, f.deps);
    else await assert.rejects(verifyResidualEvidenceAcceptance(f.options, f.deps), /scopeDrift/);
  }));
}

test("requires completed mixed resolved/residual delivery while preserving legitimate deferral", async () => acceptanceFixture(async (f) => {
  const delivery = await verifyFixerDisposition({ ...f.options, check: true }, f.deps);
  assert.equal(delivery.ok, true);
  assert.equal(delivery.complete, false);
  assert.deepEqual(delivery.incomplete.map(({ threadId, failedStep }) => ({ threadId, failedStep })),
    [{ threadId: "PRRT_fixed", failedStep: "reply_missing" }]);
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /full delivery check failed/);
  await assert.rejects(readdir(path.join(path.dirname(path.dirname(f.options.snapshot)), "accepted")), { code: "ENOENT" });
  const fixed = f.state.extraRoots[0];
  fixed.comments.nodes.push({ id: "PRRC_fixed_reply", databaseId: 4, author: { login: "owner" }, body: `Fixed in ${HEAD}` });
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /full delivery check failed/);
  fixed.isResolved = true;
  assert.equal((await acceptResidualEvidence(f.options, f.deps)).status, "accepted");
}, "pi", [], false, true));

for (const harness of ["pi", "claude", "codex"]) test(`accepts actual pulled ${harness} proof additively and idempotently`, async () => acceptanceFixture(async (f) => {
  const paths = [f.options.snapshot, f.options.fixerPlan, f.decisionPath, ...f.fixer.workOrder.requiredReads.map((r) => r.path)];
  const before = await Promise.all(paths.map((p) => readFile(p)));
  const verified = await verifyResidualEvidenceAcceptance(f.options, f.deps);
  assert.equal(verified.status, "accepted");
  await assert.rejects(readdir(path.join(path.dirname(path.dirname(f.options.snapshot)), "accepted")), { code: "ENOENT" });
  const accepted = await acceptResidualEvidence(f.options, f.deps);
  assert.equal(accepted.applied, false);
  assert.notEqual(accepted.reconciliationPath, accepted.snapshotPath);
  assert.equal((await acceptResidualEvidence(f.options, f.deps)).reconciliationPath, accepted.reconciliationPath);
  assert.deepEqual(await Promise.all(paths.map((p) => readFile(p))), before);
  assert.equal(f.calls.some((c) => c.args.some((a) => a.includes("check-pre-push-delta"))), false);
}, harness));

const acceptanceNegatives = {
  unauthenticatedLegacySuccess: async (f) => { f.state.legacyOk = true; await rm(f.fixer.promptPath); },
  foreignFixerIndex: async (f) => { await put(executionIndexPath(f.tmpRoot, f.fixer.executionIdentity), { executionIdentity: "foreign" }); },
  missingFixerReceipt: async (f) => { await rm(pullReceiptPath(f.tmpRoot, f.fixer.workOrderRef)); },
  unknownLedgerField: async (f, ledger) => { ledger.coordinatorAccepted = true; },
  cleanLedgerOverHigh: async (f, ledger) => { ledger.findings = []; ledger.overallVerdict = "clean"; ledger.verdict = "clean"; },
  droppedMember: async (f, ledger) => { ledger.findings.pop(); },
  duplicateMember: async (f, ledger) => { ledger.findings.push(ledger.findings[0]); },
  inventedMember: async (f, ledger) => { ledger.findings[0].summary = "invented"; },
  alteredSourceField: async (f, ledger) => { ledger.findings[0].disposition = "deferred"; },
  unknownFindingField: async (f, ledger) => { ledger.findings[0].trusted = true; },
  badClusterStamp: async (f, ledger) => { ledger.findings[0].clusterId = 999; },
  badJudgeVocabulary: async (f, ledger) => { ledger.findings[0].judgeDisposition = "ignore"; },
  missingDeferEvidence: async (f, ledger) => { ledger.findings[0].judgeDisposition = "defer"; },
  openAct: async (f, ledger) => { ledger.findings[0].judgeDisposition = "act"; },
  contradictoryOverall: async (f, ledger) => { ledger.overallVerdict = "clean"; },
  contradictoryComposed: async (f, ledger) => { ledger.verdict = "findings_present"; },
  findingsMarkerOverCleanRound: async (f) => { f.state.comments[0].body = f.state.comments[0].body.replace("**Verdict:** clean", "**Verdict:** findings_present"); },
  oldGate: async (f) => { f.state.comments[0].updated_at = "2020-01-01T00:00:00Z"; },
  foreignLedgerProvenance: async (f, ledger) => { ledger.provenance.perAngle[1].dispatchId = ledger.provenance.perAngle[0].dispatchId; },
  missingAngleResult: async (f) => { await rm(f.plan.units[0].workOrder.outputRefs[0]); },
  carriedResult: async (f) => { const result = JSON.parse(await readFile(f.resultPath)); await put(f.resultPath, { ...result, carriedFromHead: BASE }); },
  pendingCi: async (f) => { f.state.checks = [{ name: "tests", status: "in_progress", conclusion: null }]; },
  failedCi: async (f) => { f.state.checks = [{ name: "tests", status: "completed", conclusion: "failure" }]; },
  noChecks: async (f) => { f.state.checks = []; },
  verifierWindowReport: async (f) => { f.state.duringDelivery = () => put(f.fixer.workOrder.outputRefs[0], { headSha: HEAD, dispositions: [] }); },
  verifierWindowMarker: async (f) => { f.state.duringDelivery = () => put(`${f.fixer.workOrder.outputRefs[0]}.constructed`, "replacement"); },
  verifierWindowReceipt: async (f) => { f.state.duringDelivery = () => put(pullReceiptPath(f.tmpRoot, f.fixer.workOrderRef), {}); },
  verifierWindowSupplement: async (f) => { f.state.duringDelivery = () => put(f.supplemental, "replacement"); },
  verifierWindowHead: async (f) => { f.state.duringDelivery = () => { f.state.head = BASE; }; },
};
const acceptanceRefusals = {
  unauthenticatedLegacySuccess: /ENOENT/,
  foreignFixerIndex: /foreign fixer execution index/,
  missingFixerReceipt: /ENOENT/,
  unknownLedgerField: /unknown gate ledger field/,
  cleanLedgerOverHigh: /missing findings or open act item/,
  droppedMember: /missing findings or open act item/,
  duplicateMember: /invented, changed or duplicate gate finding/,
  inventedMember: /invented, changed or duplicate gate finding/,
  alteredSourceField: /invented, changed or duplicate gate finding/,
  unknownFindingField: /invented, changed or duplicate gate finding/,
  badClusterStamp: /invented, changed or duplicate gate finding/,
  badJudgeVocabulary: /disposition must be one of: act, defer, reject/,
  missingDeferEvidence: /followUpDraft is required on a defer disposition/,
  openAct: /missing findings or open act item/,
  contradictoryOverall: /gate severity verdict mismatch/,
  contradictoryComposed: /gate severity verdict mismatch/,
  findingsMarkerOverCleanRound: /visible full gate verdict or temporal order mismatch/,
  oldGate: /visible full gate verdict or temporal order mismatch/,
  foreignLedgerProvenance: /foreign full gate ledger provenance/,
  missingAngleResult: /ENOENT/,
  carriedResult: /stale or carried result/,
  pendingCi: /ci_pending/,
  failedCi: /ci_failed/,
  noChecks: /ci_unknown/,
  verifierWindowReport: /acceptance source changed: .*fixer-disposition\.json$/,
  verifierWindowMarker: /acceptance source changed: .*\.constructed$/,
  verifierWindowReceipt: /acceptance source changed: .*work-order-receipts/,
  verifierWindowSupplement: /supplemental bytes changed/,
  verifierWindowHead: /live candidate moved/,
};
// Accepting baseline: every finding is judged reject, so the composed verdict is clean; ledger and marker carry it.
// Each negative then mutates one input and must refuse at its own guard, not at the verdict comparison.
const negativeFindings = [{ severity: "high", summary: "authenticated high", file: "a.mjs", line: 1 }, { severity: "low", summary: "all members retained" }];
const acceptingBaseline = (f, ledger) => { ledger.verdict = "clean"; cleanMarker(f); };
test("acceptance negative baseline accepts before any mutation", async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  acceptingBaseline(f, ledger);
  await put(f.ledgerPath, ledger);
  assert.equal((await verifyResidualEvidenceAcceptance(f.options, f.deps)).proof.verdict, "clean");
}, "pi", negativeFindings));
for (const [name, alter] of Object.entries(acceptanceNegatives)) test(`acceptance refuses ${name}`, async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  acceptingBaseline(f, ledger);
  await alter(f, ledger);
  await put(f.ledgerPath, ledger);
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), acceptanceRefusals[name]);
  await assert.rejects(readdir(path.join(path.dirname(path.dirname(f.options.snapshot)), "accepted")), { code: "ENOENT" });
  if (name.startsWith("verifierWindow")) assert.equal(f.state.deliveryVerified, true);
}, "pi", negativeFindings));

test("acceptance refuses capClosed on a locatable question finding", async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  acceptingBaseline(f, ledger);
  ledger.findings.find((x) => x.severity === "question").capClosed = capClosedOf({ judgeDisposition: "reject", severity: "question" });
  await put(f.ledgerPath, ledger);
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /invalid capClosed record/);
}, "pi", [{ severity: "question", summary: "locatable question", file: "a.mjs", line: 1 }, { severity: "low", summary: "all members retained" }]));

const judged =(ledger, disposition) => {
  for (const finding of ledger.findings) Object.assign(finding, { judgeDisposition: disposition, judgeRationale: "AC 1", ...JUDGE_PROSE,
    ...(disposition === "defer" ? { followUpDraft: { title: "Follow up", body: "Evidence retained" } } : {}),
    ...(disposition === "act" ? { remedyKind: "evidence_only" } : {}) });
  ledger.findings.reverse();
  ledger.verdict = "clean";
};
const cleanMarker = (f) => { f.state.comments[0].body = f.state.comments[0].body.replace(/\*\*Verdict:\*\* \S+/, "**Verdict:** clean"); };

// Accepted forms: defer on a medium cluster, reject on a high cluster, act on an all-nit cluster.
for (const [disposition, severity] of [["reject", "high"], ["defer", "medium"], ["act", "nit"]]) test(`preserves ${disposition} on ${severity} with strict severity floor and complete reordered multiset`, async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  judged(ledger, disposition);
  cleanMarker(f);
  await put(f.ledgerPath, ledger);
  const proof = await verifyResidualEvidenceAcceptance(f.options, f.deps);
  assert.equal(proof.proof.verdict, "clean");
}, "pi", [{ severity, summary: "one" }, { severity, summary: "one" }]));

// Rejected forms: a defer reaching a high, a question or an all-nit cluster (GATE-EXEC-THREAD-DISPOSITION).
for (const severity of ["high", "question", "nit"]) test(`acceptance refuses a ledger that defers a ${severity} cluster`, async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  judged(ledger, "defer");
  cleanMarker(f);
  await put(f.ledgerPath, ledger);
  await assert.rejects(verifyResidualEvidenceAcceptance(f.options, f.deps), /judge defer reaches a never-deferred cluster/);
}, "pi", [{ severity, summary: "one" }, { severity, summary: "one" }]));

test("private projection matches lossless canonical clustering, long prose/paths and bare references", async () => acceptanceFixture(async (f) => {
  const output = path.join(f.root, "parity-ledger.json");
  const findingsDir = path.dirname(f.resultPath);
  await consolidateGateFanin({ findingsDir, headSha: HEAD, ledgerOut: output, repoRoot: f.root });
  const canonical = JSON.parse(await readFile(output));
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  assert.equal(canonical.findings.length, ledger.findings.length);
  for (let i = 0; i < ledger.findings.length; i++) Object.assign(ledger.findings[i], { clusterId: canonical.findings[i].clusterId });
  await put(f.ledgerPath, ledger);
  await verifyResidualEvidenceAcceptance(f.options, f.deps);
  assert.equal(canonical.findings[0].summary.includes("#123"), false);
  assert.equal(canonical.findings[0].summary.length, 2000);
  assert.equal(canonical.findings[0].files[0].length, 300);
  assert.notEqual(canonical.findings[0].clusterId, canonical.findings[1].clusterId);
}, "pi", ["first", "second"].map((tail) => ({ severity: "medium", summary: `issue #123 ${"x".repeat(2200)} ${tail}`, file: "a".repeat(350), line: 1, recommendation: `${"r".repeat(2100)}${tail}`, failingCase: "c".repeat(2100) }))));

test("authenticates delivery-only continuation and its original pulled commit-only execution", async () => acceptanceFixture(async (f) => {
  const proof = await verifyResidualEvidenceAcceptance(f.options, f.deps);
  assert.equal(proof.status, "accepted");
  const originPath = proof.sources.find((s) => s.path.endsWith("original-fixer-emit-plan.json")).path;
  const original = JSON.parse(await readFile(originPath));
  await put(executionIndexPath(f.tmpRoot, original.executionIdentity), { executionIdentity: "foreign" });
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /execution index/);
}, "codex", [], true));

for (const [name, alter] of [
  ["forged status", (v) => { v.status = "accepted"; }], ["forged coordinatorAccepted", (v) => { v.coordinatorAccepted = true; }],
  ["forged roundId", (v) => { v.provenance.roundId = "foreign"; }], ["forged source bytes", (v) => { v.sources[0].base64 = Buffer.from("forged").toString("base64"); }],
]) test(`rejects content-addressed but fabricated snapshot proof: ${name}`, async () => acceptanceFixture(async (f) => {
  const snapshot = JSON.parse(await readFile(f.options.snapshot));
  alter(snapshot);
  const text = JSON.stringify(snapshot), forged = path.join(path.dirname(f.options.snapshot), `${hash(text)}.json`);
  await put(forged, text);
  await assert.rejects(acceptResidualEvidence({ ...f.options, snapshot: forged }, f.deps), /snapshot provenance or bytes changed/);
}));

test("refuses a genuine snapshot copied to a misnamed file or foreign pr directory", async () => acceptanceFixture(async (f) => {
  const text = await readFile(f.options.snapshot, "utf8"), snapshotsDir = path.dirname(f.options.snapshot);
  const foreignPr = path.join(path.dirname(path.dirname(snapshotsDir)), "pr-8", HEAD, "snapshots", path.basename(f.options.snapshot));
  for (const copy of [path.join(snapshotsDir, "misnamed.json"), foreignPr]) {
    await put(copy, text);
    await assert.rejects(acceptResidualEvidence({ ...f.options, snapshot: copy }, f.deps), /foreign snapshot path or digest/);
  }
  await assert.rejects(readdir(path.join(path.dirname(snapshotsDir), "accepted")), /ENOENT/);
}));

test("final publication reauthenticates sources and refuses replacement after CI", async () => acceptanceFixture(async (f) => {
  // The publishRecord recheck is the second full verification: arm on its delivery check, replace after its own CI read.
  let deliveries = 0, replaced = false;
  f.state.duringDelivery = () => { deliveries++; };
  f.state.afterCi = async () => { if (deliveries >= 2 && !replaced) { replaced = true; await put(f.supplemental, "final replacement"); } };
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /supplemental bytes changed|snapshot provenance or bytes changed|source changed/);
  assert.equal(replaced, true);
  await assert.rejects(readdir(path.join(path.dirname(path.dirname(f.options.snapshot)), "accepted")).then((files) => {
    assert.equal(files.some((file) => file.endsWith(".json")), false);
    throw Object.assign(new Error("no published proof"), { code: "ENOENT" });
  }), { code: "ENOENT" });
}));

test("accepted content is immutable even when a conflicting existing record has its name", async () => acceptanceFixture(async (f) => {
  const accepted = await acceptResidualEvidence(f.options, f.deps);
  await put(accepted.reconciliationPath, "conflicting bytes");
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /record collision/);
  assert.equal(await readFile(accepted.reconciliationPath, "utf8"), "conflicting bytes");
}));

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

test("acceptance refuses reviewer pairing that contradicts the resolved fan-out groups", async () => acceptanceFixture(async (f) => {
  // Group two angles in config while the recorded round dispatched them to distinct reviewers.
  await put(path.join(f.root, ".devloops"), "version: 1\ngates:\n  fanout:\n    groups:\n      - name: merged\n        angles: [coverage, threat-model]\n");
  await assert.rejects(verifyResidualEvidenceAcceptance(f.options, f.deps), /independent reviewer pairing/);
}));

test("acceptance refuses a round that lacks a configured mandatory angle, with no accepted write", async () => acceptanceFixture(async (f) => {
  await put(path.join(f.root, ".devloops"), "version: 1\ngates:\n  draft:\n    angles:\n      - name: absent-from-plan\n        mandatory: true\n");
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /incomplete fresh full gate angles/);
  await assert.rejects(readdir(path.join(path.dirname(path.dirname(f.options.snapshot)), "accepted")), { code: "ENOENT" });
}));

const capClosedOf = (finding, over = {}) => ({ judgeDisposition: finding.judgeDisposition, severity: finding.severity, round: 3, cap: 3, ...over });
test("acceptance accepts the writer's resurfaces and capClosed metadata", async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  acceptingBaseline(f, ledger);
  ledger.findings[0].resurfaces = "0123456789abcdef";
  ledger.findings[0].capClosed = capClosedOf(ledger.findings[0]);
  await put(f.ledgerPath, ledger);
  assert.equal((await verifyResidualEvidenceAcceptance(f.options, f.deps)).proof.verdict, "clean");
}, "pi", negativeFindings));

for (const [name, alter, refusal] of [
  ["non-hex resurfaces", (l) => { l.findings[0].resurfaces = "not-a-fingerprint"; }, /invalid resurfaces fingerprint/],
  ["short resurfaces", (l) => { l.findings[0].resurfaces = "0123456789abcde"; }, /invalid resurfaces fingerprint/],
  ["capClosed with an unknown key", (l) => { l.findings[0].capClosed = { ...capClosedOf(l.findings[0]), extra: 1 }; }, /invalid capClosed record/],
  ["capClosed with a foreign disposition", (l) => { l.findings[0].capClosed = capClosedOf(l.findings[0], { judgeDisposition: "defer" }); }, /invalid capClosed record/],
  ["capClosed with a non-integer round", (l) => { l.findings[0].capClosed = capClosedOf(l.findings[0], { round: "3" }); }, /invalid capClosed record/],
  ["capClosed that is not an object", (l) => { l.findings[0].capClosed = true; }, /invalid capClosed record/],
]) test(`acceptance refuses ${name}`, async () => acceptanceFixture(async (f) => {
  const ledger = JSON.parse(await readFile(f.ledgerPath));
  acceptingBaseline(f, ledger);
  alter(ledger);
  await put(f.ledgerPath, ledger);
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), refusal);
}, "pi", negativeFindings));

test("acceptance proof source order follows the plan angle order, not read completion", async () => acceptanceFixture(async (f) => {
  const resultPaths = f.plan.units.flatMap((u) => u.angles.map((a) => path.join(path.dirname(f.resultPath), `${a}.json`)));
  for (let i = 0; i < 3; i++) {
    const order = (await verifyResidualEvidenceAcceptance(f.options, f.deps)).sources.map((s) => s.path).filter((p) => resultPaths.includes(p));
    assert.ok(order.length > 1);
    assert.deepEqual(order, resultPaths.filter((p) => order.includes(p)));
  }
}));

// The delivery verifier is stubbed: full legacy revalidation is owned by verify-fixer-disposition; this covers the binding only.
test("continuation with legacyRevalidation.originalFull accepts when the binding matches", async () => acceptanceFixture(async (f) => {
  f.state.legacyOk = true;
  assert.equal((await verifyResidualEvidenceAcceptance(f.options, f.deps)).status, "accepted");
}, "codex", [], "legacy"));

test("continuation with a changed legacyRevalidation tuple field is refused", async () => acceptanceFixture(async (f) => {
  await assert.rejects(verifyResidualEvidenceAcceptance(f.options, f.deps), /foreign legacy continuation binding/);
}, "codex", [], "foreign-legacy"));

test("continuation with an altered legacy full-phase constructed marker is refused with no accepted write", async () => acceptanceFixture(async (f) => {
  await assert.rejects(acceptResidualEvidence(f.options, f.deps), /foreign constructed report/);
  await assert.rejects(readdir(path.join(path.dirname(path.dirname(f.options.snapshot)), "accepted")), /ENOENT/);
}, "codex", [], "legacy-bad-marker"));

test("delivery check runs the verifier through the default runChild without a stdin or cwd argument", async () => acceptanceFixture(async (f) => {
  const { runChild } = await import("../../scripts/_cli-primitives.mjs");
  const seen = [], inner = f.deps.runChild, stub = await mkdtemp(path.join(os.tmpdir(), "stub-gh-"));
  // A stub gh first on PATH fails at once, so the child never makes a live call.
  await writeFile(path.join(stub, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  f.deps.runChild = async (command, args, env, ...rest) => {
    if (command === process.execPath && args[0].endsWith("verify-fixer-disposition.mjs")) { seen.push(rest); return runChild(command, args, { ...env, PATH: `${stub}${path.delimiter}${env.PATH}` }, ...rest); }
    return inner(command, args, env, ...rest);
  };
  try {
    // The stubbed verifier cannot reach a live PR here; it must still run as a child and refuse, not reject on a misused argument.
    await assert.rejects(acceptResidualEvidence(f.options, f.deps), /full delivery check failed|JSON/);
    assert.deepEqual(seen, [[]]);
  } finally { await rm(stub, { recursive: true, force: true }); }
}));

test("delivery check passes the resolved artifact tmp root to the verifier child", async () => acceptanceFixture(async (f) => {
  const seen = [], inner = f.deps.runChild;
  f.deps.runChild = async (command, args, env, ...rest) => {
    if (command === process.execPath && args[0].endsWith("verify-fixer-disposition.mjs")) seen.push(args[args.indexOf("--tmp-root") + 1]);
    return inner(command, args, env, ...rest);
  };
  await verifyResidualEvidenceAcceptance(f.options, f.deps);
  assert.deepEqual(seen, [path.resolve(resolveGateArtifactTmpRoot(f.deps.repoRoot))]);
}));
