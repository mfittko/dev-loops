#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { loadKnownRuleIds } from "../lib/known-rule-ids.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { fingerprintFinding } from "./_gate-finding-surface.mjs";
import { selectActThreadBinding } from "./_fixer-act-thread-bindings.mjs";
import { resolveAuthenticatedLogin } from "./post-gate-findings.mjs";
import { assertTmpRootOutsideLinkedWorktree, resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { captureParsedReviewThreads, findDeltaBlockedFixedReply, replyAndMaybeResolve, resolveThread } from "./_review-thread-mutations.mjs";
import { planBatchReplyTargets } from "./reply-resolve-review-threads.mjs";
import { buildContainmentMap, isCommitContainedByHead } from "./_commit-containment.mjs";
import { EXECUTION_IDENTITY_RE, verifyPulledResult, workOrderDigest } from "./_work-order-protocol.mjs";
import {
  evaluateFixerDisposition,
  FIXER_DISPOSITION_FAILED_STEP,
  FIXER_DISPOSITION_KIND,
  normalizeFixerDispositionHandoff,
  siteCoverageGaps,
} from "@dev-loops/core/loop/fixer-disposition";
import { deltaCoverageBinding, isDeltaResultFresh, startDeltaSequence, toDeltaActItems, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { DELTA_CLEARING_NEXT_STEPS, listGateDeltaRecords, readGateDeltaRecord } from "../loop/_gate-delta-record.mjs";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { LOOP_DERIVED_CI_CHECK_NAMES } from "@dev-loops/core/loop/copilot-ci-status";
import { assertFixerReviewBaseline } from "@dev-loops/core/loop/work-order-digest";
import { realpathNearestExisting } from "@dev-loops/core/loop/worktree-guard";
import { revalidateLegacyCompletion } from "./_legacy-fixer-revalidation.mjs";
import { authenticateOriginalPlan } from "./_fixer-emission-evidence.mjs";
import { repoSlugFor } from "./_gate-artifact-paths.mjs";
import { observeHeadCiSignals } from "./observe-head-ci.mjs";
import { normalizeHeadScopedCiContract } from "@dev-loops/core/loop/copilot-ci-status";

// Provenance mark: the sha256 of the report bytes --construct wrote, kept beside the report.
const RESIDUAL_REPLY_MARKER = "Residual delta status:";
const constructMarkPath = (handoffPath) => `${handoffPath}.constructed`;

const USAGE = `Usage: verify-fixer-disposition.mjs --repo <owner/name> --pr <number> --head-sha <sha> --fixer-plan <path> [--tmp-root <path>]
Enforce GATE-EXEC-FIXER-DISPOSITION-BOUNDARY: verify every review thread a fixer
claims to have tackled since its last push is fully disposed (commit contained
by the observed PR head, replied with that commit's evidence, resolved, and
re-verified live) before the loop may request/dispatch/post another review or
gate round.
An act-list work order also fails (exit 1) when a judge-act fingerprint marks an open gate
thread (root comment authored by the gate login) and the handoff has no disposition entry for
it; the error names the thread id and no checkpoint is written.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
  --head-sha <sha>      FULL observed PR head commit SHA (40 or 64 hex chars); must
                        equal the live PR headRefOid
  --fixer-plan <path>   The fixer-emit-plan.json the full-phase fixer was dispatched
                        from (emit-fixer-work-order.mjs, ADR 0106). The disposition
                        handoff { headSha, dispositions } is read from the plan's
                        outputRef. Each dispositions entry is { threadId,
                        fixingCommitSha, disposition: "tackled"|"deferred",
                        fingerprint?, validation? }; threadId, fixingCommitSha
                        and disposition are required on every entry.
                        The handoff counts only with a matching fixer pull receipt,
                        when written at or after that pull. Its candidate head X
                        may precede live --head-sha H only after containment and
                        per-commit historical thread-site checks; uncertainty
                        names the thread for pre_approval_gate --known-findings.
Optional:
  --construct                 Construct the full worker's canonical report (ACT: from
                               authenticated completion input; THREAD: from the threads
                               source, the clearing delta record and the pushed head);
                               no checkpoint or GitHub mutation. Not --check. Normal
                               and --check modes accept only a report this wrote, and
                               refuse when the plan has a source and the head's checks are not
                               settled green: ci_failed (red), ci_pending (pending),
                               ci_unknown (unreadable or unsupported). The guard judges only
                               check runs listed in the PR statusCheckRollup, the set
                               wait-pr-checks uses. A settled head with no checks at all
                               passes. Hand back the code and resolve no thread. Normal mode
                               also posts one residual-status reply on each deferred thread
                               whose delta status is not_resolved or cannot_verify and leaves
                               it open. A residual reply that
                               failed to post, or is not live under --check, returns
                               ok:false (residual_reply_failed, complete:false).
  --check                     Read-only delivery and live-state check; never
                               write a checkpoint or reply/resolve a thread.
  --tmp-root <path>            Root tmp directory for the checkpoint and the pull
                               receipts (default: the main git worktree's tmp/, so
                               a prune of a linked worktree never takes the
                               checkpoint with it). A path inside a linked
                               worktree is refused (exit 1).
Idempotent: re-entry re-verifies the receipt against the plan, rewrites the
checkpoint for --head-sha and re-verifies live GitHub state; a thread already
replied with its commit's evidence is never replied to twice, and a thread
already resolved live is left alone.
In --check mode checkpointPath is null and all evidence remains unchanged.
Output for normal verification or --check (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": 17, "headSha": "...", "checkpointPath": "...",
    "complete": true|false, "incomplete": [{ threadId, expectedCommit, failedStep, deltaStatus?, deltaRecord? }],
    "forbiddenActions": [...], "nextAction": "..."|null, "reason": "..."|null,
    "actions": [{ threadId, ok, step? , error? }] }
Output for --construct (stdout, JSON):
  { "ok": true, "constructed": true, "outputRef": "..." }
  complete and checkpointPath are absent; normal verification remains mandatory.
Error output (stderr, JSON):
  { "ok": false, "error": "...", "hint"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh/runtime failure
  2  Invalid --jq filter`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseVerifyFixerDispositionCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      check: { type: "boolean" },
      construct: { type: "boolean" },
      repo: { type: "string" },
      pr: { type: "string" },
      "head-sha": { type: "string" },
      "fixer-plan": { type: "string" },
      "tmp-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    check: false,
    construct: false,
    repo: undefined,
    pr: undefined,
    headSha: undefined,
    fixerPlan: undefined,
    tmpRoot: undefined,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "check" || token.name === "construct") {
      options[token.name] = true;
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "head-sha") {
      const sha = normalizeFullHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError(FULL_HEAD_SHA_ERROR);
      options.headSha = sha;
      continue;
    }
    if (token.name === "fixer-plan") {
      const fixerPlan = requireTokenValue(token, parseError).trim();
      if (fixerPlan.length === 0) {
        throw parseError("--fixer-plan requires a non-empty path");
      }
      options.fixerPlan = fixerPlan;
      continue;
    }
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "headSha", "fixerPlan"].filter((k) => options[k] === undefined);
  if (options.check && options.construct) throw parseError("--construct and --check are mutually exclusive");
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// ADR 0106 delivery evidence: the handoff counts only for the intended full-phase
// fixer invocation, with a matching pull receipt, written at or after that pull,
// and naming the observed head. Throws a clear error otherwise; nothing is written.
async function loadDeliveredHandoff(options, { repoRoot, receiptTmpRoot, runtime }) {
  const planPath = path.resolve(repoRoot, options.fixerPlan);
  let plan;
  let planBytes;
  try {
    planBytes = await readFile(planPath);
    plan = JSON.parse(planBytes);
  } catch (error) {
    throw new Error(`Cannot read --fixer-plan "${options.fixerPlan}": ${error instanceof Error ? error.message : String(error)}`);
  }
  // Bind the plan to its digest before trusting any field of it.
  if (!plan?.workOrder || workOrderDigest(plan.workOrder) !== plan.workOrderDigest) {
    throw new Error(`--fixer-plan "${options.fixerPlan}" does not match its workOrderDigest; the plan was edited after emission, re-emit it`);
  }
  const order = plan.workOrder;
  if (order?.role !== "fixer" || order.phase !== "full" || order.target?.repo !== options.repo || order.target?.pr !== options.pr) {
    throw new Error(`--fixer-plan "${options.fixerPlan}" is not a full-phase fixer work order for ${options.repo}#${options.pr}`);
  }
  const complete = order.operation === "complete";
  if (complete) {
    const reads = Array.isArray(order.requiredReads) ? order.requiredReads : [];
    const ofKind = (kind) => reads.filter((read) => read?.kind === kind);
    const required = (kind) => ofKind(kind).length === 1 && ofKind(kind)[0].required === true;
    const digest = (key) => /^[a-f0-9]{64}$/.test(order.authority?.[key] ?? "");
    if (!Array.isArray(order.mutationAuthority?.allowedPaths) || order.mutationAuthority.allowedPaths.length
      || typeof order.mutationAuthority.branch !== "string" || !order.mutationAuthority.branch.trim()
      || !Array.isArray(order.outputRefs) || order.outputRefs.length !== 1
      || typeof order.executionRules?.contract !== "string" || typeof order.executionRules.validation !== "string") throw new Error("complete requires empty source selectors, branch, single output and execution rules");
    if (!["act-list", "threads"].includes(order.source) || !required(order.source)
      || ofKind(order.source === "act-list" ? "threads" : "act-list").length || !digest("sourceDigest")) throw new Error("complete requires exactly one authenticated ACT or THREAD source");
    if (order.source === "act-list") {
      if (!required("delta-result") || !digest("deltaResultDigest") || !required("completion-input")
        || !digest("completionInputDigest") || !digest("completionInputBytesDigest")) throw new Error("complete ACT requires required Delta/completion input and semantic/byte authorities");
    } else if (ofKind("completion-input").length || ["completionInputDigest", "completionInputBytesDigest", "reviewBaselineHead"].some((key) => Object.hasOwn(order.authority ?? {}, key))) throw new Error("complete THREAD refuses ACT/completion-input authority");
  }
  // outputRefs is local material outside the digest, so an edited plan field is never trusted: the
  // handoff path is derived from the plan location and execution, exactly as the emitter builds it.
  const handoffPath = path.join(path.dirname(planPath), plan.executionIdentity, "fixer-disposition.json");
  const receipt = await verifyPulledResult({
    resultPath: handoffPath, receiptTmpRoot, role: "fixer", workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity,
  });
  // A result_* failure still carries the verified receipt; it throws below, after the plan binding checks.
  if (!receipt.ok && !receipt.receipt) throw new Error(`fixer pull receipt for ${plan.workOrderRef} failed verification: ${receipt.reason}; dispatch a fresh fixer execution`);
  // The plan location is caller-supplied: bind it to the plan the pull read, so a copied plan never names its own handoff.
  const receiptPlanPath = receipt.receipt?.subject?.planPath;
  const real = (p) => realpath(p).catch(() => path.resolve(p));
  if (typeof receiptPlanPath !== "string" || await real(planPath) !== await real(receiptPlanPath)) {
    throw new Error(`--fixer-plan "${options.fixerPlan}" is not the plan the fixer pull read (${receiptPlanPath}); pass the emitted plan`);
  }
  const outputRef = String(order.outputRefs?.[0] ?? "");
  const sameDir = async (a, b) => (await realpath(a).catch(() => a)) === (await realpath(b).catch(() => b));
  if (path.relative(path.dirname(path.dirname(outputRef)), outputRef) !== path.relative(path.dirname(planPath), handoffPath)
    || !(await sameDir(path.dirname(path.dirname(outputRef)), path.dirname(planPath)))) {
    throw new Error(`--fixer-plan "${options.fixerPlan}" outputRef ${order.outputRefs?.[0]} is not the emitted handoff path ${handoffPath}; the plan was edited after emission, re-emit it`);
  }
  // Optional subject evidence never strengthens ordinary legacy delivery admission.
  const bindActiveFixer = async (outputMissing) => {
    try {
      const canonical = path.join(await realpath(receiptTmpRoot), "gate-fixer", repoSlugFor(options.repo), `pr-${options.pr}`, "fixer-emit-plan.json");
      if (await realpath(planPath) !== canonical) return;
      const subject = receipt.receipt.subject;
      if (normalizeFullHeadSha(order.headSha) !== order.headSha || typeof order.mutationAuthority?.branch !== "string" || !order.mutationAuthority.branch.trim()) return;
      if (subject.repo !== options.repo || subject.pr !== options.pr || subject.headSha !== order.headSha
        || subject.branch !== order.mutationAuthority?.branch || subject.phase !== "full"
        || receipt.receipt.materializationHash !== plan.materializationHash) return;
      await authenticateOriginalPlan({ plan, canonical, receiptTmpRoot: await realpath(receiptTmpRoot), requireReceipt: true });
      const executionDir = path.join(path.dirname(canonical), plan.executionIdentity);
      const directory = await lstat(executionDir).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (directory ? !directory.isDirectory() || await realpath(executionDir) !== executionDir : !outputMissing) return;
      const info = await lstat(handoffPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (outputMissing ? info !== null : !info?.isFile() || info.isSymbolicLink()) return;
      if (!(await readFile(planPath)).equals(planBytes)) return;
      return { workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity,
        planPath, subject: receipt.receipt.subject, outputMissing };
    } catch { return; }
  };
  if (receipt.reason === "result_missing" && !options.construct) {
    const error = new Error(`result_missing: no fixer disposition handoff at the work order's outputRef ${handoffPath}; a receipt alone is never completion`);
    const activeFixer = await bindActiveFixer(true);
    if (activeFixer) Object.assign(error, { code: "FIXER_RESULT_MISSING", activeFixer });
    throw error;
  }
  // verifyPulledResult compares the handoff mtime to the receipt file mtime: one filesystem clock.
  if (receipt.reason === "result_predates_pull") {
    throw new Error(`result_predates_pull: the disposition handoff ${handoffPath} was written before the pull at ${receipt.receipt.pulledAt}; a stale or replayed disposition never advances`);
  }
  const bytesByRead = new Map();
  if (Object.hasOwn(order.authority ?? {}, "reviewBaselineHead")) {
    for (const read of order.requiredReads ?? []) {
      if (["act-list", "delta-result"].includes(read?.kind)) bytesByRead.set(read, await readFile(read.path));
    }
  }
  const baselineAuthority = assertFixerReviewBaseline(order, bytesByRead);
  const completionReads = (order.requiredReads ?? []).filter((read) => read?.kind === "completion-input");
  const optionalCompletion = complete && order.source === "act-list" || completionReads.length > 0 || Object.hasOwn(order.authority ?? {}, "completionInputDigest")
    || Object.hasOwn(order.authority ?? {}, "completionInputBytesDigest");
  let completion = null;
  if (optionalCompletion || options.construct) {
    const executionDir = path.join(await realpath(path.dirname(planPath)), plan.executionIdentity);
    const symlinks = await Promise.all([path.dirname(handoffPath), handoffPath].map(async (file) => {
      const info = await lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      return info && (info.isSymbolicLink() || file === path.dirname(handoffPath) && !info.isDirectory());
    }));
    if (symlinks.some(Boolean) || path.normalize(realpathNearestExisting(path.dirname(handoffPath))) !== executionDir
      || path.normalize(realpathNearestExisting(handoffPath)) !== path.join(executionDir, "fixer-disposition.json")) {
      throw new Error("completion output or execution directory redirects outside its canonical execution path");
    }
  }
  if (optionalCompletion) {
    const read = completionReads[0];
    if (completionReads.length !== 1 || read.required !== true || typeof read.path !== "string"
      || !/^[a-f0-9]{64}$/.test(read.sha256 ?? "") || !/^[a-f0-9]{64}$/.test(order.authority?.completionInputDigest ?? "")
      || !/^[a-f0-9]{64}$/.test(order.authority?.completionInputBytesDigest ?? "")) {
      throw new Error("completion input requires one required read and both semantic/byte authorities");
    }
    const bytes = await readFile(read.path);
    const byteDigest = createHash("sha256").update(bytes).digest("hex");
    completion = JSON.parse(bytes.toString("utf8"));
    if (byteDigest !== read.sha256 || byteDigest !== order.authority.completionInputBytesDigest
      || sha256Hex(completion).slice(7) !== order.authority.completionInputDigest) {
      throw new Error("completion input differs from its semantic or exact-byte authority");
    }
    if (!completion || !normalizeFullHeadSha(completion.headSha)
      || normalizeFullHeadSha(completion.fixingCommitSha) !== completion.fixingCommitSha
      || !Array.isArray(completion.siteCoverage) || !Array.isArray(completion.threadBindings)) {
      throw new Error("completion input requires the actual full candidate/fixing heads, coverage and thread bindings");
    }
    const decision = readGateDeltaRecord(receiptTmpRoot, baselineAuthority?.reviewBaselineHead ?? order.headSha);
    if (decision && decision.candidateHead !== completion.headSha) throw new Error("completion input requires the actual full candidate/fixing heads from its clearing decision");
    const subject = receipt.receipt.subject;
    if (!/^f\d+-[a-f0-9]{8}$/.test(plan.executionIdentity) || plan.workOrderRef !== `fixer:${options.repo}#${options.pr}:${order.headSha}:${plan.executionIdentity}`
      || subject.repo !== options.repo || subject.pr !== options.pr || subject.headSha !== order.headSha
      || subject.branch !== order.mutationAuthority?.branch || subject.phase !== "full") {
      throw new Error("completion current pull subject does not match its full fixer authority");
    }
  }
  if (options.construct && !completion && order.source !== "threads") throw new Error("--construct requires authenticated ACT completion input or a THREAD plan");
  const observedHead = options.headSha;
  let threadDelta;
  if (order.source === "threads") {
    const read = order.requiredReads.find((read) => read.kind === "delta-result");
    if (read) {
      const bytes = await readFile(read.path).catch(() => { throw new Error("THREAD needs a clearing delta record matching its authenticated emission"); });
      threadDelta = JSON.parse(bytes);
      if (createHash("sha256").update(bytes).digest("hex") !== read.sha256
        || sha256Hex(threadDelta).slice(7) !== order.authority.deltaResultDigest) throw new Error("THREAD needs a clearing delta record matching its authenticated emission");
    }
  }
  const constructionHead = completion?.headSha ?? (order.source === "threads" && !complete
    ? threadDelta?.candidateHead ?? observedHead : observedHead);
  let raw = options.construct ? { headSha: constructionHead, dispositions: [], ...(completion ? { siteCoverage: completion.siteCoverage } : {}) } : null;
  try {
    if (!options.construct) {
      const text = await readFile(handoffPath, "utf8");
      raw = JSON.parse(text);
      // Emitted plans carry a source: only the report this verifier's own --construct wrote counts.
      if (order.source && await readFile(constructMarkPath(handoffPath), "utf8").catch(() => null) !== sha256Hex(text)) {
        throw Object.assign(new Error(`Fixer disposition handoff ${handoffPath} was not written by this verifier's --construct; never hand-write it; rm only this execution's refused report ${handoffPath} and its corresponding stale marker ${constructMarkPath(handoffPath)}, then run the verifier with --construct. Preserve accepted construction evidence and unrelated files`), { handWritten: true });
      }
    }
  } catch (error) {
    if (error.handWritten) throw error;
    throw new Error(`Fixer disposition handoff ${handoffPath} is not valid JSON`);
  }
  if (raw?.headSha !== observedHead && (!order.source || !normalizeFullHeadSha(raw?.headSha))) {
    throw new Error(`Fixer disposition handoff claims head ${raw?.headSha}, not the observed head ${options.headSha}; refresh the PR state before verifying`);
  }
  // Keep every existing report/Delta authority at X; only live observation and delivery run at H.
  options = { ...options, headSha: raw.headSha };
  if (completion && completion.headSha !== options.headSha) throw new Error("completion input candidate differs from the constructed report");
  if (order.headSha !== options.headSha) {
    const contained = await isCommitContainedByHead({ repo: options.repo, commitSha: order.headSha, headSha: options.headSha }, runtime);
    if (!contained.contained) throw new Error(`the work order head ${order.headSha} is not contained by the observed head ${options.headSha}: ${contained.reason}`);
  }
  const threadsRead = (order.requiredReads ?? []).find((read) => read?.kind === "threads");
  let source;
  if (threadsRead) {
    const bytes = await readFile(threadsRead.path);
    if (createHash("sha256").update(bytes).digest("hex") !== String(threadsRead.sha256 ?? "").replace(/^sha256:/, "")) {
      throw new Error(`the work order's threads ${threadsRead.path} differ from the sha256 the work order binds`);
    }
    source = JSON.parse(bytes.toString("utf8"));
    if (sha256Hex(source).slice(7) !== order.authority?.sourceDigest) {
      throw new Error(`the work order's threads ${threadsRead.path} differ from the canonical authority.sourceDigest the work order binds`);
    }
    if (!Array.isArray(source?.threads) || source.threads.some((thread) => typeof thread?.threadId !== "string" || !thread.threadId)) {
      throw new Error(`the work order's threads ${threadsRead.path} have invalid thread IDs`);
    }
  }
  if (!completion && order.source === "threads" && (options.construct || options.headSha !== observedHead)) {
    // THREAD route: the clearing delta record bound to the pushed head decides each thread. An ordinary order's head is
    // the review baseline; a complete order's head is the pushed candidate, so its record is found by candidateHead.
    // A record decides only when it clears the pushed head and its items cover the pinned thread IDs: an ACT-route or
    // other-sequence record for the same candidate must not. A complete THREAD order carries no sequence identity, so a
    // record binds by the pinned thread IDs plus the pushed head. Zero or several matches refuse; only the matches are
    // sorted (the directory read is not).
    const pinned = source.threads.map(({ threadId }) => threadId);
    const clears = (candidate) => candidate && DELTA_CLEARING_NEXT_STEPS.includes(candidate.nextStep) && candidate.candidateHead === options.headSha
      && pinned.every((id) => (candidate.items ?? []).some((item) => item?.ref === id));
    const candidates = [readGateDeltaRecord(receiptTmpRoot, order.headSha), ...(complete ? listGateDeltaRecords(receiptTmpRoot) : [])].filter(Boolean);
    const matches = [...new Map(candidates.filter(clears).map((candidate) => [candidate.reviewBaselineHead, candidate])).values()]
      .sort((x, y) => x.reviewBaselineHead.localeCompare(y.reviewBaselineHead));
    if (matches.length > 1) {
      throw new Error(`--construct found several clearing delta records (baselines ${matches.map((m) => m.reviewBaselineHead).join(", ")}) covering the pinned threads for the pushed head ${options.headSha}; refusing an ambiguous record`);
    }
    const [record] = matches;
    if (!record) {
      throw new Error(`--construct needs a clearing delta record ${complete ? "" : `for baseline ${order.headSha} `}whose candidateHead is the pushed head ${options.headSha} and whose items cover the pinned threads; push the reviewed candidate first`);
    }
    const resolved = new Set((record.items ?? []).filter((item) => item?.status === "resolved").map((item) => item.ref));
    const dispositions = source.threads.map(({ threadId }) => ({ threadId, fixingCommitSha: options.headSha, disposition: resolved.has(threadId) ? "tackled" : "deferred" }));
    if (options.construct) raw.dispositions = dispositions;
    else if (raw.dispositions.length !== dispositions.length || dispositions.some((expected) => !raw.dispositions.some((entry) => entry.threadId === expected.threadId
      && entry.fixingCommitSha === expected.fixingCommitSha && entry.disposition === expected.disposition))) throw new Error("THREAD report differs from the clearing candidate dispositions");
  }
  let handoff = normalizeFixerDispositionHandoff(raw, { ruleIds: loadKnownRuleIds() });
  if (threadsRead) {
    const disposed = new Set(handoff.dispositions.map((entry) => entry.threadId));
    const missing = source.threads.filter((thread) => !disposed.has(thread.threadId));
    if (missing.length) throw new Error(`the handoff has no disposition entry for source thread(s) ${missing.map((thread) => thread.threadId).join(", ")}`);
    if (complete) {
      const pinned = new Set(source.threads.map((thread) => thread.threadId));
      const extra = [...disposed].filter((id) => !pinned.has(id));
      if (extra.length) throw new Error(`complete handoff includes non-source thread(s) ${extra.join(", ")}`);
    }
  }
  // GATE-EXEC-REMEDIATION-SITE-QUERY: an act-list work order's items with a siteQuery need a coverage record.
  const actRead = (order.requiredReads ?? []).find((read) => read?.kind === "act-list");
  let actList = null;
  let deltaStatuses = null;
  if (actRead) {
    try {
      const actBytes = bytesByRead.get(actRead) ?? await readFile(actRead.path);
      if (createHash("sha256").update(actBytes).digest("hex") !== String(actRead.sha256 ?? "").replace(/^sha256:/, "")) {
        throw new Error(`the work order's act list ${actRead.path} differs from the sha256 the work order binds; it was rewritten after emission`);
      }
      actList = baselineAuthority ? baselineAuthority.actList : JSON.parse(actBytes.toString("utf8"));
    } catch (error) {
      if (/differs from the sha256/.test(error.message)) throw error;
      throw new Error(`Cannot read the work order's act list ${actRead.path}`);
    }
    if (order.authority?.sourceDigest && sha256Hex(actList).slice(7) !== order.authority.sourceDigest) {
      throw new Error("the work order's act list differs from authority.sourceDigest");
    }
    const residualRefs = new Set();
    const deltaRead = (order.requiredReads ?? []).find((read) => read?.kind === "delta-result");
    // Legacy deliveries remain strict without both semantic authorities.
    if (deltaRead && order.authority?.sourceDigest && order.authority?.deltaResultDigest) {
      const bytes = bytesByRead.get(deltaRead) ?? await readFile(deltaRead.path);
      if (createHash("sha256").update(bytes).digest("hex") !== String(deltaRead.sha256 ?? "").replace(/^sha256:/, "")) {
        throw new Error("the work order's delta result differs from its sha256");
      }
      const delta = baselineAuthority ? baselineAuthority.delta : JSON.parse(bytes.toString("utf8"));
      if (sha256Hex(delta).slice(7) !== order.authority.deltaResultDigest) {
        throw new Error("the work order's delta result differs from authority.deltaResultDigest");
      }
      const baseline = baselineAuthority?.reviewBaselineHead ?? (completion ? delta.reviewBaselineHead : order.headSha);
      if (completion && normalizeFullHeadSha(baseline) !== baseline) throw new Error("completion Delta requires its full original reviewed baseline");
      const sequence = startDeltaSequence({ reviewBaselineHead: baseline, actList });
      const errors = validateDeltaResult(delta, { sequence, membershipOnly: true });
      if (errors.length) throw new Error(`Invalid delta result: ${errors.join("; ")}`);
      const decision = readGateDeltaRecord(receiptTmpRoot, baseline);
      const pairs = (items) => (items ?? []).map(({ ref, status }) => JSON.stringify([ref, status])).sort().join("\n");
      if (!decision || !DELTA_CLEARING_NEXT_STEPS.includes(decision.nextStep)
        || decision.reviewBaselineHead !== baseline || decision.actSetId !== sequence.actSetId
        || decision.candidateHead !== options.headSha || !Array.isArray(decision.items)
        || pairs(decision.items) !== pairs(delta.actionableItems)) {
        throw new Error("the delta clearing decision does not match the baseline, act set, item statuses or actual pushed candidate");
      }
      const bounded = decision.outcome === "bounded_out" && decision.nextStep === "push_to_gate" && decision.invocation === 3;
      if (!bounded && !(decision.outcome === "locally_clear" && decision.nextStep === "push"
        && Number.isInteger(decision.invocation) && decision.invocation >= 1 && decision.invocation <= 3
        && delta.outcome === "locally_clear" && isDeltaResultFresh(delta, options.headSha))) {
        throw new Error("the delta decision is neither locally clear nor invocation-three bounded_out");
      }
      const statuses = new Map(delta.actionableItems.map(({ ref, status }) => [ref, status]));
      deltaStatuses = new Map();
      // A shared fingerprint permits tackled/live resolution only when every member is resolved.
      for (const [index, item] of sequence.actItems.entries()) {
        const fingerprint = actList[index]?.fingerprint ?? fingerprintFinding(actList[index]);
        const status = statuses.get(item.ref);
        if (!deltaStatuses.has(fingerprint) || status !== "resolved") deltaStatuses.set(fingerprint, status);
      }
      if (bounded) {
        for (const [ref, status] of statuses) if (status === "not_resolved" || status === "cannot_verify") residualRefs.add(ref);
      }
      if (completion) {
        const digest = sha256Hex(completion.siteCoverage).slice(7);
        const origin = completion.origin;
        if (!origin || typeof origin.executionIdentity !== "string" || !EXECUTION_IDENTITY_RE.test(origin.executionIdentity)
          || !/^f\d+-[a-f0-9]{8}$/.test(origin.executionIdentity) || origin.executionIdentity === plan.executionIdentity
          || !/^sha256:[a-f0-9]{64}$/.test(origin.workOrderDigest ?? "")
          || origin.workOrderRef !== `fixer:${options.repo}#${options.pr}:${baseline}:${origin.executionIdentity}`) {
          throw new Error("completion origin is not a distinct original-baseline fixer execution");
        }
        const originPath = path.join(path.dirname(planPath), origin.executionIdentity, "fixer-disposition.json");
        const prior = await verifyPulledResult({ resultPath: originPath, receiptTmpRoot, role: "fixer",
          workOrderRef: origin.workOrderRef, workOrderDigest: origin.workOrderDigest, executionIdentity: origin.executionIdentity });
        if (!prior.ok) throw new Error(`completion origin pull/result failed verification: ${prior.reason}`);
        const subject = prior.receipt.subject;
        if (subject?.repo !== options.repo || subject.pr !== options.pr || subject.headSha !== baseline
          || subject.branch !== order.mutationAuthority?.branch || subject.phase !== "commit_only"
          || typeof subject.planPath !== "string" || await real(subject.planPath) !== await real(planPath)) {
          throw new Error("completion origin pull subject does not match the original commit_only authority");
        }
        const priorBytes = await readFile(originPath);
        const priorRaw = JSON.parse(priorBytes);
        normalizeFixerDispositionHandoff(priorRaw, { ruleIds: loadKnownRuleIds() });
        if (priorRaw.headSha !== completion.fixingCommitSha || sha256Hex(priorRaw.siteCoverage).slice(7) !== digest) {
          throw new Error("completion fixing commit/coverage differs from the actual prior filled handback");
        }
        if (Object.hasOwn(completion, "legacyRevalidation")) {
          await revalidateLegacyCompletion({ completion, plan, planPath, priorBytes, actList, delta, decision, receiptTmpRoot, repoRoot });
        } else if (delta.siteCoverageDigest !== digest || decision.siteCoverageDigest !== digest) {
          throw new Error("completion coverage differs from the Delta result or clearing decision identity");
        }
        if (deltaCoverageBinding(delta) || deltaCoverageBinding(decision)) {
          const expected = { coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: digest, handbackBytesDigest: sha256Hex(priorBytes).slice(7), origin };
          deltaCoverageBinding(delta, expected);
          deltaCoverageBinding(decision, expected);
        }
        for (const commitSha of new Set([baseline, completion.fixingCommitSha])) {
          const contained = await isCommitContainedByHead({ repo: options.repo, commitSha, headSha: options.headSha }, runtime);
          if (!contained.contained) throw new Error(`completion commit ${commitSha} is not contained by the actual candidate: ${contained.reason}`);
        }
        if (options.construct) {
          raw.dispositions = completion.threadBindings.map(({ threadId, fingerprints }) => ({
            threadId, fixingCommitSha: completion.fixingCommitSha,
            disposition: Array.isArray(fingerprints) && fingerprints.every((fp) => deltaStatuses.get(fp) === "resolved") ? "tackled" : "deferred",
          }));
          handoff = normalizeFixerDispositionHandoff(raw, { ruleIds: loadKnownRuleIds() });
        } else if (sha256Hex(raw.siteCoverage).slice(7) !== digest
          || handoff.dispositions.some((entry) => entry.fixingCommitSha !== completion.fixingCommitSha)) {
          throw new Error("delivered coverage/fixing commits differ from authenticated completion input");
        }
      }
    }
    const dispositionCoverage = handoff.dispositions.filter((entry) => entry.fingerprint && (entry.sites || entry.returnedSites || entry.noSitesReason));
    if (completion && dispositionCoverage.length) throw new Error("disposition-level coverage cannot override authenticated completion input");
    const coverage = [...(handoff.siteCoverage ?? []), ...dispositionCoverage];
    const gaps = siteCoverageGaps(toDeltaActItems(actList), coverage, residualRefs);
    if (gaps.length > 0) throw new Error(`GATE-EXEC-REMEDIATION-SITE-QUERY: the disposition handoff leaves site coverage incomplete: ${gaps.join("; ")}`);
  }
  if (completion && (!actList || !deltaStatuses)) throw new Error("completion requires semantic ACT and Delta authorities");
  return {
    handoff,
    actList,
    deltaStatuses,
    completion,
    constructedReport: raw,
    source: order.source,
    handoffPath,
    bindActiveFixer,
    delivery: { workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity },
  };
}

// Builds the { threadId -> replyBodies[] } / isResolved liveThreads shape
// evaluateFixerDisposition needs from one captureParsedReviewThreads() snapshot.
function buildLiveThreads(parsed) {
  return parsed.threads.map((thread) => ({
    threadId: thread.id,
    isResolved: thread.isResolved,
    replyBodies: parsed.comments.filter((comment) => comment.threadId === thread.id).map((comment) => comment.body),
  }));
}

// A judge-act item whose fingerprint marks an open inline gate thread is resolved by the fix
// cycle: the handoff needs a disposition entry for that thread, never a threadless claim.
// Gate-authored is the authenticated login on the thread ROOT comment, never marker text alone;
// every matching thread needs its own entry.
function assertActItemThreadsDisposed(actList, handoff, parsed, gateLogin, deltaStatuses, completion) {
  const entries = new Map(handoff.dispositions.map((entry) => [entry.threadId, entry]));
  const actFingerprints = new Set(actList.map((item) => item?.fingerprint ?? fingerprintFinding(item)));
  const bindings = new Map();
  for (const binding of completion?.threadBindings ?? []) {
    if (typeof binding?.threadId !== "string" || !binding.threadId || bindings.has(binding.threadId)
      || !Array.isArray(binding.fingerprints) || !binding.fingerprints.length
      || new Set(binding.fingerprints).size !== binding.fingerprints.length
      || binding.fingerprints.some((fp) => !actFingerprints.has(fp))) {
      throw new Error("completion thread bindings require unique root IDs and complete unique ACT members");
    }
    bindings.set(binding.threadId, new Set(binding.fingerprints));
  }
  const matchedBindings = new Set();
  for (const entry of handoff.dispositions) {
    if (!deltaStatuses) continue;
    const { members } = selectActThreadBinding(parsed, entry.threadId, gateLogin, actFingerprints);
    if (!members.length
      || (entry.fingerprint && (!deltaStatuses.has(entry.fingerprint) || !members.includes(entry.fingerprint)))) {
      throw new Error(`delta status and live thread disposition disagree for ${entry.threadId} (${entry.fingerprint})`);
    }
  }
  const missing = [];
  for (const thread of parsed.threads) {
    const { members } = selectActThreadBinding(parsed, thread.id, gateLogin, actFingerprints);
    if (!members.length) continue;
    if (completion) {
      const pinned = bindings.get(thread.id);
      if (!pinned || pinned.size !== members.length || members.some((fp) => !pinned.has(fp))) {
        throw new Error(`completion binding does not match complete live ACT membership for ${thread.id}`);
      }
      matchedBindings.add(thread.id);
    }
    const entry = entries.get(thread.id);
    if (entry?.fingerprint && !members.includes(entry.fingerprint) && deltaStatuses) {
      throw new Error(`delta status and live thread disposition disagree for ${thread.id} (${entry.fingerprint})`);
    }
    if (deltaStatuses) {
      // One root may merge several fingerprints, each already aggregating repeated ACT refs.
      const residual = members.some((fp) => deltaStatuses.get(fp) !== "resolved");
      if ((residual && thread.isResolved !== false)
        || (entry && entry.disposition !== (residual ? FIXER_DISPOSITION_KIND.DEFERRED : FIXER_DISPOSITION_KIND.TACKLED))) {
        throw new Error(`delta status and live thread disposition disagree for ${thread.id} (${members.join(", ")})`);
      }
    }
    if (!entry && (deltaStatuses || !thread.isResolved)) missing.push(thread.id);
  }
  if (completion && matchedBindings.size !== bindings.size) throw new Error("completion binding includes a foreign, unmarked or missing live root");
  if (missing.length > 0) {
    throw new Error(`GATE-EXEC-FIXER-DISPOSITION-BOUNDARY: the handoff has no disposition entry for gate thread(s) ${missing.join(", ")} that carry a judge-act fingerprint; an act item with a matching inline gate thread is never threadless, record its complete root disposition`);
  }
}

// Historical coordinates belong to the authenticated root, never the live (possibly shifted) line.
export async function assertDescendantThreadSites({ repo, pr, candidateHead, headSha, handoff, parsed, repoRoot }, { env, ghCommand, runChild }) {
  const gitEnv = { ...env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_DIFF_OPTS"]) delete gitEnv[key];
  for (const entry of handoff.dispositions.filter((entry) => entry.disposition === "tackled")) {
    const refuse = (reason, changed = false) => { throw new Error(`thread_site_${changed ? "changed" : "unverifiable"}: ${entry.threadId} (${candidateHead} -> ${headSha}): ${reason}; run pre_approval_gate with this open thread in --known-findings`); };
    const git = async (...args) => {
      const result = await runChild("git", ["-C", repoRoot, "--literal-pathspecs", ...args], gitEnv).catch(() => refuse("history unavailable"));
      if (result.code !== 0) refuse("history unavailable");
      return result.stdout.trim();
    };
    const root = parsed.comments.filter((comment) => comment.threadId === entry.threadId)
      .sort((a, b) => Number(a.databaseId) - Number(b.databaseId))[0];
    if (!root || !/^\d+$/.test(String(root.databaseId))) refuse("root identity unavailable");
    const response = await runChild(ghCommand, ["api", `repos/${repo}/pulls/comments/${root.databaseId}`], env).catch(() => refuse("historical root unreadable"));
    let site;
    try { site = JSON.parse(response.stdout); } catch { refuse("historical root unreadable"); }
    if (response.code !== 0 || !site || String(site.id) !== String(root.databaseId) || site.node_id !== root.id || site.in_reply_to_id
      || site.pull_request_url !== `https://api.github.com/repos/${repo}/pulls/${pr}`) refuse("historical root identity mismatch");
    let start = site.original_start_line ?? site.original_line, end = site.original_line;
    if (site.side !== "RIGHT" || site.original_start_line != null && site.start_side !== "RIGHT"
      || !Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start
      || !normalizeFullHeadSha(site.original_commit_id) || typeof site.path !== "string" || !site.path
      || path.isAbsolute(site.path) || site.path.split("/").includes("..")) refuse("unsupported historical coordinates");
    const walk = async (from, to, rejectOverlap) => {
      if (from === to) return;
      await git("merge-base", "--is-ancestor", from, to);
      const commits = (await git("rev-list", "--reverse", "--ancestry-path", `${from}..${to}`)).split("\n").filter(Boolean);
      let parent = from;
      for (const commit of commits) {
        const parents = (await git("rev-list", "--parents", "-n", "1", commit)).split(" ");
        if (parents.length !== 2 || parents[1] !== parent) refuse("nonlinear history");
        const patch = await git("diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", "--inter-hunk-context=0", parent, commit, "--", site.path);
        if (/Binary files|GIT binary patch|deleted file mode|new file mode|old mode|new mode/.test(patch)) refuse("site file replaced, deleted or binary");
        let offset = 0;
        for (const hunk of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
          const oldStart = Number(hunk[1]) + offset, oldCount = Number(hunk[2] ?? 1), newCount = Number(hunk[4] ?? 1);
          const delta = newCount - oldCount;
          const overlap = oldCount ? oldStart <= end && oldStart + oldCount - 1 >= start : oldStart >= start && oldStart < end;
          if (overlap) {
            if (rejectOverlap) refuse("later commit overlaps the thread range", true);
            if (!newCount) refuse("fix removed the historical range");
            start = Math.min(start, Number(hunk[3]));
            end = Math.max(Number(hunk[3]) + newCount - 1, end + delta);
          } else if (oldStart < start) { start += delta; end += delta; }
          offset += delta;
        }
        parent = commit;
      }
      if (parent !== to) refuse("incomplete history");
    };
    await git("cat-file", "-e", `${site.original_commit_id}:${site.path}`);
    await walk(site.original_commit_id, candidateHead, false);
    await walk(candidateHead, headSha, true);
  }
}

export async function verifyFixerDisposition(
  options,
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild, repoRoot = process.cwd() } = {},
) {
  if (options.construct && options.check) throw new Error("--construct and --check are mutually exclusive");
  if (options.tmpRoot) assertTmpRootOutsideLinkedWorktree(path.resolve(repoRoot, options.tmpRoot), repoRoot);
  const tmpRoot = options.tmpRoot || resolveGateArtifactTmpRoot(repoRoot);
  const logPath = buildLogPath({ repo: options.repo, pr: options.pr, gate: "fixer-disposition", headSha: options.headSha, tmpRoot });
  const fullPath = path.resolve(repoRoot, logPath);
  const runtime = { env, ghCommand, runChild };
  const { handoff, actList, deltaStatuses, completion, constructedReport, source, handoffPath, delivery, bindActiveFixer } = await loadDeliveredHandoff(options, { repoRoot, receiptTmpRoot: path.resolve(repoRoot, tmpRoot), runtime });
  // The observed head must be the live PR head, never a caller claim.
  const live = await runChild(ghCommand, ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid,statusCheckRollup"], env);
  const livePayload = live.code === 0 ? (() => { try { return JSON.parse(live.stdout); } catch { return null; } })() : null;
  const liveHead = livePayload?.headRefOid ?? null;
  // Same PR-visible filter as wait-pr-checks (probe-ci-status.mjs): runs outside the rollup never block step 5.
  const prVisibleCheckNames = (Array.isArray(livePayload?.statusCheckRollup) ? livePayload.statusCheckRollup : [])
    .map((entry) => entry?.name || entry?.context).filter((name) => typeof name === "string" && name.length > 0);
  if (liveHead !== options.headSha) {
    throw new Error(`--head-sha ${options.headSha} is not the live PR head ${liveHead ?? `(unreadable: ${(live.stderr || "").trim()})`}; refresh the PR state before verifying`);
  }
  // A refused handoff writes no checkpoint: capture and assert before the write.
  const initialSnapshot = await captureParsedReviewThreads({ repo: options.repo, pr: options.pr }, runtime);
  let gateLogin = null;
  if (Array.isArray(actList)) {
    gateLogin = await resolveAuthenticatedLogin({ env, ghCommand, runChild });
    assertActItemThreadsDisposed(actList, handoff, initialSnapshot, gateLogin, deltaStatuses, completion);
  }
  if (handoff.headSha !== options.headSha) {
    if (source === "act-list" && !completion) throw new Error("thread_site_unverifiable: descendant ACT delivery needs authenticated completion input; run pre_approval_gate with the open threads in --known-findings");
    const contained = await isCommitContainedByHead({ repo: options.repo, commitSha: handoff.headSha, headSha: options.headSha }, runtime);
    if (!contained.contained) throw new Error(`candidate is not contained by the observed head: ${contained.reason}; run a full gate round`);
    await assertDescendantThreadSites({ ...options, candidateHead: handoff.headSha, handoff, parsed: initialSnapshot, repoRoot }, runtime);
    // Catch movement during the historical proof before construction, checkpoints or GitHub writes.
    const current = await runChild(ghCommand, ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"], env);
    if (current.code !== 0 || JSON.parse(current.stdout).headRefOid !== options.headSha) throw new Error("live head changed during thread-site proof; refresh and run a full gate round");
  }
  if (options.construct) {
    await mkdir(path.dirname(handoffPath), { recursive: true });
    const text = `${JSON.stringify(constructedReport, null, 2)}\n`;
    let report, marker, temporary, markerIdentity, published = false;
    try {
      const existing = await lstat(handoffPath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (existing) throw Object.assign(new Error(`EEXIST: report already exists at ${handoffPath}`), { code: "EEXIST" });
      temporary = await mkdtemp(path.join(path.dirname(handoffPath), ".fixer-construction-"));
      const pending = path.join(temporary, "report.json");
      report = await open(pending, "wx");
      await report.writeFile(text, "utf8");
      await report.close();
      report = null;
      marker = await open(constructMarkPath(handoffPath), "wx");
      markerIdentity = await marker.stat();
      await marker.writeFile(sha256Hex(text), "utf8");
      await marker.close();
      marker = null;
      // Publish exclusively only after both files close; cleanup is never admission authority.
      await link(pending, handoffPath);
      published = true;
    } catch (cause) {
      throw Object.assign(new Error(`Fixer construction failed: ${cause.message}`, { cause }), { code: "FIXER_CONSTRUCTION_FAILED" });
    } finally {
      await Promise.allSettled([report, marker].filter(Boolean).map((file) => file.close()));
      // Recover caught failures only; never remove a pre-existing or replaced marker.
      if (!published && markerIdentity) {
        const current = await lstat(constructMarkPath(handoffPath)).catch(() => null);
        if (current?.dev === markerIdentity.dev && current.ino === markerIdentity.ino) {
          await rm(constructMarkPath(handoffPath)).catch(() => {});
        }
      }
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true, constructed: true, outputRef: handoffPath };
  }
  if (source) {
    // A red head resolves nothing: the fixer hands back ci_failed with these check names.
    const ci = await observeHeadCiSignals({ repo: options.repo, headSha: options.headSha, prVisibleCheckNames }, runtime);
    const failed = [...(ci.checkRuns.visibleSignal?.failureDetails ?? []), ...ci.statuses.statusFailures.map((s) => s.name)];
    if (failed.length > 0) throw new Error(`ci_failed: checks are red at ${options.headSha} (${failed.join(", ")}); resolve no thread, hand back ci_failed with these check names`);
    // Fail closed: only an observed, settled-green head may resolve threads.
    const state = !ci.checkRuns.ok || !ci.statuses.ok ? "unreadable"
      : normalizeHeadScopedCiContract({
        checkRunsStatus: ci.checkRuns.visibleSignal.status,
        commitStatus: ci.statuses.commitStatus,
        checkRunsUnsupportedCompleted: ci.checkRuns.visibleSignal.unsupportedCompleted,
      }).overallStatus;
    // A head with no check runs and no statuses besides the loop-derived gate-evidence is settled (wait-pr-checks settles it); anything else must be green.
    const checkless = state === "none" && ci.checkRuns.nonLoopDerivedCount === 0 && ci.statuses.nonLoopDerivedCount === 0
      && prVisibleCheckNames.every((name) => LOOP_DERIVED_CI_CHECK_NAMES.includes(name));
    if (state !== "success" && !checkless) {
      const code = state === "pending" ? "ci_pending" : "ci_unknown";
      throw new Error(`${code}: checks at ${options.headSha} are ${state}, not settled green; resolve no thread, hand back ${code}`);
    }
  }
  if (!options.check) {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify({ ...handoff, ...delivery, headSha: options.headSha }, null, 2)}\n`, "utf8");
  }

  const tackledShas = [...new Set(
    handoff.dispositions
      .filter((entry) => entry.disposition === FIXER_DISPOSITION_KIND.TACKLED)
      .map((entry) => entry.fixingCommitSha),
  )];
  const containment = await buildContainmentMap(tackledShas, { repo: options.repo, headSha: options.headSha }, runtime);

  let evaluation = evaluateFixerDisposition({
    handoff,
    liveThreads: buildLiveThreads(initialSnapshot),
    containment,
  });

  const actions = [];
  const residualFailures = [];
  // A deferred thread the delta review left not_resolved or cannot_verify gets one residual-status reply and stays open.
  // Shared by the ACT and THREAD routes; --check only observes the reply and reports it missing; a live reply carrying the marker makes re-entry post nothing.
  {
    const deferred = handoff.dispositions.filter((entry) => entry.disposition === FIXER_DISPOSITION_KIND.DEFERRED);
    const openTargets = deferred.length > 0 ? planBatchReplyTargets(initialSnapshot, "all").matchedTargets : [];
    for (const entry of deferred) {
      const target = openTargets.find((candidate) => candidate.threadId === entry.threadId);
      if (!target) continue;
      // The ACT route's authenticated delta statuses are authoritative; the delta record lookup serves the THREAD route.
      let blocked = null;
      if (Array.isArray(actList) && deltaStatuses) {
        const actFingerprints = new Set(actList.map((item) => item?.fingerprint ?? fingerprintFinding(item)));
        const { members } = selectActThreadBinding(initialSnapshot, entry.threadId, gateLogin, actFingerprints);
        const status = members.map((fp) => deltaStatuses.get(fp)).find((value) => value === "not_resolved" || value === "cannot_verify");
        if (status) blocked = { status };
      }
      blocked ??= await findDeltaBlockedFixedReply(
        [{ threadId: entry.threadId, body: "", commit: entry.fixingCommitSha }],
        { repo: options.repo, pr: options.pr, parsed: initialSnapshot, tmpRoot: path.resolve(repoRoot, tmpRoot) },
        runtime,
      );
      if (!blocked) continue;
      // Idempotent per fixing commit: a marker from an earlier round's commit never suppresses this round's status.
      if (initialSnapshot.comments.some((comment) => comment.threadId === entry.threadId
        && String(comment.body).includes(RESIDUAL_REPLY_MARKER) && String(comment.body).includes(entry.fixingCommitSha))) continue;
      if (options.check) {
        residualFailures.push({ threadId: entry.threadId, expectedCommit: entry.fixingCommitSha, failedStep: "residual_reply_failed", error: "residual-status reply not observed live" });
        continue;
      }
      try {
        await replyAndMaybeResolve(
          {
            repo: options.repo, pr: options.pr, commentId: target.commentId, threadId: entry.threadId,
            body: `${RESIDUAL_REPLY_MARKER} ${blocked.status} after the delta review of commit ${entry.fixingCommitSha}; this thread stays open for the next gate round.`,
            resolve: false, validatedSnapshot: initialSnapshot,
          },
          runtime,
        );
        actions.push({ threadId: entry.threadId, ok: true, step: "residual_replied" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actions.push({ threadId: entry.threadId, ok: false, error: message });
        residualFailures.push({ threadId: entry.threadId, expectedCommit: entry.fixingCommitSha, failedStep: "residual_reply_failed", error: message });
      }
    }
  }
  // Only progress steps that ARE authorized (commit contained) and that are
  // actually actionable via reply/resolve; commit_not_contained and
  // missing_from_handoff never trigger a mutation (Non-goals: a SHA alone, or
  // a claim with no ledger entry, is never evidence).
  // A thread the delta review of the fix left not_resolved or cannot_verify gets no "Fixed" reply.
  const deltaBlocked = new Map();
  for (const entry of evaluation.incomplete.filter((e) => e.failedStep === FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING || e.failedStep === FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED)) {
    const blocked = await findDeltaBlockedFixedReply(
      [{ threadId: entry.threadId, body: `Fixed in commit ${entry.expectedCommit}.`, commit: entry.expectedCommit }],
      { repo: options.repo, pr: options.pr, parsed: initialSnapshot, tmpRoot: path.resolve(repoRoot, tmpRoot) },
      runtime,
    );
    if (blocked) deltaBlocked.set(entry.threadId, blocked);
  }
  const actionable = evaluation.incomplete.filter((entry) => !deltaBlocked.has(entry.threadId) && (
    entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING
    || entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED
  ));
  if (!options.check && actionable.length > 0) {
    const { matchedTargets } = planBatchReplyTargets(initialSnapshot, "all");
    const commentIdByThreadId = new Map(matchedTargets.map((target) => [target.threadId, target.commentId]));
    for (const entry of actionable) {
      try {
        if (entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING) {
          // A REST comment is only required here: this branch is the one that
          // actually posts a reply, so a missing/filtered commentId means
          // there is nothing to reply to.
          const commentId = commentIdByThreadId.get(entry.threadId);
          if (commentId === undefined) {
            actions.push({ threadId: entry.threadId, ok: false, error: "no unresolved matching comment found to reply to" });
            continue;
          }
          // Ordering: containment already verified above; post the one
          // evidenced reply and resolve in the same call (replyAndMaybeResolve
          // asserts isResolved before returning).
          await replyAndMaybeResolve(
            {
              repo: options.repo,
              pr: options.pr,
              commentId,
              threadId: entry.threadId,
              body: `Fixed in commit ${entry.expectedCommit}.`,
              resolve: true,
              validatedSnapshot: initialSnapshot,
            },
            runtime,
          );
          actions.push({ threadId: entry.threadId, ok: true, step: "replied_and_resolved" });
        } else {
          // A commit-evidenced reply already exists live (idempotent re-entry
          // after a reply-succeeded/resolve-failed partial run) — resolve only,
          // never post a second reply. resolveThread needs only threadId, so a
          // missing/filtered commentId must never block this path.
          const resolvedThread = await resolveThread(entry.threadId, runtime);
          if (!resolvedThread?.isResolved) {
            throw new Error(`Review thread did not resolve successfully: ${entry.threadId}`);
          }
          actions.push({ threadId: entry.threadId, ok: true, step: "resolved" });
        }
      } catch (error) {
        actions.push({ threadId: entry.threadId, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // Live re-read verify (invariant step 5): re-fetch rather than trust the
    // mutation responses, so a resolve that silently didn't stick still
    // surfaces as incomplete.
    const refreshedSnapshot = await captureParsedReviewThreads({ repo: options.repo, pr: options.pr }, runtime);
    evaluation = evaluateFixerDisposition({
      handoff,
      liveThreads: buildLiveThreads(refreshedSnapshot),
      containment,
    });
  }

  const incomplete = [...evaluation.incomplete, ...residualFailures].map((entry) => (deltaBlocked.has(entry.threadId)
    ? { ...entry, failedStep: FIXER_DISPOSITION_FAILED_STEP.DELTA_BLOCKED, deltaStatus: deltaBlocked.get(entry.threadId).status, deltaRecord: deltaBlocked.get(entry.threadId).recordPath }
    : entry));
  const activeFixer = evaluation.ok ? undefined : await bindActiveFixer(false);
  if (!options.check && evaluation.ok && residualFailures.length === 0) {
    await writeFile(fullPath, `${JSON.stringify({ ...handoff, ...delivery, headSha: options.headSha, complete: true }, null, 2)}\n`, "utf8");
  }
  return {
    // A failed residual-status reply is not delivered: nonzero exit naming the thread.
    ok: residualFailures.length === 0,
    ...(residualFailures.length ? { error: `residual-status reply failed for thread(s) ${residualFailures.map((failure) => failure.threadId).join(", ")}; re-run the verifier` } : {}),
    repo: options.repo,
    pr: options.pr,
    headSha: options.headSha,
    checkpointPath: options.check ? null : logPath,
    complete: evaluation.ok && residualFailures.length === 0,
    ...(activeFixer ? { activeFixer } : {}),
    incomplete,
    forbiddenActions: evaluation.forbiddenActions,
    nextAction: evaluation.nextAction,
    reason: residualFailures.length > 0 ? `residual-status reply failed for thread(s) ${residualFailures.map((failure) => failure.threadId).join(", ")}; re-run the verifier`
      : deltaBlocked.size > 0 ? deltaBlockedReason(incomplete) : evaluation.reason,
    actions,
  };
}

// Re-derived from the remapped incomplete list so one output never carries two failedStep values.
function deltaBlockedReason(incomplete) {
  const parts = incomplete.map((entry) => `thread ${entry.threadId} (failed step: ${entry.failedStep}${entry.deltaStatus ? `, delta status: ${entry.deltaStatus}` : ""})`);
  return `Fixer disposition is incomplete for ${incomplete.length} tackled thread(s): ${parts.join("; ")}. `
    + "A delta_blocked thread is not fixed yet: fix it, re-run the delta review (dev-loops loop pre-push-delta), then re-run this verifier.";
}

async function main() {
  let options;
  try {
    options = parseVerifyFixerDispositionCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await verifyFixerDisposition(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
export { loadDeliveredHandoff };

if (isDirectCliRun(import.meta.url)) {
  await main();
}
