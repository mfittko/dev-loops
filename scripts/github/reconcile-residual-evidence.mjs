#!/usr/bin/env node
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FANOUT_PROVENANCE_MIN_REVIEWERS } from "@dev-loops/core/config";
import { parseReviewThreads } from "@dev-loops/core/github/review-threads";
import { startDeltaSequence, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { checkFanoutAngleCoverage, consolidateFanin, fanoutReviewerPairingError, provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { normalizeHeadScopedCiContract } from "@dev-loops/core/loop/copilot-ci-status";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, runChild as defaultRunChild, runCommand as defaultRunCommand } from "../_cli-primitives.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { gateDeltaRecordPath } from "../loop/_gate-delta-record.mjs";
import { buildLogPath, repoSlugFor } from "./_gate-artifact-paths.mjs";
import { WORK_ORDER_ROLES, executionIndexPath, materializationHash, pullReceiptPath, verifyPulledResult, workOrderDigest } from "./_work-order-protocol.mjs";
import "./pull-work-order.mjs";
import { buildGateEmitPlanPath, buildGateReviewsDir } from "./write-gate-context.mjs";
import { detectCheckpointEvidence } from "./detect-checkpoint-evidence.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { collectFingerprints, fetchGateEvidenceComments } from "./_gate-finding-surface.mjs";
import { selectActThreadBinding } from "./_fixer-act-thread-bindings.mjs";
import { resolveAuthenticatedLogin } from "./post-gate-findings.mjs";
import { observeHeadCiSignals } from "./observe-head-ci.mjs";
import { dispatchPromptLayoutRecordPath } from "./record-dispatch-prompt-layout.mjs";
import { verifyDispatchPromptLayoutForHead } from "./verify-dispatch-prompt-layout.mjs";
import { sanitizeScopeSegment } from "./_dispatch-units.mjs";
import { realpathNearestExisting } from "@dev-loops/core/loop/worktree-guard";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `reconcile-residual-evidence.mjs --repo <owner/name> --pr <n> --head-sha <full-sha> --baseline <full-sha> --angle <name> --fixer-plan <path> [--record]\n${JQ_OUTPUT_USAGE}`;
const hash = (bytes) => sha256Hex(bytes).slice(7);
const requireProof = (condition, reason) => { if (!condition) throw new Error(`residual evidence refused: ${reason}`); };
const nonempty = (s) => typeof s === "string" && s.trim().length > 0;
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === new Set(a).size && isDeepStrictEqual([...a].sort(), [...b].sort());
const keys = (value, expected) => value && sameSet(Object.keys(value), expected.split(" "));

export function parseResidualEvidenceArgs(argv) {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    ...JQ_OUTPUT_PARSE_OPTIONS,
    repo: { type: "string" }, pr: { type: "string" }, "head-sha": { type: "string" }, baseline: { type: "string" },
    angle: { type: "string" }, "fixer-plan": { type: "string" }, record: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) return { help: true };
  parseRepoSlug(values.repo);
  const pr = parsePrNumber(values.pr, (s) => new Error(s));
  requireProof(normalizeFullHeadSha(values["head-sha"]) === values["head-sha"]
    && normalizeFullHeadSha(values.baseline) === values.baseline, "full candidate and baseline SHAs required");
  requireProof(nonempty(values.angle) && nonempty(values["fixer-plan"]), "angle and canonical fixer plan required");
  return { repo: values.repo, pr, headSha: values["head-sha"], baseline: values.baseline,
    angle: values.angle, fixerPlan: values["fixer-plan"], record: values.record === true,
    jq: values.jq, silent: values.silent, fields: values.fields };
}

