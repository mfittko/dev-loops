#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import {
  parsePrNumber,
  requireTokenValue,
} from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  authorMatchesFilter,
  captureParsedReviewThreads,
  replyAndMaybeResolve,
  validateResolutionMessage,
} from "./_review-thread-mutations.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const USAGE = `Usage: reply-resolve-review-threads.mjs --repo <owner/name> --pr <number> [--author <login>] ((--message <text> | stdin) | --message-map <path>) [--resolve]
Reply to all matching unresolved review threads on one PR and optionally resolve them.
A message source is always required, in one of two mutually exclusive modes:
  - single shared body for every matched thread: --message <text>, or the same text piped
    via stdin (exactly one of the two, never both)
  - per-thread bodies: --message-map <path> — stdin is never read in this mode
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --author <login>      Match threads containing a comment from this author (default: all)
  --message <text>      Shared reply body text for every matched thread; provide exactly one
                        message source via --message or stdin (not both). Mutually exclusive
                        with --message-map.
  --message-map <path>  JSON file mapping threadId -> distinct reply body for that thread. Every
                        matched thread must have an entry here, or the run fails closed (listing
                        the unmapped thread ids) before any reply or resolve mutation is sent.
                        Stdin is never read in this mode: the map is the complete message source.
                        Mutually exclusive with --message.
  --resolve             Resolve each matched thread after the reply succeeds
Output (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": 17, "author": "all", "resolve": true,
    "matchedThreadCount": 2, "repliedThreadCount": 2, "resolvedThreadCount": 2,
    "skippedThreadCount": 1, "results": [{ ... }] }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  Runtime/gh failures:
    { "ok": false, "error": "...", "partialProgress"?: { ... } }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh/runtime failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
export function parseReplyResolveThreadsCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      author: { type: "string" },
      message: { type: "string" },
      "message-map": { type: "string" },
      resolve: { type: "boolean" },
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
    author: "all",
    message: undefined,
    messageMap: undefined,
    resolve: false,
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
    if (token.name === "author") {
      options.author = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "message") {
      options.message = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "message-map") {
      const messageMap = requireTokenValue(token, parseError).trim();
      if (messageMap.length === 0) {
        throw parseError("--message-map requires a non-empty path");
      }
      options.messageMap = messageMap;
      continue;
    }
    if (token.name === "resolve") {
      options.resolve = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Replying and resolving review threads requires both --repo <owner/name> and --pr <number>");
  }
  if (options.author.length === 0) {
    throw parseError("--author must contain non-empty text");
  }
  if (options.message !== undefined && options.messageMap !== undefined) {
    throw parseError("--message and --message-map are mutually exclusive; pass only one");
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
// When --message is set, stdin is read only to detect a conflicting second
// message source. A detached/idle pipe never sends EOF, so an unbounded read
// hangs forever and the process never exits (issue #1012). Resolve as soon as
// any NON-WHITESPACE byte arrives (a conflicting body is detected the instant
// real content appears — no need to wait for EOF); keep buffering while only
// whitespace has arrived (a leading newline is not yet a conflict and more may
// follow); resolve on natural EOF; and time out on a silent/idle pipe. Either
// way the stdin handle is released so the event loop can drain and the tool
// always terminates.
const CONFLICT_STDIN_TIMEOUT_MS = 500;
function readStdinConflictProbe(stdin, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      stdin.off?.("data", onData);
      stdin.off?.("end", onEnd);
      stdin.off?.("error", onEnd);
      // Release the handle: an abandoned reader on a still-open pipe would
      // otherwise keep the event loop alive and re-introduce the hang.
      stdin.pause?.();
      if (typeof stdin.unref === "function") {
        stdin.unref();
      } else {
        stdin.destroy?.();
      }
    };
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    // Resolve early only once non-whitespace content is seen (a real conflict);
    // '' or whitespace-only on clean EOF is not a conflict; undefined only on
    // timeout (idle pipe) so the caller proceeds with --message.
    let text = "";
    const onData = (chunk) => {
      text += String(chunk);
      if (text.trim().length > 0) {
        finish(text);
      }
    };
    const onEnd = () => finish(text);
    timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref?.();
    stdin.setEncoding?.("utf8");
    stdin.on?.("data", onData);
    stdin.on?.("end", onEnd);
    stdin.on?.("error", onEnd);
  });
}

