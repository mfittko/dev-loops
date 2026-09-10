#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FULL_HEAD_SHA_ERROR, normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { captureParsedReviewThreads, replyAndMaybeResolve, resolveThread } from "./_review-thread-mutations.mjs";
import { planBatchReplyTargets } from "./reply-resolve-review-threads.mjs";
import { buildContainmentMap } from "./_commit-containment.mjs";
import {
  evaluateFixerDisposition,
  FIXER_DISPOSITION_FAILED_STEP,
  FIXER_DISPOSITION_KIND,
  normalizeFixerDispositionHandoff,
} from "@dev-loops/core/loop/fixer-disposition";

const USAGE = `Usage: verify-fixer-disposition.mjs --repo <owner/name> --pr <number> --head-sha <sha> [--dispositions <json> | --dispositions-file <path>] [--tmp-root <path>]
Enforce GATE-EXEC-FIXER-DISPOSITION-BOUNDARY: verify every review thread a fixer
claims to have tackled since its last push is fully disposed (commit contained
by the observed PR head, replied with that commit's evidence, resolved, and
re-verified live) before the loop may request/dispatch/post another review or
gate round.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
  --head-sha <sha>      FULL observed PR head commit SHA (40 or 64 hex chars)
Optional:
  --dispositions <json>       JSON array of { threadId, fingerprint?, fixingCommitSha,
                               disposition, validation? } entries. When supplied, this
                               (over)writes the durable checkpoint for --head-sha before
                               verifying. Mutually exclusive with --dispositions-file.
  --dispositions-file <path>  Same shape, read from a file instead of an inline argument.
  --tmp-root <path>            Root tmp directory (default: tmp/)
Idempotent: on re-entry (no --dispositions), the existing checkpoint is read and
live GitHub state is re-verified; a thread already replied with its commit's
evidence is never replied to twice, and a thread already resolved live is left
alone.
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
      dispositions: { type: "string" },
      "dispositions-file": { type: "string" },
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
    dispositions: undefined,
    dispositionsFile: undefined,
    tmpRoot: "tmp",
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
    if (token.name === "dispositions") {
      options.dispositions = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "dispositions-file") {
      const dispositionsFile = requireTokenValue(token, parseError).trim();
      if (dispositionsFile.length === 0) {
        throw parseError("--dispositions-file requires a non-empty path");
      }
      options.dispositionsFile = dispositionsFile;
      continue;
    }
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "headSha"].filter((k) => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  if (options.dispositions !== undefined && options.dispositionsFile !== undefined) {
    throw parseError("--dispositions and --dispositions-file are mutually exclusive; pass only one");
  }
  return options;
}

async function resolveDispositionsInput(options) {
  let raw;
  if (options.dispositionsFile !== undefined) {
    try {
      raw = await readFile(options.dispositionsFile, "utf8");
    } catch (error) {
      throw new Error(`Cannot read --dispositions-file "${options.dispositionsFile}": ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    raw = options.dispositions;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${options.dispositionsFile !== undefined ? "--dispositions-file" : "--dispositions"} must contain valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${options.dispositionsFile !== undefined ? "--dispositions-file" : "--dispositions"} must be a JSON array`);
  }
  return parsed;
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

async function loadOrWriteCheckpoint(options, fullPath, logPath) {
  if (options.dispositions !== undefined || options.dispositionsFile !== undefined) {
    const rawDispositions = await resolveDispositionsInput(options);
    const handoff = normalizeFixerDispositionHandoff({ headSha: options.headSha, dispositions: rawDispositions });
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
    return handoff;
  }
  let raw;
  try {
    raw = await readFile(fullPath, "utf8");
  } catch {
    throw new Error(
      `No fixer disposition handoff checkpoint found for head ${options.headSha} at ${logPath}; `
      + "supply --dispositions (or --dispositions-file) to record one",
    );
  }
  let parsedCheckpoint;
  try {
    parsedCheckpoint = JSON.parse(raw);
  } catch {
    throw new Error(`Fixer disposition checkpoint at ${logPath} is not valid JSON`);
  }
  return normalizeFixerDispositionHandoff(parsedCheckpoint);
}

export async function verifyFixerDisposition(
  options,
  { env = process.env, ghCommand = "gh", runChild, repoRoot = process.cwd() } = {},
) {
  const tmpRoot = options.tmpRoot || "tmp";
  const logPath = buildLogPath({ repo: options.repo, pr: options.pr, gate: "fixer-disposition", headSha: options.headSha, tmpRoot });
  const fullPath = path.resolve(repoRoot, logPath);
  const handoff = await loadOrWriteCheckpoint(options, fullPath, logPath);

  const runtime = { env, ghCommand, runChild };
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
