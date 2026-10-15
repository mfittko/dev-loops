#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { loadKnownRuleIds } from "../lib/known-rule-ids.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { collectFingerprints, fingerprintFinding } from "./_gate-finding-surface.mjs";
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
import { DELTA_CLEARING_NEXT_STEPS, readGateDeltaRecord } from "../loop/_gate-delta-record.mjs";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { realpathNearestExisting } from "@dev-loops/core/loop/worktree-guard";
import { revalidateLegacyCompletion } from "./_legacy-fixer-revalidation.mjs";

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
                        when written at or after that pull, and when its headSha is
                        the observed --head-sha.
Optional:
  --construct                 Construct the current ACT full worker's canonical
                               report from authenticated completion input; no
                               checkpoint or GitHub mutation. Not --check.
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
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
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
  if (receipt.reason === "result_missing" && !options.construct) throw new Error(`result_missing: no fixer disposition handoff at the work order's outputRef ${handoffPath}; a receipt alone is never completion`);
  // verifyPulledResult compares the handoff mtime to the receipt file mtime: one filesystem clock.
  if (receipt.reason === "result_predates_pull") {
    throw new Error(`result_predates_pull: the disposition handoff ${handoffPath} was written before the pull at ${receipt.receipt.pulledAt}; a stale or replayed disposition never advances`);
  }
  const completionReads = (order.requiredReads ?? []).filter((read) => read?.kind === "completion-input");
  const optionalCompletion = completionReads.length > 0 || Object.hasOwn(order.authority ?? {}, "completionInputDigest")
    || Object.hasOwn(order.authority ?? {}, "completionInputBytesDigest");
  let completion = null;
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
    if (!completion || completion.headSha !== options.headSha || !normalizeFullHeadSha(completion.headSha)
      || normalizeFullHeadSha(completion.fixingCommitSha) !== completion.fixingCommitSha
      || !Array.isArray(completion.siteCoverage) || !Array.isArray(completion.threadBindings)) {
      throw new Error("completion input requires the actual full candidate/fixing heads, coverage and thread bindings");
    }
    const executionDir = path.join(await real(path.dirname(planPath)), plan.executionIdentity);
    const symlinks = await Promise.all([path.dirname(handoffPath), handoffPath].map((file) => lstat(file).then((info) => info.isSymbolicLink(), () => false)));
    if (symlinks.some(Boolean) || path.normalize(realpathNearestExisting(path.dirname(handoffPath))) !== executionDir
      || path.normalize(realpathNearestExisting(handoffPath)) !== path.join(executionDir, "fixer-disposition.json")) {
      throw new Error("completion output or execution directory redirects outside its canonical execution path");
    }
    const subject = receipt.receipt.subject;
    if (!/^f\d+-[a-f0-9]{8}$/.test(plan.executionIdentity) || plan.workOrderRef !== `fixer:${options.repo}#${options.pr}:${order.headSha}:${plan.executionIdentity}`
      || subject.repo !== options.repo || subject.pr !== options.pr || subject.headSha !== order.headSha
      || subject.branch !== order.mutationAuthority?.branch || subject.phase !== "full") {
      throw new Error("completion current pull subject does not match its full fixer authority");
    }
  }
  if (options.construct && !completion) throw new Error("--construct requires authenticated ACT completion input");
  let raw = options.construct ? { headSha: options.headSha, dispositions: [], siteCoverage: completion.siteCoverage } : null;
  try {
    if (!options.construct) raw = JSON.parse(await readFile(handoffPath, "utf8"));
  } catch {
    throw new Error(`Fixer disposition handoff ${handoffPath} is not valid JSON`);
  }
  if (raw?.headSha !== options.headSha) {
    throw new Error(`Fixer disposition handoff claims head ${raw?.headSha}, not the observed head ${options.headSha}; refresh the PR state before verifying`);
  }
  if (order.headSha !== options.headSha) {
    const contained = await isCommitContainedByHead({ repo: options.repo, commitSha: order.headSha, headSha: options.headSha }, runtime);
    if (!contained.contained) throw new Error(`the work order head ${order.headSha} is not contained by the observed head ${options.headSha}: ${contained.reason}`);
  }
  let handoff = normalizeFixerDispositionHandoff(raw, { ruleIds: loadKnownRuleIds() });
  const threadsRead = (order.requiredReads ?? []).find((read) => read?.kind === "threads");
  if (threadsRead) {
    const bytes = await readFile(threadsRead.path);
    if (createHash("sha256").update(bytes).digest("hex") !== String(threadsRead.sha256 ?? "").replace(/^sha256:/, "")) {
      throw new Error(`the work order's threads ${threadsRead.path} differ from the sha256 the work order binds`);
    }
    const source = JSON.parse(bytes.toString("utf8"));
    if (sha256Hex(source).slice(7) !== order.authority?.sourceDigest) {
      throw new Error(`the work order's threads ${threadsRead.path} differ from the canonical authority.sourceDigest the work order binds`);
    }
    if (!Array.isArray(source?.threads) || source.threads.some((thread) => typeof thread?.threadId !== "string" || !thread.threadId)) {
      throw new Error(`the work order's threads ${threadsRead.path} have invalid thread IDs`);
    }
    const disposed = new Set(handoff.dispositions.map((entry) => entry.threadId));
    const missing = source.threads.filter((thread) => !disposed.has(thread.threadId));
    if (missing.length) throw new Error(`the handoff has no disposition entry for source thread(s) ${missing.map((thread) => thread.threadId).join(", ")}`);
  }
  // GATE-EXEC-REMEDIATION-SITE-QUERY: an act-list work order's items with a siteQuery need a coverage record.
  const actRead = (order.requiredReads ?? []).find((read) => read?.kind === "act-list");
  let actList = null;
  let deltaStatuses = null;
  if (actRead) {
    try {
      const actBytes = await readFile(actRead.path);
      if (createHash("sha256").update(actBytes).digest("hex") !== String(actRead.sha256 ?? "").replace(/^sha256:/, "")) {
        throw new Error(`the work order's act list ${actRead.path} differs from the sha256 the work order binds; it was rewritten after emission`);
      }
      actList = JSON.parse(actBytes.toString("utf8"));
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
      const bytes = await readFile(deltaRead.path);
      if (createHash("sha256").update(bytes).digest("hex") !== String(deltaRead.sha256 ?? "").replace(/^sha256:/, "")) {
        throw new Error("the work order's delta result differs from its sha256");
      }
      const delta = JSON.parse(bytes.toString("utf8"));
      if (sha256Hex(delta).slice(7) !== order.authority.deltaResultDigest) {
        throw new Error("the work order's delta result differs from authority.deltaResultDigest");
      }
      const baseline = completion ? delta.reviewBaselineHead : order.headSha;
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
    handoffPath,
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

// parseReviewThreads id-sorts comments, so the root is the one with the smallest numeric databaseId
// (the first comment when no databaseId parses).
function threadRootComment(parsed, threadId) {
  const numeric = (c) => (/^\d+$/.test(String(c.databaseId ?? "")) ? Number(c.databaseId) : Infinity);
  return parsed.comments
    .filter((c) => c.threadId === threadId)
    .reduce((root, c) => (root === undefined || numeric(c) < numeric(root) ? c : root), undefined);
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
    const root = threadRootComment(parsed, entry.threadId);
    const fps = new Set();
    collectFingerprints(root?.body ?? "", fps);
    if (root?.author?.login !== gateLogin || ![...fps].some((fp) => actFingerprints.has(fp))
      || (entry.fingerprint && (!deltaStatuses.has(entry.fingerprint) || !fps.has(entry.fingerprint)))) {
      throw new Error(`delta status and live thread disposition disagree for ${entry.threadId} (${entry.fingerprint})`);
    }
  }
  const missing = [];
  for (const thread of parsed.threads) {
    const root = threadRootComment(parsed, thread.id);
    if (!root || root.author?.login !== gateLogin) continue;
    // A merged inline comment carries one marker per member: index every one, not just the first.
    const fps = new Set();
    collectFingerprints(root.body, fps);
    const members = [...fps].filter((fp) => actFingerprints.has(fp));
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
  const { handoff, actList, deltaStatuses, completion, constructedReport, handoffPath, delivery } = await loadDeliveredHandoff(options, { repoRoot, receiptTmpRoot: path.resolve(repoRoot, tmpRoot), runtime });
  // The observed head must be the live PR head, never a caller claim.
  const live = await runChild(ghCommand, ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"], env);
  const liveHead = live.code === 0 ? (() => { try { return JSON.parse(live.stdout).headRefOid; } catch { return null; } })() : null;
  if (liveHead !== options.headSha) {
    throw new Error(`--head-sha ${options.headSha} is not the live PR head ${liveHead ?? `(unreadable: ${(live.stderr || "").trim()})`}; refresh the PR state before verifying`);
  }
  // A refused handoff writes no checkpoint: capture and assert before the write.
  const initialSnapshot = await captureParsedReviewThreads({ repo: options.repo, pr: options.pr }, runtime);
  if (Array.isArray(actList)) {
    assertActItemThreadsDisposed(actList, handoff, initialSnapshot, await resolveAuthenticatedLogin({ env, ghCommand, runChild }), deltaStatuses, completion);
  }
  if (options.construct) {
    await mkdir(path.dirname(handoffPath), { recursive: true });
    await writeFile(handoffPath, `${JSON.stringify(constructedReport, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { ok: true, constructed: true, outputRef: handoffPath };
  }
  if (!options.check) {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify({ ...handoff, ...delivery }, null, 2)}\n`, "utf8");
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

  const incomplete = evaluation.incomplete.map((entry) => (deltaBlocked.has(entry.threadId)
    ? { ...entry, failedStep: FIXER_DISPOSITION_FAILED_STEP.DELTA_BLOCKED, deltaStatus: deltaBlocked.get(entry.threadId).status, deltaRecord: deltaBlocked.get(entry.threadId).recordPath }
    : entry));
  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    headSha: options.headSha,
    checkpointPath: options.check ? null : logPath,
    complete: evaluation.ok,
    incomplete,
    forbiddenActions: evaluation.forbiddenActions,
    nextAction: evaluation.nextAction,
    reason: deltaBlocked.size > 0 ? deltaBlockedReason(incomplete) : evaluation.reason,
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
if (isDirectCliRun(import.meta.url)) {
  await main();
}
