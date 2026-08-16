#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, parseAllowedRefsCsv, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { commentIssue as coreCommentIssue } from "@dev-loops/core/github/issue-ops";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: comment-issue.mjs --repo <owner/name> --issue <number> (--body <text> | --body-file <path>)
Post a comment on a GitHub issue. Thin wrapper over \`gh issue comment\` — use this
instead of an agent-level raw \`gh issue comment\` so the loop's internal-tooling
record stays clean (#993; the read-side siblings are list-issues.mjs / fetch-ci-logs.mjs).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --issue <number>              Issue number to comment on
  --body <text>                 Comment body as a single argument
  --body-file <path>            Read the comment body from a file (preserves
                                newlines; alternative to --body; - reads stdin)
  --allowed-refs <csv>          Comma-separated numeric issue/PR ids to allow as
                                deliberate cross-references in the body (the
                                no-ids-in-comments guard refuses any other #<digits>)
Output (stdout, JSON):
  { "ok": true, "repo": "owner/repo", "issue": 17, "commentUrl": "https://github.com/owner/repo/issues/17#issuecomment-123" }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseCommentIssueCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      "allowed-refs": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    issue: undefined,
    body: undefined,
    bodyFile: undefined,
    allowedRefs: [],
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
    if (token.name === "issue") {
      options.issue = parseIssueNumber(requireTokenValue(token, parseError), parseError);
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
    if (token.name === "allowed-refs") {
      options.allowedRefs = parseAllowedRefsCsv(requireTokenValue(token, parseError), "--allowed-refs", parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("Commenting on an issue requires both --repo <owner/name> and --issue <number>");
  }
  if (options.body === undefined && options.bodyFile === undefined) {
    throw parseError("Commenting on an issue requires --body <text> or --body-file <path>");
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

// Post the comment via `gh issue comment`, then read its URL back from
// `gh issue comment` output. `gh issue comment` prints the new comment URL on
// success — capture it so callers don't need a follow-up read.
export async function commentIssue(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  return coreCommentIssue(options, { env, ghCommand, run });
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseCommentIssueCliArgs(argv);
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
    result = await commentIssue(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
