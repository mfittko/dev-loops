#!/usr/bin/env node
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FANOUT_PROVENANCE_MIN_REVIEWERS, loadDevLoopConfigStrict, resolveGateConfig, resolveGateAngleContract, resolveFanoutGroups } from "@dev-loops/core/config";
import { parseReviewThreads } from "@dev-loops/core/github/review-threads";
import { startDeltaSequence, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { consolidateFanin, checkResolvedAngleEvidence, fanoutReviewerPairingError, toFindingsLogShape, composeReviewVerdict, listOpenActItems, validateJudgeVerdict, neverDeferredSeverity } from "@dev-loops/core/loop/gate-fanin";
import { clusterFindings } from "@dev-loops/core/loop/finding-cluster";
import { neutralizeBareIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
import { normalizeHeadScopedCiContract } from "@dev-loops/core/loop/copilot-ci-status";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { formatCliError, isDirectCliRun, summarizeGateReviewCommentMarkers } from "../_core-helpers.mjs";
import { parsePrNumber, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { gateDeltaRecordPath } from "../loop/_gate-delta-record.mjs";
import { repoSlugFor, buildLogPath, buildGateContextPath } from "./_gate-artifact-paths.mjs";
import { authenticateOriginalPlan } from "./_fixer-emission-evidence.mjs";
import { readContextDispatchUnits } from "./write-gate-findings-log.mjs";
import { observeHeadCiSignals } from "./observe-head-ci.mjs";
import { WORK_ORDER_ROLES, executionIndexPath, materializationHash, pullReceiptPath, verifyPulledResult, workOrderDigest } from "./_work-order-protocol.mjs";
import "./pull-work-order.mjs";
import { buildGateEmitPlanPath, buildGateReviewsDir, renderRequiredReadLine } from "./write-gate-context.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { collectFingerprints, normalizePrReviewsPayload, prReviewsApiArgs } from "./_gate-finding-surface.mjs";
import { selectActThreadBinding } from "./_fixer-act-thread-bindings.mjs";
import { resolveAuthenticatedLogin } from "./post-gate-findings.mjs";
import { dispatchPromptLayoutRecordPath } from "./record-dispatch-prompt-layout.mjs";
import { verifyDispatchPromptLayoutForHead } from "./verify-dispatch-prompt-layout.mjs";
import { sanitizeScopeSegment } from "./_dispatch-units.mjs";
import { realpathNearestExisting } from "@dev-loops/core/loop/worktree-guard";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `reconcile-residual-evidence.mjs --repo <owner/name> --pr <n> --head-sha <full-sha> --baseline <full-sha> --angle <name> --fixer-plan <path> [--record | --accept --snapshot <canonical-path>]\n${JQ_OUTPUT_USAGE}`;
const hash = (bytes) => sha256Hex(bytes).slice(7);
const requireProof = (condition, reason) => { if (!condition) throw new Error(`residual evidence refused: ${reason}`); };
const nonempty = (s) => typeof s === "string" && s.trim().length > 0;
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === new Set(a).size && isDeepStrictEqual([...a].sort(), [...b].sort());
const keys = (value, expected) => value && sameSet(Object.keys(value), expected.split(" "));

export function parseResidualEvidenceArgs(argv) {
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: {
    ...JQ_OUTPUT_PARSE_OPTIONS,
    repo: { type: "string" }, pr: { type: "string" }, "head-sha": { type: "string" }, baseline: { type: "string" },
    angle: { type: "string" }, "fixer-plan": { type: "string" }, record: { type: "boolean" }, accept: { type: "boolean" }, snapshot: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) return { help: true };
  parseRepoSlug(values.repo);
  const pr = parsePrNumber(values.pr, (s) => new Error(s));
  requireProof(normalizeFullHeadSha(values["head-sha"]) === values["head-sha"]
    && normalizeFullHeadSha(values.baseline) === values.baseline, "full candidate and baseline SHAs required");
  requireProof(nonempty(values.angle) && nonempty(values["fixer-plan"]), "angle and canonical fixer plan required");
  requireProof(!values.accept || nonempty(values.snapshot), "accept requires snapshot");
  requireProof(values.snapshot === undefined || values.accept, "snapshot requires accept");
  requireProof(!values.accept || !values.record, "incompatible modes");
  return { repo: values.repo, pr, headSha: values["head-sha"], baseline: values.baseline,
    angle: values.angle, fixerPlan: values["fixer-plan"], record: values.record === true,
    accept: values.accept === true, snapshot: values.snapshot,
    jq: values.jq, silent: values.silent, fields: values.fields };
}

export async function verifyResidualEvidenceSnapshot(options, {
  repoRoot = process.cwd(), env = process.env, ghCommand = "gh", runChild = defaultRunChild,
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
    sources.set(file, { ...prior, path: file, sha256: hash(bytes), base64: bytes.toString("base64"), mtimeMs: info.mtimeMs });
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
    const value = ["act-list", "delta-result", "completion-input"].includes(read.kind) ? await json(read.path) : null;
    reads.set(read.kind, { read, value });
  }
  const act = reads.get("act-list")?.value, delta = reads.get("delta-result")?.value;
  requireProof(act && delta && hash(act) === order.authority?.sourceDigest
    && hash(delta) === order.authority?.deltaResultDigest, "changed ACT or delta semantic authority");
  const sequence = startDeltaSequence({ reviewBaselineHead: baseline, actList: act });
  requireProof(validateDeltaResult(delta, { sequence, membershipOnly: true }).length === 0
    && delta.reviewBaselineHead === baseline && delta.candidateHead === headSha, "not the exact exhausted delta result");
  const decisionPath = gateDeltaRecordPath(receiptTmpRoot, baseline), decision = await json(decisionPath);
  const statuses = (items) => items.map(({ ref, status }) => [ref, status]).sort(([a], [b]) => a.localeCompare(b));
  requireProof(decision.reviewBaselineHead === baseline && decision.candidateHead === headSha
    && decision.actSetId === sequence.actSetId && decision.invocation === 3
    && decision.outcome === "bounded_out" && decision.nextStep === "push_to_gate"
    && isDeepStrictEqual(statuses(decision.items), statuses(delta.actionableItems)), "not invocation-three bounded_out/push_to_gate");
  const planPath = buildGateEmitPlanPath(key), plan = await json(planPath);
  requireProof(plan.ok === true && plan.repo === repo && String(plan.pr) === String(pr) && plan.gate === "draft_gate"
    && plan.headSha === headSha && /^r\d+-[a-f0-9]{8}$/.test(plan.roundId) && Array.isArray(plan.units)
    && plan.units.length >= FANOUT_PROVENANCE_MIN_REVIEWERS && plan.count === plan.units.length
    && (!plan.carried || Array.isArray(plan.carried) && plan.carried.length === 0), "not a current fresh full draft plan");
  requireProof(Number(plan.roundId.match(/^r(\d+)-/)[1]) >= sources.get(decisionPath).mtimeMs, "reviewer round predates exhausted delta");
  const artifacts = [], reviewerReads = [], unpinnedContext = new Set();
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
      for (const read of w.requiredReads) {
        const readPath = path.resolve(repoRoot, read.path);
        requireProof(path.normalize(realpathNearestExisting(readPath)) === readPath, "noncanonical reviewer read ancestry");
        requireProof(!read.required || /^[a-f0-9]{64}$/.test(read.sha256), "required reviewer read lacks pin");
        requireProof(read.sha256 === undefined || /^[a-f0-9]{64}$/.test(read.sha256), "invalid reviewer read pin");
        requireProof(read.sha256 !== undefined || read.required === false && read.kind === "context", "unpinned substantive read");
        requireProof(prompt.toString("utf8").split("\n").includes(renderRequiredReadLine(read, repoRoot)),
          "reviewer read differs from pulled materialization");
        const present = await lstat(readPath).then(() => true, (error) => {
          if (error.code === "ENOENT" && read.required === false) return false;
          throw error;
        });
        if (present) {
          const bytes = await capture(readPath);
          requireProof(read.sha256 === undefined || hash(bytes) === read.sha256, "changed reviewer required read");
        }
        if (read.sha256 === undefined) {
          unpinnedContext.add(readPath);
          if (present) sources.get(readPath).qualification = "unpinned-context";
        }
        reviewerReads.push({ path: readPath, kind: read.kind, status: !present ? "absent"
          : read.sha256 === undefined ? "unpinned-context" : "pinned" });
      }
      artifacts.push(result);
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
    requireProof(keys(file, "path sha256") && !unpinnedContext.has(file.path) && hash(await capture(file.path)) === file.sha256,
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
  requireProof(residual.size > 0 && sameSet([...new Set(covered)], [...residual])
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
  const live = await runChild(ghCommand, ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"], env);
  requireProof(live.code === 0 && JSON.parse(live.stdout).headRefOid === headSha, "live candidate moved");
  for (const unit of plan.units) {
    const current = await WORK_ORDER_ROLES.get("review").locate({ ref: unit.workOrderRef,
      digest: unit.workOrderDigest, execution: unit.executionIdentity, tmpRoots: [tmpRoot] });
    requireProof(current && !current.stale, "reviewer authority retired during verification");
  }
  for (const source of sources.values()) await capture(source.path);
  return { schemaVersion: 1, kind: "residual-evidence-snapshot", status: "unqualified", repo, pr, headSha, assessment,
    provenance: { workOrderRef: assessmentUnit.workOrderRef, executionIdentity: assessmentUnit.executionIdentity,
      workOrderDigest: assessmentUnit.workOrderDigest, roundId: plan.roundId, requiredReads: reviewerReads },
    observations: { login,
      threadNodes: threadNodes.filter((t) => expectedRoots.some((r) => r.threadId === t.id)) },
    limitations: [...assessment.limitations, "Delivery, CI and full-gate validity are not established; no acceptance or closure authority.",
      "Unpinned optional context is navigation only, never authenticated substantive proof."],
    sources: [...sources.values()] };
}

async function publishRecord(snapshotPath, text, recheck = async () => {}) {
  requireProof(path.normalize(realpathNearestExisting(path.dirname(snapshotPath))) === path.dirname(snapshotPath),
    "noncanonical record ancestry");
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  requireProof(await realpath(path.dirname(snapshotPath)) === path.dirname(snapshotPath), "noncanonical record directory");
  const temporary = await mkdtemp(path.join(path.dirname(snapshotPath), ".snapshot-"));
  try {
    const pending = path.join(temporary, "snapshot.json");
    await writeFile(pending, text, { flag: "wx" });
    await recheck();
    // Link only complete bytes, without replacing an existing snapshot.
    await link(pending, snapshotPath).catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
      requireProof(await realpath(path.dirname(snapshotPath)) === path.dirname(snapshotPath)
        && (await lstat(snapshotPath)).isFile(), "noncanonical snapshot");
      requireProof((await readFile(snapshotPath, "utf8")) === text, "record collision");
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function snapshotResidualEvidence(options, deps = {}) {
  const proof = await verifyResidualEvidenceSnapshot(options, deps);
  const tmpRoot = path.resolve(resolveGateArtifactTmpRoot(deps.repoRoot ?? process.cwd()));
  const text = `${JSON.stringify(proof, null, 2)}\n`;
  const snapshotPath = path.join(tmpRoot, "residual-evidence", repoSlugFor(proof.repo),
    `pr-${proof.pr}`, proof.headSha, "snapshots", `${hash(text)}.json`);
  if (options.record) await publishRecord(snapshotPath, text);
  return { ok: true, status: "unqualified", recorded: options.record === true, applied: false,
    repo: proof.repo, pr: proof.pr, headSha: proof.headSha,
    threads: proof.assessment.roots.map((r) => ({ threadId: r.threadId, isResolved: false })),
    snapshotPath: options.record ? snapshotPath : null };
}

// Keep this projection in parity with consolidate-fanin: cluster lossless text first.
function projectFindings(consolidated, headSha) {
  const { clusters } = clusterFindings(consolidated.findings, { headSha });
  const truncate = (text, limit = 2000) => text.length <= limit ? text : `${text.slice(0, limit - 2)} …`;
  for (const finding of consolidated.findings) {
    for (const key of ["summary", "recommendation", "failingCase"]) {
      if (finding[key]) finding[key] = truncate(neutralizeBareIssuePrIds(finding[key]));
    }
    if (finding.file) finding.file = truncate(finding.file, 300);
  }
  const findings = toFindingsLogShape(consolidated.findings);
  for (const cluster of clusters) for (const i of cluster.memberIndices) findings[i].clusterId = cluster.representativeIndex;
  return findings;
}

export async function verifyResidualEvidenceAcceptance(options, deps = {}) {
  const repoRoot = await realpath(deps.repoRoot ?? process.cwd()), { repo, pr, headSha } = options;
  const tmpRoot = path.resolve(resolveGateArtifactTmpRoot(repoRoot)), key = { repo, pr, headSha, gate: "draft_gate", tmpRoot: path.join(repoRoot, "tmp") };
  const runtime = { env: deps.env ?? process.env, ghCommand: deps.ghCommand ?? "gh", runChild: deps.runChild ?? defaultRunChild };
  const captured = new Map();
  async function capture(file) {
    requireProof(path.isAbsolute(file) && await realpath(file) === file, "noncanonical acceptance source");
    const before = await lstat(file), bytes = await readFile(file), after = await lstat(file);
    const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
    requireProof(before.isFile() && isDeepStrictEqual(stamp(before), stamp(after)), "acceptance source changed while reading");
    const entry = { path: file, sha256: hash(bytes), base64: bytes.toString("base64"), identity: stamp(after) };
    requireProof(!captured.has(file) || isDeepStrictEqual(captured.get(file), entry), `acceptance source changed: ${file}`);
    captured.set(file, entry);
    return bytes;
  }
  const json = async (file) => {
    const text = (await capture(file)).toString("utf8");
    requireProof(parseDocument(text, { uniqueKeys: true }).errors.length === 0, "ambiguous acceptance JSON");
    return JSON.parse(text);
  };
  requireProof(nonempty(options.snapshot), "canonical snapshot required");
  const snapshotPath = options.snapshot, snapshot = await json(snapshotPath), snapshotDigest = captured.get(snapshotPath).sha256;
  requireProof(snapshotPath === path.join(tmpRoot, "residual-evidence", repoSlugFor(repo), `pr-${pr}`, headSha, "snapshots", `${snapshotDigest}.json`), "foreign snapshot path or digest");
  const reauthenticate = async () => {
    requireProof(isDeepStrictEqual(snapshot, await verifyResidualEvidenceSnapshot(options, { ...deps, repoRoot })), "snapshot provenance or bytes changed");
    for (const source of snapshot.sources) {
      requireProof(hash(Buffer.from(source.base64, "base64")) === source.sha256 && hash(await capture(source.path)) === source.sha256, "snapshot source bytes changed");
    }
    for (const source of captured.values()) await capture(source.path);
  };
  await reauthenticate();
  const canonical = path.resolve(repoRoot, options.fixerPlan), fixer = await json(canonical), dir = path.dirname(canonical);
  async function authenticate(plan) {
    await json(pullReceiptPath(tmpRoot, plan.workOrderRef));
    const order = await authenticateOriginalPlan({ plan, canonical, receiptTmpRoot: tmpRoot, requireReceipt: true, read: capture });
    const report = path.join(dir, plan.executionIdentity, "fixer-disposition.json");
    requireProof(plan.promptPath === path.join(dir, "work-orders", `${plan.executionIdentity}.md`)
      && isDeepStrictEqual(order.outputRefs, [report]), "foreign fixer output ownership");
    requireProof(isDeepStrictEqual(await json(executionIndexPath(tmpRoot, plan.executionIdentity)), {
      executionIdentity: plan.executionIdentity, workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest,
    }), "foreign fixer execution index");
    for (const read of order.requiredReads) requireProof(hash(await capture(read.path)) === read.sha256, "changed fixer required read");
    await json(report);
    const bytes = await capture(report);
    const pulled = await verifyPulledResult({ resultPath: report, receiptTmpRoot: tmpRoot, role: "fixer", ...plan });
    requireProof(pulled.ok, `fixer report delivery failed: ${pulled.reason}`);
    if (order.phase === "full") requireProof((await capture(`${report}.constructed`)).toString("utf8") === sha256Hex(bytes), "foreign constructed report");
    return report;
  }
  const report = await authenticate(fixer);
  const completionRead = fixer.workOrder.requiredReads.find((r) => r.kind === "completion-input");
  if (completionRead) {
    const completion = await json(completionRead.path), origin = completion.origin;
    requireProof(origin && origin.executionIdentity !== fixer.executionIdentity, "missing distinct continuation origin");
    const original = await json(path.join(dir, origin.executionIdentity, "original-fixer-emit-plan.json"));
    requireProof(original.workOrder.phase === "commit_only" && ["executionIdentity", "workOrderRef", "workOrderDigest"].every((k) => original[k] === origin[k]), "foreign continuation origin");
    await authenticate(original);
    if (completion.legacyRevalidation) {
      const legacy = completion.legacyRevalidation.originalFull;
      const prior = await json(path.join(dir, legacy.executionIdentity, "original-fixer-emit-plan.json"));
      requireProof(["executionIdentity", "workOrderRef", "workOrderDigest"].every((k) => prior[k] === legacy[k]), "foreign legacy continuation binding");
      await authenticate(prior);
    }
  }
  const delivery = await runtime.runChild(process.execPath, [path.join(import.meta.dirname, "verify-fixer-disposition.mjs"),
    "--repo", repo, "--pr", String(pr), "--head-sha", headSha, "--fixer-plan", canonical, "--check", "--tmp-root", tmpRoot], runtime.env);
  const delivered = delivery.code === 0 && JSON.parse(delivery.stdout);
  requireProof(delivered.ok === true && delivered.complete === true, "full delivery check failed");
  await reauthenticate();
  const { config } = await loadDevLoopConfigStrict({ repoRoot });
  const plan = await json(buildGateEmitPlanPath(key)), context = await json(buildGateContextPath(key));
  const angles = plan.units.flatMap((u) => u.angles), { mandatoryAngles } = resolveGateAngleContract(config, "draft");
  const results = [];
  // Sequential: the captured Map order, hence the proof source order, must not follow I/O completion order.
  for (const a of angles) results.push(await json(path.join(buildGateReviewsDir(key), `${sanitizeScopeSegment(a)}.json`)));
  requireProof(checkResolvedAngleEvidence([...mandatoryAngles, ...context.resolvedAngles], { recordedAngles: results }).missingAngles.length === 0, "incomplete fresh full gate angles");
  const perAngle = plan.units.flatMap((u) => u.angles.map((angle) => ({ angle, dispatchId: u.executionIdentity, ...(u.group ? { group: u.group } : {}) })));
  const dispatchUnits = await readContextDispatchUnits(key, config, repoRoot);
  const provenance = { distinctReviewers: plan.units.length, perAngle, ...(dispatchUnits ? { dispatchUnits } : {}) };
  requireProof(fanoutReviewerPairingError(perAngle, resolveFanoutGroups(config, "draft", angles), dispatchUnits) === null, "invalid independent reviewer pairing");
  const consolidated = consolidateFanin({ angleResults: results, blockCleanOnFindingSeverities: resolveGateConfig(config, "draft").blockCleanOnFindingSeverities });
  requireProof(consolidated.malformed.length === 0, "malformed full gate results");
  const expected = projectFindings(consolidated, headSha), ledgerPath = buildLogPath({ ...key, tmpRoot }), ledger = await json(ledgerPath);
  requireProof(Object.keys(ledger).every((k) => "repo pr headSha gate executionMode provenance findings overallVerdict verdict loggedAt verifiedItems scopeDrift specAuthority".split(" ").includes(k)), "unknown gate ledger field");
  requireProof(ledger.repo === repo && ledger.pr === pr && ledger.headSha === headSha && ledger.gate === "draft_gate"
    && ledger.executionMode === "fanout_fanin" && isDeepStrictEqual(ledger.provenance, provenance), "foreign full gate ledger provenance");
  const additive = new Set("judgeDisposition judgeRationale judgeTitle judgeDetail judgeFix judgeReason judgeCriterion fingerprint followUpIssueNumber followUpDraft remedyKind operatorVisible resolvedIn".split(" "));
  validateJudgeVerdict({ headSha, scopeDrift: ledger.scopeDrift === undefined ? { verdict: "within_scope", rationale: "acceptance", driftedAreas: [] } : ledger.scopeDrift,
    dispositions: ledger.findings.map((finding, index) => ({ index, disposition: finding.judgeDisposition, rationale: finding.judgeRationale, title: finding.judgeTitle, detail: finding.judgeDetail, fix: finding.judgeFix, reason: finding.judgeReason, followUpDraft: finding.followUpDraft })) });
  const remaining = [...expected], clusters = new Map();
  for (const finding of ledger.findings) {
    const source = Object.fromEntries(Object.entries(finding).filter(([k]) => !additive.has(k)));
    // The durable writer omits clusterId; every member still must match exactly once.
    const index = remaining.findIndex(({ clusterId, ...f }) => isDeepStrictEqual(f,
      Object.fromEntries(Object.entries(source).filter(([k]) => k !== "clusterId"))) && (source.clusterId === undefined || source.clusterId === clusterId));
    requireProof(index >= 0, "invented, changed or duplicate gate finding");
    clusters.set(remaining[index].clusterId, [...(clusters.get(remaining[index].clusterId) ?? []), finding]);
    remaining.splice(index, 1);
    requireProof(finding.followUpDraft == null || typeof finding.followUpDraft === "object" && !Array.isArray(finding.followUpDraft)
      && nonempty(finding.followUpDraft.title) && typeof finding.followUpDraft.body === "string", "invalid followUpDraft");
    requireProof(finding.remedyKind === undefined || finding.remedyKind === "evidence_only", "unknown remedy kind");
    requireProof(finding.judgeCriterion === undefined || nonempty(finding.judgeCriterion), "invalid judge criterion");
    requireProof(finding.fingerprint === undefined || /^[a-f0-9]{16}$/.test(finding.fingerprint), "invalid finding fingerprint");
    requireProof(finding.followUpIssueNumber === undefined || Number.isSafeInteger(finding.followUpIssueNumber) && finding.followUpIssueNumber > 0, "invalid deferral target");
    requireProof(finding.operatorVisible === undefined || typeof finding.operatorVisible === "boolean" && finding.severity === "low", "invalid operator visibility");
    requireProof(finding.resolvedIn === undefined || /^[a-f0-9]{7,64}$/i.test(finding.resolvedIn), "invalid resolution metadata");
  }
  for (const members of clusters.values()) { // GATE-EXEC-THREAD-DISPOSITION, as write-gate-findings-log enforces
    requireProof(!members.some((f) => f.judgeDisposition === "defer") || neverDeferredSeverity(members) === null, "judge defer reaches a never-deferred cluster");
  }
  requireProof(remaining.length === 0 && listOpenActItems(ledger.findings).length === 0, "missing findings or open act item");
  const verdict = composeReviewVerdict(consolidated.verdict, ledger.findings);
  requireProof(ledger.overallVerdict === consolidated.verdict && ledger.verdict === verdict, "gate severity verdict mismatch");
  const api = async (args) => {
    const result = await runtime.runChild(runtime.ghCommand, args, runtime.env);
    requireProof(result.code === 0, "live acceptance read failed");
    return JSON.parse(result.stdout);
  };
  const comments = await api(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--slurp"]);
  const reviews = normalizePrReviewsPayload(await api(prReviewsApiArgs(repo, pr)));
  const marker = summarizeGateReviewCommentMarkers([...comments.flat(), ...reviews], { headSha }).draft_gate;
  const lastResult = Math.max(...results.map((_, i) => captured.get(path.join(buildGateReviewsDir(key), `${sanitizeScopeSegment(angles[i])}.json`)).identity[3]));
  requireProof(marker?.headSha === headSha && !marker.converged && marker.contractComplete && marker.executionMode === "fanout_fanin"
    // GitHub publication timestamps have second precision; round ownership is authenticated above.
    && marker.verdict === verdict && marker.updatedAtMs >= Math.floor(lastResult / 1000) * 1000 && marker.updatedAtMs >= Math.floor(captured.get(report).identity[3] / 1000) * 1000
    && Number(plan.roundId.match(/^r(\d+)-/)[1]) >= captured.get(report).identity[3]
    && Date.parse(ledger.loggedAt) >= lastResult, "visible full gate verdict or temporal order mismatch");
  const live = await api(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,statusCheckRollup"]);
  requireProof(live.headRefOid === headSha, "live candidate moved");
  const ci = await observeHeadCiSignals({ repo, headSha, prVisibleCheckNames: live.statusCheckRollup?.map((c) => c.name || c.context) }, runtime);
  requireProof(ci.checkRuns.ok && ci.statuses.ok && normalizeHeadScopedCiContract({ checkRunsStatus: ci.checkRuns.visibleSignal.status,
    commitStatus: ci.statuses.commitStatus, checkRunsUnsupportedCompleted: ci.checkRuns.visibleSignal.unsupportedCompleted }).overallStatus === "success", "current-head CI is not settled green");
  await reauthenticate();
  return { schemaVersion: 1, kind: "residual-evidence-acceptance", status: "accepted", repo, pr, headSha,
    snapshotPath, snapshotDigest, proof: { delivery: JSON.parse(delivery.stdout), provenance, verdict, marker, ci },
    sources: [...captured.values()], limitations: [...snapshot.assessment.limitations,
      "Unpinned optional context is navigation only; acceptance grants no thread closure authority."] };
}

export async function acceptResidualEvidence(options, deps = {}) {
  requireProof(!options.record, "incompatible modes");
  const proof = await verifyResidualEvidenceAcceptance(options, deps), text = `${JSON.stringify(proof, null, 2)}\n`;
  const reconciliationPath = path.join(path.dirname(path.dirname(options.snapshot)), "accepted", `${hash(text)}.json`);
  await publishRecord(reconciliationPath, text, async () => requireProof(isDeepStrictEqual(proof,
    await verifyResidualEvidenceAcceptance(options, deps)), "acceptance proof changed before publication"));
  return { ok: true, status: "accepted", recorded: true, applied: false, repo: proof.repo, pr: proof.pr, headSha: proof.headSha,
    snapshotPath: options.snapshot, reconciliationPath };
}

if (isDirectCliRun(import.meta.url)) {
  try {
    const options = parseResidualEvidenceArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else process.exitCode = emitResult(await (options.accept ? acceptResidualEvidence(options) : snapshotResidualEvidence(options)), options);
  } catch (error) { console.error(formatCliError(error)); process.exitCode = 1; }
}
