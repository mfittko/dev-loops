#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePositiveInteger, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: edit-comment.mjs --repo <owner/name> --comment-id <number> (--body <text> | --body-file <path>)
Update an existing issue or PR comment's body by comment id. Thin wrapper over
\`gh api -X PATCH .../issues/comments/{id}\` — issue comments and PR issue-comments
share this one REST endpoint, so this single wrapper covers both. Use this instead
of an agent-level raw \`gh api\` PATCH so the loop's internal-tooling record stays
clean (sibling: comment-issue.mjs creates a comment; this edits one in place).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --comment-id <number>         Id of the comment to update (from a prior
                                comment-issue.mjs result, or the comment URL's
                                #issuecomment-<id> suffix)
  --body <text>                 New comment body as a single argument
  --body-file <path>            Read the new body from a file (preserves
                                newlines; alternative to --body; - reads stdin)
Output (stdout, JSON):
  { "ok": true, "repo": "owner/repo", "commentId": 123, "commentUrl": "https://github.com/owner/repo/issues/17#issuecomment-123" }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseEditCommentCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      "comment-id": { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    commentId: undefined,
    body: undefined,
    bodyFile: undefined,
    jq: undefined,
    silent: false,
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
    if (token.name === "comment-id") {
      options.commentId = parsePositiveInteger(requireTokenValue(token, parseError), "--comment-id", parseError);
      continue;
    }
    if (token.name === "body") {
      options.body = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "body-file") {
      const rawPath = requireTokenValue(token, parseError).trim();
      if (rawPath.length === 0) {
        throw parseError("--body-file must be a non-empty path");
      }
      options.bodyFile = rawPath;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.commentId === undefined) {
    throw parseError("Editing a comment requires both --repo <owner/name> and --comment-id <number>");
  }
  if (options.body === undefined && options.bodyFile === undefined) {
    throw parseError("Editing a comment requires --body <text> or --body-file <path>");
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw parseError("--body and --body-file are mutually exclusive; pass only one");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

async function resolveBody(options) {
  if (options.bodyFile === undefined) {
    if (options.body.trim().length === 0) {
      throw new Error("--body must not be empty");
    }
    return options.body;
  }
  // Read stdin ("-") synchronously via fd 0 — fs/promises.readFile(0) is
  // unreliable on this Node target (mirrors edit-issue.mjs).
  const body = options.bodyFile === "-" ? readFileSync(0, "utf8") : await readFile(options.bodyFile, "utf8");
  if (body.trim().length === 0) {
    throw new Error(`--body-file ${options.bodyFile} is empty`);
  }
  return body;
}

// Update the comment via `gh api -X PATCH .../issues/comments/{id}`. Issue
// comments and PR issue-comments both live under /issues/comments/{id}, so this
// single call covers editing either kind without needing to know which one it is.
export async function editComment(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  const body = await resolveBody(options);
  const result = await run(
    ghCommand,
    ["api", "-X", "PATCH", `repos/${options.repo}/issues/comments/${options.commentId}`, "-f", `body=${body}`],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh api PATCH issues/comments failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  const commentUrl = typeof payload?.html_url === "string" && payload.html_url.trim().length > 0
    ? payload.html_url.trim()
    : null;
  if (commentUrl === null) {
    throw new Error(`gh api PATCH did not return a comment html_url (got: ${result.stdout.trim() || "<empty>"})`);
  }
  return { ok: true, repo: options.repo, commentId: options.commentId, commentUrl };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseEditCommentCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  let result;
  try {
    result = await editComment(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
