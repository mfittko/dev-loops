import { spawn } from "node:child_process";
import { isCopilotLogin, parseReviewThreads } from "../_core-helpers.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
export const MIN_DISMISSAL_REASON_LENGTH = 30;
export function hasCommitShaReference(text) {
  const trimmed = text.trim();
  const hexTokens = trimmed.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
  const hasHexLetterToken = hexTokens.some((token) => /[a-f]/i.test(token));
  const hasContextualNumericRef =
    /\b(?:fixed\s+in|commit|sha|rev(?:ision)?)\s+[0-9a-f]{7,40}\b/i.test(trimmed)
    || /\/commit\/[0-9a-f]{7,40}\b/i.test(trimmed);
  return hasHexLetterToken || hasContextualNumericRef;
}
export function validateResolutionMessage(body) {
  const trimmedBody = body.trim();
  const hasCommitSha = hasCommitShaReference(trimmedBody);
  const hasDismissalReason = trimmedBody.length >= MIN_DISMISSAL_REASON_LENGTH;
  if (!hasCommitSha && !hasDismissalReason) {
    throw new Error(
      `Reply body (${trimmedBody.length} characters after trimming) must contain either a commit SHA reference or a dismissal reason (at least ${MIN_DISMISSAL_REASON_LENGTH} characters after trimming). `
      + 'Bare acknowledgments like "Acknowledged." are not valid resolutions.',
    );
  }
  return {
    trimmedBody,
    hasCommitSha,
    hasDismissalReason,
  };
}
function runChildWithInput(command, args, env, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (stdinText === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdinText);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from gh: ${text.trim() || "<empty>"}`);
  }
}
export function parseReplyPayload(payload) {
  const replyId = payload?.id;
  const replyUrl = payload?.html_url;
  if (!Number.isFinite(replyId) || typeof replyUrl !== "string" || replyUrl.trim().length === 0) {
    throw new Error("Reply payload from gh did not include both id and html_url");
  }
  return {
    replyId,
    replyUrl,
  };
}
const RESOLVE_REVIEW_THREAD_MUTATION = [
  "mutation($threadId: ID!) {",
  "  resolveReviewThread(input: { threadId: $threadId }) {",
  "    thread {",
  "      id",
  "      isResolved",
  "    }",
  "  }",
  "}",
].join("\n");
export async function captureParsedReviewThreads(
  { repo, pr },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const payload = await fetchGithubReviewThreadsPayload({ repo, pr }, { env, ghCommand });
  return parseReviewThreads(payload);
}
export function assertReplyTargetFromSnapshot(parsed, { repo, pr, commentId, threadId }) {
  const targetCommentId = String(commentId);
  const thread = parsed.threads.find((entry) => entry.id === threadId) ?? null;
  const comment = parsed.comments.find((entry) => entry.databaseId === targetCommentId) ?? null;
  if (thread === null) {
    throw new Error(`Review thread ${threadId} was not found on pull request ${repo}#${pr}`);
  }
  if (comment === null) {
    throw new Error(`Review comment ${commentId} was not found on pull request ${repo}#${pr}`);
  }
  if (comment.threadId !== threadId) {
    throw new Error(`Review comment ${commentId} does not belong to review thread ${threadId} on pull request ${repo}#${pr}`);
  }
  return {
    thread,
    comment,
  };
}
export async function validateReplyTarget(
  { repo, pr, commentId, threadId },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const parsed = await captureParsedReviewThreads({ repo, pr }, { env, ghCommand });
  return {
    parsed,
    ...assertReplyTargetFromSnapshot(parsed, { repo, pr, commentId, threadId }),
  };
}
export async function postReply(
  { repo, pr, commentId, body },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const result = await runChildWithInput(
    ghCommand,
    [
      "api",
      "-X",
      "POST",
      `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`,
      "--input",
      "-",
    ],
    env,
    `${JSON.stringify({ body })}\n`,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJson(result.stdout);
}
export async function resolveThread(threadId, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChildWithInput(
    ghCommand,
    [
      "api",
      "graphql",
      "--field",
      `threadId=${threadId}`,
      "--field",
      `query=${RESOLVE_REVIEW_THREAD_MUTATION}`,
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJson(result.stdout);
  return payload?.data?.resolveReviewThread?.thread;
}
export async function replyAndMaybeResolve(
  {
    repo,
    pr,
    commentId,
    threadId,
    body,
    resolve = true,
    validatedSnapshot = null,
  },
  { env = process.env, ghCommand = "gh" } = {},
) {
  if (validatedSnapshot) {
    assertReplyTargetFromSnapshot(validatedSnapshot, { repo, pr, commentId, threadId });
  } else {
    await validateReplyTarget({ repo, pr, commentId, threadId }, { env, ghCommand });
  }
  const reply = parseReplyPayload(await postReply(
    {
      repo,
      pr,
      commentId,
      body,
    },
    { env, ghCommand },
  ));
  if (!resolve) {
    return {
      replyId: reply.replyId,
      replyUrl: reply.replyUrl,
      resolved: false,
    };
  }
  const resolvedThread = await resolveThread(threadId, { env, ghCommand });
  if (!resolvedThread?.isResolved) {
    throw new Error(`Review thread did not resolve successfully: ${threadId}`);
  }
  return {
    replyId: reply.replyId,
    replyUrl: reply.replyUrl,
    resolved: true,
  };
}
export function authorMatchesFilter(commentAuthorLogin, authorFilter) {
  const normalizedLogin = typeof commentAuthorLogin === "string" ? commentAuthorLogin.trim() : "";
  const normalizedFilter = typeof authorFilter === "string" ? authorFilter.trim() : "";
  if (normalizedLogin.length === 0 || normalizedFilter.length === 0) {
    return false;
  }
  if (normalizedFilter.toLowerCase() === "all") {
    return true;
  }
  if (normalizedFilter.toLowerCase() === "copilot") {
    return isCopilotLogin(normalizedLogin) || normalizedLogin.toLowerCase() === "copilot";
  }
  return normalizedLogin.toLowerCase() === normalizedFilter.toLowerCase();
}
