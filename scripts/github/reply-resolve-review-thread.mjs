#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { parsePositiveInteger } from "@dev-loops/core/cli/primitives";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  replyAndMaybeResolve,
  validateResolutionMessage,
} from "./_review-thread-mutations.mjs";

export { hasCommitShaReference } from "./_review-thread-mutations.mjs";

const USAGE = `Usage: dev-loops reply-resolve-review-thread --repo <owner/name> --pr <n> --comment-id <n> --thread-id <id> --body-file <path>

Reply to a review thread comment and resolve the thread.

Required:
  --repo <owner/name>      GitHub repository slug
  --pr <n>                 Pull request number
  --comment-id <n>         GraphQL databaseId of the comment to reply to
  --thread-id <id>         GraphQL node ID of the review thread
  --body-file <path>       Path to file containing the reply body text`;

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        "comment-id": { type: "string" },
        "thread-id": { type: "string" },
        "body-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    return { help: true };
  }

  if (!values.repo) throw parseError("Missing required option: --repo");
  if (!values.pr) throw parseError("Missing required option: --pr");
  if (!values["comment-id"]) throw parseError("Missing required option: --comment-id");
  if (!values["thread-id"]) throw parseError("Missing required option: --thread-id");
  if (!values["body-file"]) throw parseError("Missing required option: --body-file");

  const repoSlug = values.repo;
  parseRepoSlug(repoSlug);
  const pr = parsePositiveInteger(values.pr, "--pr", parseError);
  const commentId = parsePositiveInteger(values["comment-id"], "--comment-id", parseError);

  return { repo: repoSlug, pr, commentId, threadId: values["thread-id"], bodyFile: values["body-file"] };
}

async function run(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { repo: repoSlug, pr, commentId, threadId, bodyFile } = parsed;
  const rawBody = await readFile(bodyFile, "utf8");
  if (rawBody.trim().length === 0) throw new Error("--body-file must contain non-empty text");
  validateResolutionMessage(rawBody);

  const result = await replyAndMaybeResolve(
    { repo: repoSlug, pr, commentId, threadId, body: rawBody, resolve: true },
    { env: process.env, ghCommand: "gh" },
  );

  process.stdout.write(JSON.stringify({
    ok: true, repo: repoSlug, pr, commentId, threadId,
    replyId: result.replyId, replyUrl: result.replyUrl, resolved: true,
  }) + "\n");
  return 0;
}

if (isDirectCliRun(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => { process.exitCode = typeof code === "number" ? code : 0; },
    (error) => {
      const usage = error instanceof Error && typeof error.usage === "string" ? error.usage : undefined;
      process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(usage && { usage }) })}\n`);
      process.exitCode = 1;
    },
  );
}