export async function verifyResidualEvidenceAssessment(options, {
  repoRoot = process.cwd(), env = process.env, ghCommand = "gh", runChild = defaultRunChild, runCommand = defaultRunCommand,
} = {}) {
  const { repo, pr, headSha, baseline, angle } = options;
  parseRepoSlug(repo);
  requireProof(Number.isSafeInteger(pr) && pr > 0 && normalizeFullHeadSha(headSha) === headSha
    && normalizeFullHeadSha(baseline) === baseline, "invalid target");
  repoRoot = await realpath(repoRoot);
  const receiptTmpRoot = path.resolve(resolveGateArtifactTmpRoot(repoRoot));
  const tmpRoot = path.join(repoRoot, "tmp"), key = { repo, pr, headSha, gate: "draft_gate", tmpRoot };
  const runtime = { env, ghCommand, runChild, cwd: repoRoot };
  const sources = new Map();
  async function capture(file) {
    requireProof(path.isAbsolute(file) && await realpath(file) === file && (await lstat(file)).isFile(), `noncanonical source ${file}`);
    const bytes = await readFile(file), info = await lstat(file);
    const prior = sources.get(file);
    requireProof(!prior || prior.sha256 === hash(bytes) && prior.mtimeMs === info.mtimeMs, `source changed: ${file}`);
    sources.set(file, { path: file, sha256: hash(bytes), base64: bytes.toString("base64"), mtimeMs: info.mtimeMs });
    return bytes;
  }
  const json = async (file) => {
    const text = (await capture(file)).toString("utf8");
    const value = JSON.parse(text);
    requireProof(parseDocument(text, { uniqueKeys: true }).errors.length === 0, `duplicate or ambiguous JSON keys: ${file}`);
    return value;
  };
  const fixerPlanPath = path.join(receiptTmpRoot, "gate-fixer", repoSlugFor(repo), `pr-${pr}`, "fixer-emit-plan.json");
  requireProof(path.resolve(repoRoot, options.fixerPlan) === fixerPlanPath, "foreign fixer plan");
  const fixer = await json(fixerPlanPath), order = fixer.workOrder;
  requireProof(order?.role === "fixer" && order.phase === "full" && order.source === "act-list"
    && order.target?.repo === repo && order.target.pr === pr && workOrderDigest(order) === fixer.workOrderDigest,
  "foreign full fixer authority");
  const reads = new Map();
  for (const read of order.requiredReads ?? []) {
    const bytes = await capture(read.path);
    requireProof(hash(bytes) === read.sha256, `changed ${read.kind} bytes`);
    requireProof(!reads.has(read.kind), `duplicate ${read.kind} read`);
    const value = ["act-list", "delta-result", "completion-input"].includes(read.kind) ? JSON.parse(bytes) : null;
    reads.set(read.kind, { read, value });
  }
  const act = reads.get("act-list")?.value, delta = reads.get("delta-result")?.value;
  const sequence = startDeltaSequence({ reviewBaselineHead: baseline, actList: act });
  requireProof(validateDeltaResult(delta, { sequence, membershipOnly: true }).length === 0
    && delta.reviewBaselineHead === baseline && delta.candidateHead === headSha, "not the exact exhausted delta result");
  const decisionPath = gateDeltaRecordPath(receiptTmpRoot, baseline), decision = await json(decisionPath);
  const statuses = (items) => items.map(({ ref, status }) => [ref, status]).sort(([a], [b]) => a.localeCompare(b));
  requireProof(decision.reviewBaselineHead === baseline && decision.candidateHead === headSha
    && decision.actSetId === sequence.actSetId && decision.invocation === 3
    && decision.outcome === "bounded_out" && decision.nextStep === "push_to_gate"
    && isDeepStrictEqual(statuses(decision.items), statuses(delta.actionableItems)), "not invocation-three bounded_out/push_to_gate");
  const verifier = fileURLToPath(new URL("./verify-fixer-disposition.mjs", import.meta.url));
  const delivered = await runCommand(process.execPath, [verifier, "--repo", repo, "--pr", String(pr),
    "--head-sha", headSha, "--fixer-plan", fixerPlanPath, "--tmp-root", receiptTmpRoot, "--check"], { cwd: repoRoot, env });
  const delivery = JSON.parse(delivered.stdout);
  requireProof(delivery?.ok === true && delivery.complete === true
    && delivery.repo === repo && delivery.pr === pr && delivery.headSha === headSha,
  "authenticated fixer delivery missing or incomplete");
  const report = path.join(path.dirname(fixerPlanPath), fixer.executionIdentity, "fixer-disposition.json");
  await capture(report);
  await capture(`${report}.constructed`);
  await capture(pullReceiptPath(receiptTmpRoot, fixer.workOrderRef));
  if (fixer.promptPath) await capture(fixer.promptPath);
  const completion = reads.get("completion-input")?.value;
  if (completion?.origin) {
    const originalDir = path.join(path.dirname(fixerPlanPath), completion.origin.executionIdentity);
    const original = await json(path.join(originalDir, "original-fixer-emit-plan.json"));
    await capture(path.join(originalDir, "fixer-disposition.json"));
    await capture(original.promptPath);
    await capture(pullReceiptPath(receiptTmpRoot, original.workOrderRef));
    for (const read of original.workOrder.requiredReads) await capture(read.path);
  }
  const planPath = buildGateEmitPlanPath(key), plan = await json(planPath);
  requireProof(plan.ok === true && plan.repo === repo && String(plan.pr) === String(pr) && plan.gate === "draft_gate"
    && plan.headSha === headSha && /^r\d+-[a-f0-9]{8}$/.test(plan.roundId) && Array.isArray(plan.units)
    && plan.units.length >= FANOUT_PROVENANCE_MIN_REVIEWERS && plan.count === plan.units.length
    && (!plan.carried || Array.isArray(plan.carried) && plan.carried.length === 0), "not a current fresh full draft plan");
  requireProof(Number(plan.roundId.match(/^r(\d+)-/)[1]) >= sources.get(decisionPath).mtimeMs, "reviewer round predates exhausted delta");
  const artifacts = [], resultPaths = [], expectedProvenance = [];
  const layout = await verifyDispatchPromptLayoutForHead(tmpRoot, headSha);
  requireProof(layout.verified && layout.recordCount >= plan.units.length, "missing or invalid canonical dispatch layout");
  let assessment, assessmentUnit;
  for (const [unitIndex, unit] of plan.units.entries()) {
    const w = unit.workOrder;
    requireProof(w?.role === "review" && w.operation === "gate" && w.target?.repo === repo && String(w.target.pr) === String(pr)
      && w.headSha === headSha && w.roundIdentity?.gate === "draft_gate" && w.roundIdentity.headSha === headSha
      && sameSet(w.assignedAngles, unit.angles) && workOrderDigest(w) === unit.workOrderDigest
      && unit.executionIdentity === `${plan.roundId}-u${unitIndex}`, "foreign reviewer unit");
    const query = { ref: unit.workOrderRef, digest: unit.workOrderDigest, execution: unit.executionIdentity, tmpRoots: [tmpRoot] };
    const located = await WORK_ORDER_ROLES.get("review").locate(query);
    requireProof(located && !located.stale && located.executionIdentity === unit.executionIdentity, located?.stale ?? "missing current reviewer authority");
    const promptPath = path.join(path.dirname(planPath), `draft_gate-${headSha}.dispatch-prompt-${unit.scope}.txt`);
    requireProof(unit.promptPath === promptPath
      && unit.workOrderRef === `review:${repo}#${pr}:draft_gate:${headSha}:${unit.scope}`,
    "foreign reviewer materialization path/reference");
    const prompt = await capture(promptPath);
    requireProof(materializationHash(prompt) === unit.materializationHash, "changed reviewer materialization");
    const index = await json(executionIndexPath(tmpRoot, unit.executionIdentity));
    const identity = { executionIdentity: unit.executionIdentity,
      workOrderRef: unit.workOrderRef, workOrderDigest: unit.workOrderDigest };
    requireProof(isDeepStrictEqual(index, identity), "foreign execution index");
    const layoutRecord = await json(dispatchPromptLayoutRecordPath(tmpRoot, unit.scope, headSha));
    requireProof(isDeepStrictEqual(layoutRecord.compactReference, identity), "foreign dispatch layout identity");
    requireProof(hash(await capture(layoutRecord.prefixPath)) === w.roundIdentity.prefixSha256, "changed invariant prefix"); // secret-scan:allow Runtime digest field comparison; no credential literal
    const sentinelPath = path.join(tmpRoot, `checkpoint-context-sentinel-${unit.scope}-${headSha}.json`);
    const sentinel = await json(sentinelPath);
    requireProof(sentinel.scope === unit.scope && sentinel.round === headSha
      && sentinel.prefixHash === w.roundIdentity.prefixSha256, "missing fresh reviewer context proof"); // secret-scan:allow Runtime digest field comparison; no credential literal
    requireProof(w.outputRefs.length === unit.angles.length, "partial output ownership");
    for (const [i, name] of unit.angles.entries()) {
      const resultPath = path.join(buildGateReviewsDir(key), `${sanitizeScopeSegment(name) || "angle"}.json`);
      requireProof(w.outputRefs[i] === resultPath, "foreign result outputRef");
      const result = await json(resultPath);
      const pull = await verifyPulledResult({ resultPath, receiptTmpRoot, role: "review", ...unit });
      requireProof(pull.ok && pull.receipt.materializationHash === unit.materializationHash
        && isDeepStrictEqual(pull.receipt.subject, { repo, pr, gate: "draft_gate", headSha, roundId: plan.roundId, scope: unit.scope }),
      `review pull/result failed: ${pull.reason ?? "subject/materialization"}`);
      await capture(pullReceiptPath(receiptTmpRoot, unit.workOrderRef));
      const sentinelTime = sources.get(sentinelPath).mtimeMs;
      requireProof(sentinelTime >= sources.get(pullReceiptPath(receiptTmpRoot, unit.workOrderRef)).mtimeMs
        && sentinelTime <= sources.get(resultPath).mtimeMs, "reviewer sentinel predates pull or follows result");
      requireProof(result.angle === name && result.headSha === headSha && !Object.hasOwn(result, "carriedFromHead"), "stale or carried result");
      for (const read of w.requiredReads) requireProof(hash(await capture(read.path)) === read.sha256, "changed reviewer required read");
      artifacts.push(result);
      resultPaths.push(resultPath);
      expectedProvenance.push({ angle: name, dispatchId: unit.executionIdentity, ...(unit.group ? { group: unit.group } : {}) });
      if (name === angle) {
        requireProof(!assessmentUnit, "ambiguous assessor");
        assessment = result.residualEvidenceAssessment;
        assessmentUnit = unit;
      }
    }
  }
  requireProof(assessment && assessmentUnit && consolidateFanin({ angleResults: artifacts }).malformed.length === 0,
    "missing explicit assessment or malformed reviewer result");
  requireProof(keys(assessment,
    "repo pr headSha reviewBaselineHead actSetId deltaResultSha256 decisionSha256 roots supplementalFiles limitations"),
  "unknown or missing assessment keys");
  requireProof(assessment.repo === repo && assessment.pr === pr && assessment.headSha === headSha
    && assessment.reviewBaselineHead === baseline && assessment.actSetId === sequence.actSetId
    && assessment.deltaResultSha256 === sources.get(reads.get("delta-result").read.path).sha256
    && assessment.decisionSha256 === sources.get(decisionPath).sha256, "foreign or tampered assessment binding");
  requireProof(Array.isArray(assessment.limitations) && assessment.limitations.length > 0
    && assessment.limitations.every(nonempty) && Array.isArray(assessment.supplementalFiles)
    && assessment.supplementalFiles.length > 0, "explicit supplemental files and limitations required");
  requireProof(sameSet(assessment.supplementalFiles.map((f) => f.path), assessment.supplementalFiles.map((f) => f.path)), "duplicate supplemental files");
  for (const file of assessment.supplementalFiles) {
    requireProof(keys(file, "path sha256") && hash(await capture(file.path)) === file.sha256,
      "supplemental bytes changed or unknown keys");
  }
  const threadNodes = await fetchGithubReviewThreadsPayload({ repo, pr }, runtime);
  const parsed = parseReviewThreads(threadNodes);
  const login = await resolveAuthenticatedLogin(runtime), fingerprints = new Set(act.map((a) => a.fingerprint));
  const residual = new Set(delta.actionableItems.filter((a) => a.status !== "resolved").map((a) => a.ref)), covered = [];
  const expectedRoots = [];
  for (const thread of parsed.threads) {
    const { root, members } = selectActThreadBinding(parsed, thread.id, login, fingerprints);
    const refs = sequence.actItems.filter((a) => members.includes(a.fingerprint ?? a.ref)).map((a) => a.ref);
    if (!refs.some((r) => residual.has(r))) continue;
    const all = new Set();
    collectFingerprints(root.body, all);
    requireProof(thread.isResolved === false && sameSet([...all], members), "resolved or incomplete root membership");
    const rawComments = threadNodes.find((t) => t.id === thread.id).comments;
    const rawRoot = (rawComments.nodes ?? rawComments).find((c) => c.id === root.id);
    requireProof(typeof rawRoot?.body === "string", "missing original root bytes");
    expectedRoots.push({ threadId: thread.id, rootCommentId: root.id, rootSha256: hash(rawRoot.body), refs });
    covered.push(...refs.filter((r) => residual.has(r)));
  }
  requireProof(residual.size > 0 && sameSet(covered, [...residual])
    && sameSet(assessment.roots?.map((r) => r.threadId), expectedRoots.map((r) => r.threadId)), "partial or foreign residual roots");
  for (const expected of expectedRoots) {
    const claimed = assessment.roots.find((r) => r.threadId === expected.threadId);
    requireProof(keys(claimed, "threadId rootCommentId rootSha256 members")
      && claimed.rootCommentId === expected.rootCommentId && claimed.rootSha256 === expected.rootSha256
      && sameSet(claimed.members?.map((m) => m.ref), expected.refs)
      && claimed.members.every((m) => keys(m, "ref conclusion evidence") && m.conclusion === "resolved"
        && Array.isArray(m.evidence) && m.evidence.length > 0 && m.evidence.every(nonempty)),
    "partial, contradictory or nonpositive member assessment");
  }
  const ci = await observeHeadCiSignals({ repo, headSha }, runtime);
  requireProof(ci.checkRuns.ok && ci.statuses.ok && normalizeHeadScopedCiContract({
    checkRunsStatus: ci.checkRuns.fullSignal.status, commitStatus: ci.statuses.commitStatus,
    checkRunsUnsupportedCompleted: ci.checkRuns.fullSignal.unsupportedCompleted,
  }).overallStatus === "success", "CI not settled green");
  const gate = await detectCheckpointEvidence({ repo, pr }, runtime);
  const marker = gate.draftGateMarker, full = gate.fanoutEnforcement?.gates?.find((g) => g.name === "draft_gate");
  requireProof(gate.currentHeadSha === headSha && marker.visible && marker.verdict === "clean"
    && marker.contractComplete === true && marker.headSha === headSha && !marker.convergedFromHeadSha
    && marker.executionMode === "fanout_fanin" && full?.ledgerExists, "subsequent valid full draft gate missing");
  const gateSurface = (await fetchGateEvidenceComments({ repo, pr }, runtime))
    .find((c) => c.id === marker.commentId && c.surface === marker.surface);
  requireProof(nonempty(gateSurface?.body), "missing original full-gate surface bytes");
  const ledger = await json(buildLogPath({ ...key, tmpRoot: receiptTmpRoot }));
  requireProof(ledger.repo === repo && ledger.pr === pr && ledger.headSha === headSha
    && ledger.gate === "draft_gate" && ledger.executionMode === "fanout_fanin", "foreign full gate ledger");
  const provenance = ledger.provenance;
  const coverage = checkFanoutAngleCoverage(provenance?.perAngle, { mandatoryAngles: full.mandatoryAngles, pool: full.anglePool });
  requireProof(provenanceConsistencyError(provenance) === null && provenance.distinctReviewers >= plan.units.length
    && isDeepStrictEqual(provenance.perAngle, expectedProvenance), "full gate provenance differs from authenticated round");
  const pairingError = fanoutReviewerPairingError(provenance.perAngle, full.resolvedGroups, provenance.dispatchUnits);
  requireProof(!pairingError, `full gate reviewer pairing: ${pairingError}`);
  requireProof(coverage.missingMandatory.length === 0 && coverage.foreignAngles.length === 0,
    `full gate coverage: ${JSON.stringify(coverage)}`);
  const resultTimes = resultPaths.map((p) => sources.get(p).mtimeMs);
  requireProof(Date.parse(marker.updatedAt) >= Math.max(...resultTimes)
    && Date.parse(marker.updatedAt) > sources.get(decisionPath).mtimeMs, "gate predates assessed result or exhausted delta");
  for (const source of sources.values()) await capture(source.path);
  for (const unit of plan.units) {
    const current = await WORK_ORDER_ROLES.get("review").locate({ ref: unit.workOrderRef,
      digest: unit.workOrderDigest, execution: unit.executionIdentity, tmpRoots: [tmpRoot] });
    requireProof(current && !current.stale, "reviewer authority retired during verification");
  }
  const live = await runChild(ghCommand, ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"], env);
  requireProof(live.code === 0 && JSON.parse(live.stdout).headRefOid === headSha, "live candidate moved");
  return { schemaVersion: 1, repo, pr, headSha, assessment,
    reviewer: { workOrderRef: assessmentUnit.workOrderRef, executionIdentity: assessmentUnit.executionIdentity,
      workOrderDigest: assessmentUnit.workOrderDigest, roundId: plan.roundId },
    observations: { delivery, ci, draftGate: marker, gateSurface, login,
      threadNodes: threadNodes.filter((t) => expectedRoots.some((r) => r.threadId === t.id)) },
    sources: [...sources.values()] };
}

export async function reconcileResidualEvidence(options, deps = {}) {
  const proof = await verifyResidualEvidenceAssessment(options, deps);
  const tmpRoot = path.resolve(resolveGateArtifactTmpRoot(deps.repoRoot ?? process.cwd()));
  const text = `${JSON.stringify(proof, null, 2)}\n`;
  const reconciliationPath = path.join(tmpRoot, "residual-evidence", repoSlugFor(proof.repo),
    `pr-${proof.pr}`, proof.headSha, `${hash(text)}.json`);
  if (options.record) {
    requireProof(path.normalize(realpathNearestExisting(path.dirname(reconciliationPath))) === path.dirname(reconciliationPath),
      "noncanonical record ancestry");
    await mkdir(path.dirname(reconciliationPath), { recursive: true });
    requireProof(await realpath(path.dirname(reconciliationPath)) === path.dirname(reconciliationPath), "noncanonical record directory");
    await writeFile(reconciliationPath, text, { flag: "wx" }).catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      requireProof((await readFile(reconciliationPath, "utf8")) === text, "record collision");
    });
  }
  return { ok: true, assessed: true, recorded: options.record === true, applied: false,
    repo: proof.repo, pr: proof.pr, headSha: proof.headSha,
    threads: proof.assessment.roots.map((r) => ({ threadId: r.threadId, isResolved: false })),
    reconciliationPath: options.record ? reconciliationPath : null };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    const options = parseResidualEvidenceArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else process.exitCode = emitResult(await reconcileResidualEvidence(options), options);
  } catch (error) { console.error(formatCliError(error)); process.exitCode = 1; }
}
