#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: edit-issue.mjs --repo <owner/name> --issue <number> [--title <t>] [--body <b> | --body-file <path>] [--add-assignee <u>] [--remove-assignee <u>] [--milestone <m>]
Edit issue title/body/assignees/milestone. Thin wrapper over \`gh issue edit\` — use this
instead of an agent-level raw \`gh issue edit\` so the loop's internal-tooling record
stays clean (siblings: edit-pr.mjs, comment-issue.mjs).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --issue <number>              Issue number
At least one edit:
  --title <t>                   New issue title
  --body <b>                    New issue body as a single argument
  --body-file <path>            Read the new body from a file (- reads stdin)
  --add-assignee <u>            Assignee to add (repeatable)
  --remove-assignee <u>         Assignee to remove (repeatable)
  --milestone <m>               Milestone to set (empty string clears it)
                                (--title/--body/--body-file reject empty or
                                whitespace-only values; use --milestone "" only
                                to clear the milestone)
Output (stdout, JSON):
  { "ok": true, "repo": "owner/repo", "issue": 17, "edited": ["title", "body", ...] }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseEditIssueCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      "add-assignee": { type: "string", multiple: true },
      "remove-assignee": { type: "string", multiple: true },
      milestone: { type: "string" },
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
    title: undefined,
    body: undefined,
    bodyFile: undefined,
    addAssignees: [],
    removeAssignees: [],
    milestone: undefined,
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
    if (token.name === "title") {
      const title = requireTokenValue(token, parseError);
      if (title.trim().length === 0) {
        throw parseError("--title must not be empty or whitespace-only");
      }
      options.title = title;
      continue;
    }
    if (token.name === "body") {
      const body = requireTokenValue(token, parseError);
      if (body.trim().length === 0) {
        throw parseError("--body must not be empty or whitespace-only");
      }
      options.body = body;
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
    if (token.name === "add-assignee") {
      const u = requireTokenValue(token, parseError).trim();
      if (u.length === 0) throw parseError("--add-assignee must be a non-empty login");
      options.addAssignees.push(u);
      continue;
    }
    if (token.name === "remove-assignee") {
      const u = requireTokenValue(token, parseError).trim();
      if (u.length === 0) throw parseError("--remove-assignee must be a non-empty login");
      options.removeAssignees.push(u);
      continue;
    }
    if (token.name === "milestone") {
      // Read the raw token value: an empty string is a valid milestone value
      // (`gh issue edit --milestone ""` clears it), so this deliberately does NOT
      // go through requireTokenValue (which rejects empty). Guard only a truly
      // missing value (`--milestone` with no following token). A whitespace-only
      // value is neither a clear nor a real milestone name — fail closed rather
      // than forwarding it to gh for a less actionable error.
      if (typeof token.value !== "string") {
        throw parseError("--milestone requires a value (use an empty string to clear)");
      }
      if (token.value.length > 0 && token.value.trim().length === 0) {
        throw parseError('--milestone must be a milestone name or "" to clear (whitespace-only is not allowed)');
      }
      options.milestone = token.value;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("Editing an issue requires both --repo <owner/name> and --issue <number>");
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw parseError("--body and --body-file are mutually exclusive; pass only one");
  }
  const hasEdit =
    options.title !== undefined ||
    options.body !== undefined ||
    options.bodyFile !== undefined ||
    options.addAssignees.length > 0 ||
    options.removeAssignees.length > 0 ||
    options.milestone !== undefined;
  if (!hasEdit) {
    throw parseError("Editing an issue requires at least one of --title/--body/--body-file/--add-assignee/--remove-assignee/--milestone");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

async function resolveBody(options) {
  if (options.bodyFile === undefined) return options.body;
  // Stdin (fd 0): the fs/promises readFile does NOT accept an integer fd, so read
  // it synchronously via the callback-style API (which does). A real path stays on
  // the async promise read.
  const body =
    options.bodyFile === "-" ? readFileSync(0, "utf8") : await readFile(options.bodyFile, "utf8");
  // Fail closed on an empty / whitespace-only file so a blank --body-file cannot
  // silently clear the issue body (USAGE promises --body/--title reject empties).
  if (body.trim().length === 0) {
    throw new Error(`--body-file ${options.bodyFile} is empty`);
  }
  return body;
}

// Build the `gh issue edit` args and the parallel `edited` list (which fields were
// touched) so callers get a stable summary without re-reading the issue.
async function buildEditArgs(options) {
  const args = ["issue", "edit", String(options.issue), "--repo", options.repo];
  const edited = [];
  if (options.title !== undefined) {
    args.push("--title", options.title);
    edited.push("title");
  }
  // resolveBody still runs for validation (reads the file, throws on empty /
  // whitespace-only). A REAL --body-file path is handed straight to gh so large
  // bodies avoid command-length limits. But `--body-file -` (stdin) was already
  // consumed by resolveBody reading fd 0; re-emitting `--body-file -` makes gh
  // re-read an exhausted stdin and clear the body, so pass the resolved string
  // inline via --body instead.
  const body = await resolveBody(options);
  if (body !== undefined) {
    if (options.bodyFile !== undefined && options.bodyFile !== "-") {
      args.push("--body-file", options.bodyFile);
    } else {
      args.push("--body", body);
    }
    edited.push("body");
  }
  for (const u of options.addAssignees) {
    args.push("--add-assignee", u);
  }
  if (options.addAssignees.length > 0) edited.push("add-assignee");
  for (const u of options.removeAssignees) {
    args.push("--remove-assignee", u);
  }
  if (options.removeAssignees.length > 0) edited.push("remove-assignee");
  if (options.milestone !== undefined) {
    args.push("--milestone", options.milestone);
    edited.push("milestone");
  }
  return { args, edited };
}

export async function editIssue(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  const { args, edited } = await buildEditArgs(options);
  const result = await run(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue edit failed: ${detail}`);
  }
  return { ok: true, repo: options.repo, issue: options.issue, edited };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseEditIssueCliArgs(argv);
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
    result = await editIssue(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
