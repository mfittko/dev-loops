#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import {
  parsePrNumber,
  requireOptionValue,
} from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  authorMatchesFilter,
  captureParsedReviewThreads,
  replyAndMaybeResolve,
  validateResolutionMessage,
} from "./_review-thread-mutations.mjs";
const USAGE = `Usage: reply-resolve-review-threads.mjs --repo <owner/name> --pr <number> [--author <login>] [--message <text>] [--resolve]
Reply to all matching unresolved review threads on one PR and optionally resolve them.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --author <login>      Match threads containing a comment from this author (default: Copilot)
  --message <text>      Reply body text; provide exactly one message source via --message or stdin
  --resolve             Resolve each matched thread after the reply succeeds
Output (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": 17, "author": "Copilot", "resolve": true,
    "matchedThreadCount": 2, "repliedThreadCount": 2, "resolvedThreadCount": 2,
    "skippedThreadCount": 1, "results": [{ ... }] }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  Runtime/gh failures:
    { "ok": false, "error": "...", "partialProgress"?: { ... } }
Exit codes:
  0  Success
  1  Argument error or gh/runtime failure`.trim();
const parseError = buildParseError(USAGE);
export function parseReplyResolveThreadsCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    author: "Copilot",
    message: undefined,
    resolve: false,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    if (token === "--author") {
      options.author = requireOptionValue(args, "--author", parseError).trim();
      continue;
    }
    if (token === "--message") {
      options.message = requireOptionValue(args, "--message", parseError);
      continue;
    }
    if (token === "--resolve") {
      options.resolve = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Replying and resolving review threads requires both --repo <owner/name> and --pr <number>");
  }
  if (options.author.length === 0) {
    throw parseError("--author must contain non-empty text");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
async function readStdinText(stdin) {
  let text = "";
  stdin.setEncoding?.("utf8");
  for await (const chunk of stdin) {
    text += chunk;
  }
  return text;
}
async function resolveMessageInput(options, { stdin = process.stdin } = {}) {
  if (typeof options.message === "string") {
    if (stdin.isTTY) {
      if (options.message.trim().length === 0) {
        throw parseError("Reply message must contain non-empty text");
      }
      return options.message;
    }
    const stdinText = await readStdinText(stdin);
    if (stdinText.trim().length > 0) {
      throw parseError("Choose exactly one message source: --message <text> or stdin");
    }
    if (options.message.trim().length === 0) {
      throw parseError("Reply message must contain non-empty text");
    }
    return options.message;
  }
  if (stdin.isTTY) {
    throw parseError("Choose exactly one message source: --message <text> or stdin");
  }
  const stdinText = await readStdinText(stdin);
  if (stdinText.trim().length === 0) {
    throw parseError("Reply message must contain non-empty text");
  }
  return stdinText;
}
function commentRecencyValue(comment) {
  if (typeof comment?.databaseId === "string" && /^\d+$/.test(comment.databaseId)) {
    return Number(comment.databaseId);
  }
  return Number.NaN;
}
function selectNewestMatchingComment(parsed, threadId, author) {
  const candidates = parsed.comments.filter((comment) => (
    comment.threadId === threadId
    && authorMatchesFilter(comment.author?.login, author)
  ));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((latest, comment) => {
    if (latest === null) {
      return comment;
    }
    const latestRecency = commentRecencyValue(latest);
    const commentRecency = commentRecencyValue(comment);
    if (Number.isFinite(latestRecency) && Number.isFinite(commentRecency) && commentRecency !== latestRecency) {
      return commentRecency > latestRecency ? comment : latest;
    }
    if (!Number.isFinite(latestRecency) && Number.isFinite(commentRecency)) {
      return comment;
    }
    if (comment.id.localeCompare(latest.id, undefined, { numeric: true }) > 0) {
      return comment;
    }
    return latest;
  }, null);
}
export function planBatchReplyTargets(parsed, author) {
  const unresolvedThreads = parsed.threads.filter((thread) => !thread.isResolved);
  const matchedTargets = [];
  let skippedThreadCount = 0;
  for (const thread of unresolvedThreads) {
    const comment = selectNewestMatchingComment(parsed, thread.id, author);
    if (comment === null) {
      skippedThreadCount += 1;
      continue;
    }
    if (typeof comment.databaseId !== "string" || !/^\d+$/.test(comment.databaseId)) {
      throw new Error(`Matched review thread ${thread.id} did not include a REST-safe numeric comment id for the newest ${author} comment`);
    }
    matchedTargets.push({
      threadId: thread.id,
      commentId: Number(comment.databaseId),
    });
  }
  return {
    matchedTargets,
    skippedThreadCount,
  };
}
function createSuccessPayload({ repo, pr, author, resolve, matchedThreadCount, repliedThreadCount, resolvedThreadCount, skippedThreadCount, results }) {
  return {
    ok: true,
    repo,
    pr,
    author,
    resolve,
    matchedThreadCount,
    repliedThreadCount,
    resolvedThreadCount,
    skippedThreadCount,
    results,
  };
}
function buildPartialProgress({ repo, pr, author, resolve, matchedThreadCount, skippedThreadCount, results }) {
  const resolvedThreadCount = results.filter((entry) => entry.resolved).length;
  return {
    repo,
    pr,
    author,
    resolve,
    matchedThreadCount,
    repliedThreadCount: results.length,
    resolvedThreadCount,
    skippedThreadCount,
    results,
  };
}
function toCliFailurePayload(error) {
  const payload = JSON.parse(formatCliError(error));
  if (error instanceof Error && error.partialProgress) {
    payload.partialProgress = error.partialProgress;
  }
  return payload;
}
function attachPartialProgress(error, partialProgress) {
  if (error instanceof Error) {
    error.partialProgress = partialProgress;
    return error;
  }
  const wrapped = new Error(String(error));
  wrapped.partialProgress = partialProgress;
  return wrapped;
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdin = process.stdin,
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseReplyResolveThreadsCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const message = await resolveMessageInput(options, { stdin });
  validateResolutionMessage(message);
  const parsed = await captureParsedReviewThreads(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  );
  const { matchedTargets, skippedThreadCount } = planBatchReplyTargets(parsed, options.author);
  if (matchedTargets.length === 0) {
    stdout.write(`${JSON.stringify(createSuccessPayload({
      repo: options.repo,
      pr: options.pr,
      author: options.author,
      resolve: options.resolve,
      matchedThreadCount: 0,
      repliedThreadCount: 0,
      resolvedThreadCount: 0,
      skippedThreadCount,
      results: [],
    }))}\n`);
    return;
  }
  const results = [];
  const partialBase = {
    repo: options.repo,
    pr: options.pr,
    author: options.author,
    resolve: options.resolve,
    matchedThreadCount: matchedTargets.length,
    skippedThreadCount,
  };
  try {
    for (const target of matchedTargets) {
      const result = await replyAndMaybeResolve(
        {
          repo: options.repo,
          pr: options.pr,
          commentId: target.commentId,
          threadId: target.threadId,
          body: message,
          resolve: options.resolve,
          validatedSnapshot: parsed,
        },
        { env, ghCommand },
      );
      results.push({
        threadId: target.threadId,
        commentId: target.commentId,
        replyId: result.replyId,
        replyUrl: result.replyUrl,
        resolved: result.resolved,
      });
    }
    if (options.resolve) {
      const refreshed = await captureParsedReviewThreads(
        { repo: options.repo, pr: options.pr },
        { env, ghCommand },
      );
      const stillUnresolvedThreadIds = matchedTargets
        .map((target) => target.threadId)
        .filter((threadId) => refreshed.threads.some((thread) => thread.id === threadId && !thread.isResolved));
      if (stillUnresolvedThreadIds.length > 0) {
        throw attachPartialProgress(
          new Error(`Post-resolve verification failed; targeted thread(s) remain unresolved: ${stillUnresolvedThreadIds.join(", ")}`),
          {
            ...buildPartialProgress({ ...partialBase, results }),
            stillUnresolvedThreadIds,
          },
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.partialProgress) {
      throw error;
    }
    throw attachPartialProgress(error, buildPartialProgress({ ...partialBase, results }));
  }
  const repliedThreadCount = results.length;
  const resolvedThreadCount = results.filter((entry) => entry.resolved).length;
  stdout.write(`${JSON.stringify(createSuccessPayload({
    repo: options.repo,
    pr: options.pr,
    author: options.author,
    resolve: options.resolve,
    matchedThreadCount: matchedTargets.length,
    repliedThreadCount,
    resolvedThreadCount,
    skippedThreadCount,
    results,
  }))}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${JSON.stringify(toCliFailurePayload(error))}\n`);
    process.exitCode = 1;
  });
}
