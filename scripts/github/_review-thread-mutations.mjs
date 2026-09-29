import { spawn } from "node:child_process";
import { isCopilotLogin, parseReviewThreads, sanitizeCopilotSummonTokens } from "../_core-helpers.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { guardCommentBodyNoIssuePrIds } from "@dev-loops/core/github/comment-id-guard";
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
const FULL_SHA_PATTERN = /\b[0-9a-f]{40}\b/gi;
// A reply that cites a commit claims a fix. Such a reply must carry a full
// 40-character SHA that the PR head contains, so the disposition verifier can
// match it later. The check runs before any post or resolve.
export async function assertFixedReplyShas(
  bodies,
  { repo, pr },
  { env = process.env, ghCommand = "gh", runChild = runChildWithInput } = {},
) {
  const claims = bodies.filter((body) => hasCommitShaReference(body));
  if (claims.length === 0) return;
  const view = await runChild(ghCommand, ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"], env);
  let head = null;
  try { head = JSON.parse(view.stdout).headRefOid; } catch { /* handled below */ }
  if (view.code !== 0 || typeof head !== "string" || head.length === 0) {
    throw new Error(`Cannot read the head commit of ${repo}#${pr} to check the fixed reply SHA`);
  }
  for (const body of claims) {
    const fullShas = body.match(FULL_SHA_PATTERN) ?? [];
    if (fullShas.length === 0) {
      throw new Error(
        `fixed_reply_missing_full_sha: a fixed reply must contain the full 40-character fixing commit SHA. Repeat the call with the full SHA of the fixing commit, currently ${head}.`,
      );
    }
    let contained = false;
    for (const sha of fullShas) {
      const result = await runChild("git", ["merge-base", "--is-ancestor", sha, head], env);
      if (result.code === 0) { contained = true; break; }
    }
    if (!contained) {
      throw new Error(
        `fixed_reply_sha_not_in_head: no 40-character SHA in the fixed reply is contained in the PR head ${head}. Use the full SHA of the fixing commit.`,
      );
    }
  }
}
export function runChildWithInput(command, args, env, stdinText) {
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
  { env = process.env, ghCommand = "gh", runChild } = {},
) {
  const payload = await fetchGithubReviewThreadsPayload({ repo, pr }, { env, ghCommand, runChild });
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
  { env = process.env, ghCommand = "gh", runChild } = {},
) {
  const parsed = await captureParsedReviewThreads({ repo, pr }, { env, ghCommand, runChild });
  return {
    parsed,
    ...assertReplyTargetFromSnapshot(parsed, { repo, pr, commentId, threadId }),
  };
}
export async function postReply(
  { repo, pr, commentId, body },
  { env = process.env, ghCommand = "gh", runChild = runChildWithInput } = {},
) {
  const result = await runChild(
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
export async function resolveThread(threadId, { env = process.env, ghCommand = "gh", runChild = runChildWithInput } = {}) {
  const result = await runChild(
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
    allowedRefs = [],
  },
  { env = process.env, ghCommand = "gh", runChild } = {},
) {
  if (validatedSnapshot) {
    assertReplyTargetFromSnapshot(validatedSnapshot, { repo, pr, commentId, threadId });
  } else {
    await validateReplyTarget({ repo, pr, commentId, threadId }, { env, ghCommand, runChild });
  }
  // Neutralize any bare @copilot/`/copilot`* tokens the reply text quotes (e.g.
  // a dismissal reason citing the anti-summon rule) so posting this reply can
  // never arm request-copilot-review.mjs's anti-summon guard.
  const reply = parseReplyPayload(await postReply(
    {
      repo,
      pr,
      commentId,
      // ISSUE/PR-ID GUARD (#1731): a generated review-thread reply must never
      // emit a raw issue/PR id (fail-closed unless explicitly allowlisted).
      body: guardCommentBodyNoIssuePrIds(sanitizeCopilotSummonTokens(body), {
        ref: "review-thread reply body",
        allowedRefs,
      }),
    },
    { env, ghCommand, runChild },
  ));
  if (!resolve) {
    return {
      replyId: reply.replyId,
      replyUrl: reply.replyUrl,
      resolved: false,
    };
  }
  const resolvedThread = await resolveThread(threadId, { env, ghCommand, runChild });
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
