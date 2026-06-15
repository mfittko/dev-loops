#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { buildParseError, formatCliError, isCopilotLogin, isDirectCliRun, parseJsonText, parseReviewThreads } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "../../packages/core/src/github/repo-slug.mjs";
import {
  DEFAULT_POLL_INTERVAL_MS,
  COPILOT_REVIEW_WAIT_TIMEOUT_MS,
} from "../../packages/core/src/loop/policy-constants.mjs";

/** Maximum interval between heartbeat outputs during watch delays.
 *  Must be shorter than pi-subagents default needsAttentionAfterMs (60s). */
const WATCH_HEARTBEAT_MS = 45_000; // 45 seconds
const REMOVED_FLAGS = new Set([
  "--poll-interval-ms",
  "--timeout-ms",
]);
const USAGE = `Usage: probe-copilot-review.mjs --repo <owner/name> --pr <number>
Poll for fresh Copilot review activity on a GitHub pull request.
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --pr <number>                 Pull request number
Output (stdout, JSON):
  { "ok": true, "status": "changed"|"timeout"|"idle", "repo": "...", "pr": N, "attempts": N,
    "newComments": [...], "newReviews": [...], "newIssueComments": [...] }
Activity statuses:
  changed    Fresh Copilot review activity found (check newComments/newReviews/newIssueComments)
  timeout    Watch period elapsed with no fresh Copilot activity
  idle       Zero-timeout single check found no change
Diagnostic output (stderr):
  Progress/heartbeat (during watch):
    { "ok": true, "type": "watch_heartbeat", "elapsedMs": N, "totalBudgetMs": N, "poll": N, "maxPolls": N }
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
Exit codes:
  0  Success
  1  Argument error or gh failure`.trim();
