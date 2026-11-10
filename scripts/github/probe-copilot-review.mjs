#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText, parseReviewThreads } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { capWait, pendingFields, resolveTimeoutMs, scriptCommand } from "../lib/timeout-flag.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { isSanctionedCopilotReviewerLogin, isTrustedGraphqlComment } from "@dev-loops/core/github/comment-trust";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  DEFAULT_POLL_INTERVAL_MS,
  COPILOT_REVIEW_WAIT_TIMEOUT_MS,
} from "@dev-loops/core/loop/policy-constants";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import { waitWithHeartbeat } from "./_watch-heartbeat.mjs";

const REMOVED_FLAGS = new Set([
  "--poll-interval-ms",
]);
const USAGE = `Usage: probe-copilot-review.mjs --repo <owner/name> --pr <number> [--timeout <seconds>]
Poll for fresh Copilot review activity on a GitHub pull request.
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --pr <number>                 Pull request number
Options:
  --timeout-ms <n>              Deprecated alias for --timeout (milliseconds); warns on stderr.
                                Passing both flags fails closed.
  --timeout <seconds>           Total watch budget in seconds (default ${COPILOT_REVIEW_WAIT_TIMEOUT_MS / 1000}, i.e. ${COPILOT_REVIEW_WAIT_TIMEOUT_MS / 60_000} min;
                                0 = single immediate check, no wait — returns "idle" if
                                no fresh activity). For a quick non-watch thread/state
                                read without entering the watch loop, pass 0 here or use
                                'dev-loops gate capture-threads'.
One call waits at most 170 seconds (GATE-EXEC-BOUNDED-WAIT-CAP); a longer --timeout returns
"timeout" with outcome "pending" and a "reissue" command (carrying the internal --baseline-ids
and the remaining --timeout); run it. --concise prints the outcome and the reissue line too.
Output (stdout, JSON):
  { "ok": true, "status": "changed"|"timeout"|"idle", "repo": "...", "pr": N, "attempts": N,
    "newComments": [...], "newReviews": [...], "newIssueComments": [...] }
Concise mode:
  --concise, --summary      Human-readable summary: status, attempts, new-activity
                            counts, AND the current round's new Copilot comment bodies.
${JQ_OUTPUT_USAGE}
Activity statuses:
  changed    Fresh Copilot review activity found (check newComments/newReviews/newIssueComments)
  timeout    Watch period elapsed with no fresh Copilot activity
  idle       Zero-timeout (--timeout 0) single check found no change
Diagnostic output (stderr):
  Progress/heartbeat (during watch, --timeout > 0):
    { "ok": true, "type": "watch_heartbeat", "elapsedMs": N, "totalBudgetMs": N, "poll": N, "maxPolls": N }
  Heartbeat contract: watch-shaped runs (--timeout > 0) emit watch_heartbeat lines to
    stderr roughly every 45s as a liveness signal. Agents MUST NOT suppress stderr
    (e.g. 2>/dev/null) on watch-shaped invocations — suppressing heartbeats makes a
    legitimate watch look like a stall. Use --timeout 0 for a non-watch single check.
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
  "              authorAssociation",
  "              viewerDidAuthor",
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
  "          authorAssociation",
  "          viewerDidAuthor",
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
  "          authorAssociation",
  "          viewerDidAuthor",
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
const BASELINE_KINDS = ["reviewThreadComments", "reviews", "issueComments"];
function rejectRemovedFlag(token) {
  throw parseError(
    `${token} has been removed. The poll interval is a centralized policy constant. Omit the flag.`,
  );
}
export function parseWatchCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      timeout: { type: "string" },
      "timeout-ms": { type: "string" },
      concise: { type: "boolean" },
      summary: { type: "boolean" },
      "baseline-ids": { type: "string" },
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
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: COPILOT_REVIEW_WAIT_TIMEOUT_MS,
    concise: false,
    jq: undefined,
    silent: false,
  };
  const rawTimeout = {};
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
    if (REMOVED_FLAGS.has(token.rawName)) {
      rejectRemovedFlag(token.rawName);
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInteger(requireTokenValue(token, parseError), "--pr", parseError);
      continue;
    }
    if (token.name === "timeout" || token.name === "timeout-ms") {
      rawTimeout[token.name === "timeout" ? "timeout" : "timeoutMs"] = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "concise" || token.name === "summary") {
      options.concise = true;
      continue;
    }
    if (token.name === "baseline-ids") {
      // Internal: a re-issued capped wait carries the first call's baseline activity ids.
      try {
        const ids = JSON.parse(requireTokenValue(token, parseError));
        options.baseline = Object.fromEntries(BASELINE_KINDS.map((kind) => [kind, ids[kind].map((id) => {
          if (typeof id !== "string" || id === "") throw new TypeError("baseline id must be a non-empty string");
          return { id };
        })]));
      } catch {
        throw parseError(`--baseline-ids must be a JSON object of id arrays (${BASELINE_KINDS.join(", ")})`);
      }
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  try {
    options.timeoutMs = resolveTimeoutMs(rawTimeout) ?? options.timeoutMs;
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
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
    .filter((review) => isSanctionedCopilotReviewerLogin(normalizeAuthorLogin(review?.author)) && isTrustedGraphqlComment(review, { allowCopilot: true }))
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
    .filter((comment) => isSanctionedCopilotReviewerLogin(normalizeAuthorLogin(comment?.author)) && isTrustedGraphqlComment(comment, { allowCopilot: true }))
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
    .filter((comment) => isSanctionedCopilotReviewerLogin(comment.author?.login) && comment.trusted === true)
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
    delayImpl = delay,
    now = Date.now,
    ensureOwnershipImpl = ensureAsyncRunnerOwnership,
    onBaseline = undefined,
  } = {},
) {
  const leaseCwd = resolveRepoRoot(process.cwd());
  // options.baseline lets a re-issued capped wait keep the first call's baseline, so activity between calls is reported.
  const baseline = options.baseline ?? parseCopilotActivity(await fetchGithubCopilotActivityPayload(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand },
  ));
  onBaseline?.(baseline);
  const attemptBudget = buildAttemptBudget(options.timeoutMs, options.pollIntervalMs);
  const watchStartedAtMs = now();
  for (let attempt = 1; attempt <= attemptBudget; attempt += 1) {
    if (!(options.timeoutMs === 0 && attempt === 1)) {
      const pollDelayMs = buildPollDelayMs(
        watchStartedAtMs,
        options.timeoutMs,
        options.pollIntervalMs,
        attempt,
        now(),
      );
      await waitWithHeartbeat(pollDelayMs, {
        attempt,
        attemptBudget,
        watchStartedAtMs,
        timeoutMs: options.timeoutMs,
        now,
        delayImpl,
        // The blocking review wait can span the full watch budget, which equals
        // the runner-coordination stale window; refresh the lease alongside each
        // heartbeat so the claim stays fresh for every caller of this engine.
        // No-ops without DEVLOOPS_RUN_ID; waitWithHeartbeat swallows any throw,
        // so a lease-refresh failure here never affects the watch.
        onHeartbeat: () =>
          ensureOwnershipImpl({
            repo: options.repo,
            pr: options.pr,
            env,
            cwd: leaseCwd,
            claimIfMissing: true,
            requireExisting: false,
          }),
      });
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
// Human-readable concise summary of a probe result, including the current
// round's new Copilot comment bodies (the field `loop info --pr` omits).
export function formatProbeConcise(result) {
  const newComments = result.newComments ?? [];
  const newReviews = result.newReviews ?? [];
  const newIssueComments = result.newIssueComments ?? [];
  const lines = [
    `Copilot probe: PR #${result.pr} (${result.repo})`,
    `  status:        ${result.status}`,
    `  attempts:      ${result.attempts}`,
    ...(result.outcome === undefined ? [] : [`  outcome:       ${result.outcome} (${result.remainingTimeoutSeconds} s left)`, `  reissue:       ${result.reissue}`]),
    `  new threadComments: ${newComments.length}`,
    `  new reviews:        ${newReviews.length}`,
    `  new issueComments:  ${newIssueComments.length}`,
  ];
  const bodies = [
    ...newReviews.map((r) => ({ kind: "review", body: r.body })),
    ...newComments.map((c) => ({ kind: "threadComment", body: c.body })),
    ...newIssueComments.map((c) => ({ kind: "issueComment", body: c.body })),
  ].filter((entry) => typeof entry.body === "string" && entry.body.trim().length > 0);
  if (bodies.length > 0) {
    lines.push("  new Copilot comment bodies this round:");
    for (const entry of bodies) {
      const indented = entry.body.trim().split("\n").map((l) => `      ${l}`).join("\n");
      lines.push(`    [${entry.kind}]`);
      lines.push(indented);
    }
  } else {
    lines.push("  new Copilot comment bodies this round: (none)");
  }
  return lines.join("\n");
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
    ...watchDeps
  } = {},
) {
  const requested = parseWatchCliArgs(argv);
  if (requested.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  // GATE-EXEC-BOUNDED-WAIT-CAP: one call waits at most the cap; a longer request returns a pending result.
  const { timeoutMs, remainingMs } = capWait(requested.timeoutMs);
  const options = { ...requested, timeoutMs };
  let baseline;
  let result = await watchCopilotReview(options, { env, ghCommand, ...watchDeps, onBaseline: (b) => { baseline = b; } });
  if (result.status === "timeout" && remainingMs > 0) {
    const ids = Object.fromEntries(BASELINE_KINDS.map((kind) => [kind, baseline[kind].map((item) => item.id)]));
    result = { ...result, ...pendingFields({ remainingMs, command: scriptCommand(import.meta.url), argv, carry: { "--baseline-ids": JSON.stringify(ids) } }) };
  }
  if (options.concise && options.jq === undefined && !options.silent) {
    stdout.write(`${formatProbeConcise(result)}\n`);
    return result.ok === false ? 1 : 0;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  }).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
