#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { assertTmpRootOutsideLinkedWorktree, resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { captureParsedReviewThreads, replyAndMaybeResolve, resolveThread } from "./_review-thread-mutations.mjs";
import { planBatchReplyTargets } from "./reply-resolve-review-threads.mjs";
import { buildContainmentMap, isCommitContainedByHead } from "./_commit-containment.mjs";
import { verifyPullReceipt } from "./_work-order-protocol.mjs";
import {
  evaluateFixerDisposition,
  FIXER_DISPOSITION_FAILED_STEP,
  FIXER_DISPOSITION_KIND,
  normalizeFixerDispositionHandoff,
} from "@dev-loops/core/loop/fixer-disposition";

const USAGE = `Usage: verify-fixer-disposition.mjs --repo <owner/name> --pr <number> --head-sha <sha> --fixer-plan <path> [--tmp-root <path>]
Enforce GATE-EXEC-FIXER-DISPOSITION-BOUNDARY: verify every review thread a fixer
claims to have tackled since its last push is fully disposed (commit contained
by the observed PR head, replied with that commit's evidence, resolved, and
re-verified live) before the loop may request/dispatch/post another review or
gate round.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
  --head-sha <sha>      FULL observed PR head commit SHA (40 or 64 hex chars)
  --fixer-plan <path>   The fixer-emit-plan.json the full-phase fixer was dispatched
                        from (emit-fixer-work-order.mjs, ADR 0106). The disposition
                        handoff { headSha, dispositions } is read from the plan's
                        outputRef. It counts only with a matching fixer pull receipt,
                        when written at or after that pull, and when its headSha is
                        the observed --head-sha.
Optional:
  --tmp-root <path>            Root tmp directory for the checkpoint and the pull
                               receipts (default: the main git worktree's tmp/, so
                               a prune of a linked worktree never takes the
                               checkpoint with it). A path inside a linked
                               worktree is refused (exit 1).
Idempotent: re-entry re-verifies the receipt against the plan, rewrites the
checkpoint for --head-sha and re-verifies live GitHub state; a thread already
replied with its commit's evidence is never replied to twice, and a thread
already resolved live is left alone.
Output (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": 17, "headSha": "...", "checkpointPath": "...",
    "complete": true|false, "incomplete": [{ threadId, expectedCommit, failedStep }],
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
  const order = plan?.workOrder;
  if (order?.role !== "fixer" || order.phase !== "full" || order.target?.repo !== options.repo || order.target?.pr !== options.pr) {
    throw new Error(`--fixer-plan "${options.fixerPlan}" is not a full-phase fixer work order for ${options.repo}#${options.pr}`);
  }
  const receipt = await verifyPullReceipt({
    receiptTmpRoot, role: "fixer", workOrderRef: plan.workOrderRef, workOrderDigest: plan.workOrderDigest, executionIdentity: plan.executionIdentity,
  });
  if (!receipt.ok) throw new Error(`fixer pull receipt for ${plan.workOrderRef} failed verification: ${receipt.reason}; dispatch a fresh fixer execution`);
  const handoffPath = order.outputRefs?.[0];
  const written = typeof handoffPath === "string" ? await stat(handoffPath).catch(() => null) : null;
  if (!written) throw new Error(`result_missing: no fixer disposition handoff at the work order's outputRef ${handoffPath}; a receipt alone is never completion`);
  if (!(written.mtimeMs >= Date.parse(receipt.receipt.pulledAt))) {
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
  return {
    handoff: normalizeFixerDispositionHandoff(raw),
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

export async function verifyFixerDisposition(
  options,
  { env = process.env, ghCommand = "gh", runChild, repoRoot = process.cwd() } = {},
) {
  if (options.tmpRoot) assertTmpRootOutsideLinkedWorktree(path.resolve(repoRoot, options.tmpRoot), repoRoot);
  const tmpRoot = options.tmpRoot || resolveGateArtifactTmpRoot(repoRoot);
  const logPath = buildLogPath({ repo: options.repo, pr: options.pr, gate: "fixer-disposition", headSha: options.headSha, tmpRoot });
  const fullPath = path.resolve(repoRoot, logPath);
  const runtime = { env, ghCommand, runChild };
  const { handoff, delivery } = await loadDeliveredHandoff(options, { repoRoot, receiptTmpRoot: path.resolve(repoRoot, tmpRoot), runtime });
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify({ ...handoff, ...delivery }, null, 2)}\n`, "utf8");

  const initialSnapshot = await captureParsedReviewThreads({ repo: options.repo, pr: options.pr }, runtime);

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
  const actionable = evaluation.incomplete.filter((entry) => (
    entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.REPLY_MISSING
    || entry.failedStep === FIXER_DISPOSITION_FAILED_STEP.NOT_RESOLVED
  ));
  if (actionable.length > 0) {
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

  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    headSha: options.headSha,
    checkpointPath: logPath,
    complete: evaluation.ok,
    incomplete: evaluation.incomplete,
    forbiddenActions: evaluation.forbiddenActions,
    nextAction: evaluation.nextAction,
    reason: evaluation.reason,
    actions,
  };
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