const COPILOT_ACTIVITY_QUERY = [
  "query($owner: String!, $name: String!, $pr: Int!) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $pr) {",
  "      reviewThreads(first: 100) {",
  "        nodes {",
  "          id",
  "          isResolved",
  "          comments(first: 100) {",
  "            nodes {",
  "              id",
  "              body",
  "              author {",
  "                login",
  "                __typename",
  "              }",
  "            }",
  "          }",
  "        }",
  "      }",
  "      reviews(first: 100) {",
  "        nodes {",
  "          id",
  "          body",
  "          author {",
  "            login",
  "            __typename",
  "          }",
  "        }",
  "      }",
  "      comments(first: 100) {",
  "        nodes {",
  "          id",
  "          body",
  "          author {",
  "            login",
  "            __typename",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");
const parseError = buildParseError(USAGE);
function rejectRemovedFlag(token) {
  throw parseError(
    `${token} has been removed. Poll interval and timeout are centralized policy constants. Omit the flag.`,
  );
}
export function parseWatchCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: COPILOT_REVIEW_WAIT_TIMEOUT_MS,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (REMOVED_FLAGS.has(token)) {
      rejectRemovedFlag(token);
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePositiveInteger(requireOptionValue(args, "--pr", parseError), "--pr", parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Watching Copilot review requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
async function fetchGithubCopilotActivityPayload(
  { repo, pr },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const result = await runChild(
    ghCommand,
    [
      "api",
      "graphql",
      "--field",
      `owner=${owner}`,
      "--field",
      `name=${name}`,
      "--field",
      `pr=${pr}`,
      "--field",
      `query=${COPILOT_ACTIVITY_QUERY}`,
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout);
}
function normalizeAuthorLogin(author) {
  return typeof author?.login === "string" ? author.login : "";
}
function normalizeBody(body) {
  return typeof body === "string" ? body.trim() : "";
}
function extractCopilotReviews(payload) {
  const reviews = payload?.data?.repository?.pullRequest?.reviews?.nodes;
  if (!Array.isArray(reviews)) {
    return [];
  }
  return reviews
    .filter((review) => isCopilotLogin(normalizeAuthorLogin(review?.author)))
    .map((review) => ({
      id: String(review?.id ?? ""),
      authorLogin: normalizeAuthorLogin(review?.author),
      body: normalizeBody(review?.body),
    }))
    .filter((review) => review.id.length > 0);
}
function extractCopilotIssueComments(payload) {
  const comments = payload?.data?.repository?.pullRequest?.comments?.nodes;
  if (!Array.isArray(comments)) {
    return [];
  }
  return comments
    .filter((comment) => isCopilotLogin(normalizeAuthorLogin(comment?.author)))
    .map((comment) => ({
      id: String(comment?.id ?? ""),
      authorLogin: normalizeAuthorLogin(comment?.author),
      body: normalizeBody(comment?.body),
    }))
    .filter((comment) => comment.id.length > 0);
}
function parseCopilotActivity(payload) {
  const parsedThreads = parseReviewThreads(payload);
  const newComments = (parsedThreads?.comments ?? [])
    .filter((comment) => isCopilotLogin(comment.author?.login))
    .map((comment) => ({
      id: comment.id,
      threadId: comment.threadId,
      authorLogin: comment.author?.login ?? "",
      body: comment.body,
    }));
  return {
    reviewThreadComments: newComments,
    reviews: extractCopilotReviews(payload),
    issueComments: extractCopilotIssueComments(payload),
  };
}
export function findFreshCopilotActivity(baseline, current) {
  const baselineCommentIds = new Set((baseline?.reviewThreadComments ?? []).map((comment) => comment.id));
  const baselineReviewIds = new Set((baseline?.reviews ?? []).map((review) => review.id));
  const baselineIssueCommentIds = new Set((baseline?.issueComments ?? []).map((comment) => comment.id));
  return {
    newComments: (current?.reviewThreadComments ?? []).filter((comment) => !baselineCommentIds.has(comment.id)),
    newReviews: (current?.reviews ?? []).filter((review) => !baselineReviewIds.has(review.id)),
    newIssueComments: (current?.issueComments ?? []).filter((comment) => !baselineIssueCommentIds.has(comment.id)),
  };
}
function buildNoChangePayload(status, repo, pr, attempts) {
  return {
    ok: true,
    status,
    repo,
    pr,
    attempts,
    newComments: [],
    newReviews: [],
    newIssueComments: [],
  };
}
export async function watchCopilotReview(
  options,
  {
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const baseline = parseCopilotActivity(await fetchGithubCopilotActivityPayload(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  ));
  const attemptBudget = buildAttemptBudget(options.timeoutMs, options.pollIntervalMs);
  const watchStartedAtMs = Date.now();
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    if (!(options.timeoutMs === 0 && attempt === 1)) {
      const pollDelayMs = buildPollDelayMs(
        watchStartedAtMs,
        options.timeoutMs,
        options.pollIntervalMs,
        attempt,
      );
      if (pollDelayMs > 0) {
        let remainingMs = pollDelayMs;
        while (remainingMs > 0) {
          const chunkMs = Math.min(WATCH_HEARTBEAT_MS, remainingMs);
          await delay(chunkMs);
          remainingMs -= chunkMs;
          if (remainingMs > 0) {
            const nowMs = Date.now();
            process.stderr.write(
              JSON.stringify({
                ok: true,
                type: "watch_heartbeat",
                elapsedMs: nowMs - watchStartedAtMs,
                totalBudgetMs: options.timeoutMs,
                poll: attempt,
                maxPolls: attemptBudget,
              }) + "\n",
            );
          }
        }
      }
    }
    const current = parseCopilotActivity(await fetchGithubCopilotActivityPayload(
      { repo: options.repo, pr: options.pr },
      { env, ghCommand },
    ));
    const activity = findFreshCopilotActivity(baseline, current);
    if (activity.newComments.length > 0 || activity.newReviews.length > 0 || activity.newIssueComments.length > 0) {
      return {
        ok: true,
        status: "changed",
        repo: options.repo,
        pr: options.pr,
        attempts: attempt,
        ...activity,
      };
    }
  }
  const status = options.timeoutMs === 0 ? "idle" : "timeout";
  return buildNoChangePayload(status, options.repo, options.pr, attemptBudget);
}
export function buildAttemptBudget(timeoutMs, pollIntervalMs) {
  if (timeoutMs === 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
}
export function buildPollDelayMs(watchStartedAtMs, timeoutMs, pollIntervalMs, attempt, nowMs = Date.now()) {
  if (timeoutMs === 0) {
    return 0;
  }
  const scheduledAtMs = watchStartedAtMs + Math.min(timeoutMs, attempt * pollIntervalMs);
  return Math.max(0, scheduledAtMs - nowMs);
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseWatchCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await watchCopilotReview(options, { env, ghCommand });
  stdout.write(`${JSON.stringify(result)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