// Returns undefined in --message-map mode: the map is the complete message
// source for every matched thread (the coverage check, run after capture,
// fails closed on any matched thread the map does not cover), and stdin is
// never read or probed in that mode. --message and --message-map are already
// mutually exclusive by the time this runs (parseReplyResolveThreadsCliArgs),
// so the --message branch below never sees a map alongside it.
async function resolveMessageInput(options, { stdin = process.stdin } = {}) {
  if (typeof options.message === "string") {
    if (stdin.isTTY) {
      if (options.message.trim().length === 0) {
        throw parseError("Reply message must contain non-empty text");
      }
      return options.message;
    }
    const stdinText = await readStdinConflictProbe(stdin, CONFLICT_STDIN_TIMEOUT_MS);
    if (typeof stdinText === "string" && stdinText.trim().length > 0) {
      throw parseError("Choose exactly one message source: --message <text> or stdin");
    }
    if (options.message.trim().length === 0) {
      throw parseError("Reply message must contain non-empty text");
    }
    return options.message;
  }
  if (options.messageMap !== undefined) {
    return undefined;
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
async function loadMessageMap(mapPath) {
  let raw;
  try {
    raw = await readFile(mapPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read --message-map "${mapPath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--message-map "${mapPath}" must contain valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--message-map "${mapPath}" must contain a JSON object mapping threadId to reply body`);
  }
  for (const [threadId, body] of Object.entries(parsed)) {
    if (typeof body !== "string") {
      throw new Error(`--message-map "${mapPath}" entry "${threadId}" must be a string reply body`);
    }
    validateResolutionMessage(body);
  }
  return parsed;
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
// Single predicate for "does this messageMap carry an entry for this thread",
// shared by the coverage check and the body-selection lookup in runCli below
// (both need the exact same hasOwnProperty test against a possibly-null map).
function hasMessageMapEntry(messageMap, threadId) {
  return messageMap !== null && Object.prototype.hasOwnProperty.call(messageMap, threadId);
}
export function planBatchReplyTargets(parsed, author) {
  const eligibleThreads = parsed.threads.filter((thread) => !thread.isResolved);
  const matchedTargets = [];
  let skippedThreadCount = 0;
  for (const thread of eligibleThreads) {
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
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseReplyResolveThreadsCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const messageMap = options.messageMap === undefined ? null : await loadMessageMap(options.messageMap);
  const message = await resolveMessageInput(options, { stdin });
  if (typeof message === "string") {
    validateResolutionMessage(message);
  }
  const parsed = await captureParsedReviewThreads(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  );
  const { matchedTargets, skippedThreadCount } = planBatchReplyTargets(parsed, options.author);
  if (messageMap !== null) {
    // Pure --message-map mode: every matched thread MUST have an entry, or the
    // run fails closed before any reply/resolve mutation is sent — there is no
    // --message fallback for an unmapped thread.
    const unmappedThreadIds = matchedTargets
      .map((target) => target.threadId)
      .filter((threadId) => !hasMessageMapEntry(messageMap, threadId));
    if (unmappedThreadIds.length > 0) {
      throw new Error(
        `--message-map is missing an entry for ${unmappedThreadIds.length} matched thread(s): ${unmappedThreadIds.join(", ")}`,
      );
    }
  }
  const resolveBodyForThread = (threadId) => (
    hasMessageMapEntry(messageMap, threadId) ? messageMap[threadId] : message
  );
  if (matchedTargets.length === 0) {
    process.exitCode = emitResult(createSuccessPayload({
      repo: options.repo,
      pr: options.pr,
      author: options.author,
      resolve: options.resolve,
      matchedThreadCount: 0,
      repliedThreadCount: 0,
      resolvedThreadCount: 0,
      skippedThreadCount,
      results: [],
    }), { jq: options.jq, silent: options.silent, stdout, stderr });
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
          body: resolveBodyForThread(target.threadId),
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
  process.exitCode = emitResult(createSuccessPayload({
    repo: options.repo,
    pr: options.pr,
    author: options.author,
    resolve: options.resolve,
    matchedThreadCount: matchedTargets.length,
    repliedThreadCount,
    resolvedThreadCount,
    skippedThreadCount,
    results,
  }), { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${JSON.stringify(toCliFailurePayload(error))}\n`);
    process.exitCode = 1;
  });
}
