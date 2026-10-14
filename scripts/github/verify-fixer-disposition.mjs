#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
import { verifyPulledResult, workOrderDigest } from "./_work-order-protocol.mjs";
import {
  evaluateFixerDisposition,
  FIXER_DISPOSITION_FAILED_STEP,
  FIXER_DISPOSITION_KIND,
  normalizeFixerDispositionHandoff,
  siteCoverageGaps,
} from "@dev-loops/core/loop/fixer-disposition";
import { isDeltaResultFresh, startDeltaSequence, toDeltaActItems, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { DELTA_CLEARING_NEXT_STEPS, readGateDeltaRecord } from "../loop/_gate-delta-record.mjs";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";

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
Output (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": 17, "headSha": "...", "checkpointPath": "...",
    "complete": true|false, "incomplete": [{ threadId, expectedCommit, failedStep, deltaStatus?, deltaRecord? }],
    "forbiddenActions": [...], "nextAction": "..."|null, "reason": "..."|null,
    "actions": [{ threadId, ok, step? , error? }] }
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
    if (token.name === "check") {
      options.check = true;
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
  if (receipt.reason === "result_missing") throw new Error(`result_missing: no fixer disposition handoff at the work order's outputRef ${handoffPath}; a receipt alone is never completion`);
  // verifyPulledResult compares the handoff mtime to the receipt file mtime: one filesystem clock.
  if (receipt.reason === "result_predates_pull") {
    throw new Error(`result_predates_pull: the disposition handoff ${handoffPath} was written before the pull at ${receipt.receipt.pulledAt}; a stale or replayed disposition never advances`);
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(handoffPath, "utf8"));
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
  const handoff = normalizeFixerDispositionHandoff(raw, { ruleIds: loadKnownRuleIds() });
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
      const sequence = startDeltaSequence({ reviewBaselineHead: order.headSha, actList });
      const errors = validateDeltaResult(delta, { sequence, membershipOnly: true });
      if (errors.length) throw new Error(`Invalid delta result: ${errors.join("; ")}`);
      const decision = readGateDeltaRecord(receiptTmpRoot, order.headSha);
      const pairs = (items) => (items ?? []).map(({ ref, status }) => JSON.stringify([ref, status])).sort().join("\n");
      if (!decision || !DELTA_CLEARING_NEXT_STEPS.includes(decision.nextStep)
        || decision.reviewBaselineHead !== order.headSha || decision.actSetId !== sequence.actSetId
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
      for (const item of sequence.actItems) {
        const fingerprint = item.fingerprint ?? item.ref;
        const status = statuses.get(item.ref);
        if (!deltaStatuses.has(fingerprint) || status !== "resolved") deltaStatuses.set(fingerprint, status);
      }
      for (const entry of handoff.dispositions) {
        if (!entry.fingerprint) continue;
        const status = deltaStatuses.get(entry.fingerprint);
        if (!status || entry.disposition !== (status === "resolved" ? FIXER_DISPOSITION_KIND.TACKLED : FIXER_DISPOSITION_KIND.DEFERRED)) {
          throw new Error(`delta status and disposition disagree for ${entry.fingerprint}`);
        }
      }
      if (bounded) {
        for (const [ref, status] of statuses) if (status === "not_resolved" || status === "cannot_verify") residualRefs.add(ref);
      }
    }
    const coverage = [
      ...(handoff.siteCoverage ?? []),
      ...handoff.dispositions.filter((entry) => entry.fingerprint && (entry.sites || entry.returnedSites || entry.noSitesReason)),
    ];
    const gaps = siteCoverageGaps(toDeltaActItems(actList), coverage, residualRefs);
    if (gaps.length > 0) throw new Error(`GATE-EXEC-REMEDIATION-SITE-QUERY: the disposition handoff leaves site coverage incomplete: ${gaps.join("; ")}`);
  }
  return {
    handoff,
    actList,
    deltaStatuses,
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
function assertActItemThreadsDisposed(actList, handoff, parsed, gateLogin, deltaStatuses) {
  for (const entry of handoff.dispositions) {
    const status = deltaStatuses?.get(entry.fingerprint);
    if (status && status !== "resolved"
      && parsed.threads.find((thread) => thread.id === entry.threadId)?.isResolved !== false) {
      throw new Error(`delta status and live thread disposition disagree for ${entry.threadId} (${entry.fingerprint})`);
    }
  }
  const dispositioned = new Set(handoff.dispositions.map((entry) => entry.threadId));
  const openFingerprints = new Map();
  for (const thread of parsed.threads) {
    const root = threadRootComment(parsed, thread.id);
    if (!root || root.author?.login !== gateLogin) continue;
    // A merged inline comment carries one marker per member: index every one, not just the first.
    const fps = new Set();
    collectFingerprints(root.body, fps);
    const entry = handoff.dispositions.find((item) => item.threadId === thread.id);
    if (entry?.fingerprint && !fps.has(entry.fingerprint) && [...fps].some((fp) => deltaStatuses?.has(fp))) {
      throw new Error(`delta status and live thread disposition disagree for ${thread.id} (${entry.fingerprint})`);
    }
    for (const fp of fps) {
      const status = deltaStatuses?.get(fp);
      if (status && ((status !== "resolved" && thread.isResolved)
        || (entry && entry.disposition !== (status === "resolved" ? FIXER_DISPOSITION_KIND.TACKLED : FIXER_DISPOSITION_KIND.DEFERRED)))) {
        throw new Error(`delta status and live thread disposition disagree for ${thread.id} (${fp})`);
      }
      if (thread.isResolved) continue;
      if (!openFingerprints.has(fp)) openFingerprints.set(fp, new Set());
      openFingerprints.get(fp).add(thread.id);
    }
  }
  const missing = actList
    .flatMap((item) => [item?.fingerprint ?? fingerprintFinding(item)].flatMap((fp) => [...(openFingerprints.get(fp) ?? [])]))
    .filter((threadId) => !dispositioned.has(threadId));
  if (missing.length > 0) {
    throw new Error(`GATE-EXEC-FIXER-DISPOSITION-BOUNDARY: the handoff has no disposition entry for open gate thread(s) ${[...new Set(missing)].join(", ")} that carry a judge-act fingerprint; an act item with an open inline gate thread is never threadless, record it as tackled and reply-resolve the thread`);
  }
}

export async function verifyFixerDisposition(
  options,
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild, repoRoot = process.cwd() } = {},
) {
  if (options.tmpRoot) assertTmpRootOutsideLinkedWorktree(path.resolve(repoRoot, options.tmpRoot), repoRoot);
  const tmpRoot = options.tmpRoot || resolveGateArtifactTmpRoot(repoRoot);
  const logPath = buildLogPath({ repo: options.repo, pr: options.pr, gate: "fixer-disposition", headSha: options.headSha, tmpRoot });
  const fullPath = path.resolve(repoRoot, logPath);
  const runtime = { env, ghCommand, runChild };
  const { handoff, actList, deltaStatuses, delivery } = await loadDeliveredHandoff(options, { repoRoot, receiptTmpRoot: path.resolve(repoRoot, tmpRoot), runtime });
  // The observed head must be the live PR head, never a caller claim.
  const live = await runChild(ghCommand, ["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"], env);
  const liveHead = live.code === 0 ? (() => { try { return JSON.parse(live.stdout).headRefOid; } catch { return null; } })() : null;
  if (liveHead !== options.headSha) {
    throw new Error(`--head-sha ${options.headSha} is not the live PR head ${liveHead ?? `(unreadable: ${(live.stderr || "").trim()})`}; refresh the PR state before verifying`);
  }
  // A refused handoff writes no checkpoint: capture and assert before the write.
  const initialSnapshot = await captureParsedReviewThreads({ repo: options.repo, pr: options.pr }, runtime);
  if (Array.isArray(actList)) {
    assertActItemThreadsDisposed(actList, handoff, initialSnapshot, await resolveAuthenticatedLogin({ env, ghCommand, runChild }), deltaStatuses);
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
