#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildCreateArgs as coreBuildCreateArgs, createIssue as coreCreateIssue } from "@dev-loops/core/github/issue-ops";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: create-issue.mjs --repo <owner/name> --title <t> (--body <b> | --body-file <path>) [--milestone <m>] [--label <l>...] [--assignee <u>...]
Create an issue. Thin wrapper over \`gh issue create\` — use this instead of an
agent-level raw \`gh issue create\` so the loop's internal-tooling record stays
clean (siblings: edit-issue.mjs, comment-issue.mjs).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --title <t>                   Issue title
Body (exactly one):
  --body <b>                    Issue body as a single argument
  --body-file <path>            Read the body from a real file (stdin is not supported: "-",
                                /dev/stdin, /dev/fd/N and /proc/self/fd/N are all rejected;
                                the resolved body must also be non-empty/non-whitespace)
Optional:
  --milestone <m>               Milestone to set
  --label <l>                   Label to add (repeatable)
  --assignee <u>                Assignee login to add (repeatable)
Output (stdout, JSON):
  { "ok": true, "issueNumber": 42, "url": "https://github.com/owner/repo/issues/42" }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
// Matches the common stdin-device path spellings — /dev/stdin, /dev/fd/N,
// and /proc/self/fd/N (the bare "-" is rejected separately below).
const STDIN_DEVICE_PATH_PATTERN = /^(?:\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/u;

export function parseCreateIssueCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      milestone: { type: "string" },
      label: { type: "string", multiple: true },
      assignee: { type: "string", multiple: true },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    title: undefined,
    body: undefined,
    bodyFile: undefined,
    milestone: undefined,
    labels: [],
    assignees: [],
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
      // gh is spawned with stdin ignored, so `--body-file -` (or any other stdin
      // device path) would read as empty and silently create a bodyless issue;
      // reject the known stdin traps fail-closed with an actionable message. The
      // real guard is the empty-body check in core createIssue() (any other
      // unreadable/racy source still fails closed there), this just gives a
      // clearer error for the specific stdin trap.
      if (rawPath === "-" || STDIN_DEVICE_PATH_PATTERN.test(rawPath)) {
        throw parseError(`--body-file '${rawPath}' (stdin) is not supported; use --body or a real file path`);
      }
      options.bodyFile = rawPath;
      continue;
    }
    if (token.name === "milestone") {
      const m = requireTokenValue(token, parseError).trim();
      if (m.length === 0) throw parseError("--milestone must be a non-empty milestone name");
      options.milestone = m;
      continue;
    }
    if (token.name === "label") {
      const l = requireTokenValue(token, parseError).trim();
      if (l.length === 0) throw parseError("--label must be a non-empty label");
      options.labels.push(l);
      continue;
    }
    if (token.name === "assignee") {
      const u = requireTokenValue(token, parseError).trim();
      if (u.length === 0) throw parseError("--assignee must be a non-empty login");
      options.assignees.push(u);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.title === undefined) {
    throw parseError("Creating an issue requires both --repo <owner/name> and --title <t>");
  }
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw parseError("--body and --body-file are mutually exclusive; pass exactly one");
  }
  if (options.body === undefined && options.bodyFile === undefined) {
    throw parseError("Creating an issue requires exactly one of --body <b> or --body-file <path>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

// Build the `gh issue create` args. A --body-file path is forwarded straight to
// gh so large bodies avoid command-length limits.
export function buildCreateArgs(options) {
  return coreBuildCreateArgs(options);
}

export async function createIssue(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  return coreCreateIssue(options, { env, ghCommand, run });
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseCreateIssueCliArgs(argv);
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
    result = await createIssue(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
