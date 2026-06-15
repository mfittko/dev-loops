#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { defineSubcommand, isDirectCliRun } from "@dev-loops/core/cli/subcommand-runner";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  replyAndMaybeResolve,
  validateResolutionMessage,
} from "./_review-thread-mutations.mjs";

export { hasCommitShaReference } from "./_review-thread-mutations.mjs";

const { runAsScript } = defineSubcommand({
  name: "reply-resolve-review-thread --repo <owner/name> --pr <n> --comment-id <n> --thread-id <id> --body-file <path>",
  description: "Reply to a review thread comment and resolve the thread.",
  options: [
    { flag: "--repo", type: "string", required: true, description: "GitHub repository slug" },
    { flag: "--pr", type: "pr", required: true, description: "Pull request number" },
    { flag: "--comment-id", type: "positiveInt", required: true, description: "GraphQL databaseId of the comment to reply to" },
    { flag: "--thread-id", type: "string", required: true, description: "GraphQL node ID of the review thread" },
    { flag: "--body-file", type: "string", required: true, description: "Path to file containing the reply body text" },
  ],
  async run({ repo, pr, commentId, threadId, bodyFile }) {
    parseRepoSlug(repo);

    const rawBody = await readFile(bodyFile, "utf8");
    if (rawBody.trim().length === 0) throw new Error("--body-file must contain non-empty text");
    validateResolutionMessage(rawBody);

    const result = await replyAndMaybeResolve(
      { repo, pr, commentId, threadId, body: rawBody, resolve: true },
      { env: process.env, ghCommand: "gh" },
    );

    process.stdout.write(JSON.stringify({
      ok: true, repo, pr, commentId, threadId,
      replyId: result.replyId, replyUrl: result.replyUrl, resolved: true,
    }) + "\n");
    return 0;
  },
});

if (isDirectCliRun(import.meta.url)) { runAsScript(); }
