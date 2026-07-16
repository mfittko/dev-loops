#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseIssueNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

// Default issue facts a follow-up run reads: body + identity/state for AC
// checkbox sync and gate angles that need the linked issue. Callers needing a
// different set pass --json <fields> (a comma list, same vocabulary as
// `gh issue view --json`).
const DEFAULT_FIELDS =
  "number,title,body,state,author,labels,url,createdAt,updatedAt";

const USAGE = `Usage: view-issue.mjs --repo <owner/name> --issue <number> [--json <fields>]
Read issue facts (body/state/author/labels/etc.). Thin wrapper over
\`gh issue view --json …\` — use this instead of an agent-level raw \`gh issue view\`
so the loop's internal-tooling record stays clean (siblings: list-issues.mjs,
edit-issue.mjs, comment-issue.mjs, view-pr.mjs). This is the thin field-read
counterpart for issue bodies that list-issues.mjs does not return.
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --issue <number>              Issue number
Optional:
  --json <fields>               Comma-separated gh issue view field list
                                (default: ${DEFAULT_FIELDS})
Output (stdout, JSON):
  { "ok": true, "issue": { <requested fields> } }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseViewIssueCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      json: { type: "string" },
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
    fields: DEFAULT_FIELDS,
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
    if (token.name === "json") {
      const fields = requireTokenValue(token, parseError)
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      if (fields.length === 0) {
        throw parseError("--json must list at least one field");
      }
      if (fields.some((f) => !/^[A-Za-z][A-Za-z0-9]*$/.test(f))) {
        throw parseError("--json fields must be gh issue view field names (letters/digits)");
      }
      options.fields = fields.join(",");
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("Viewing an issue requires both --repo <owner/name> and --issue <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

export async function viewIssue(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  const result = await run(
    ghCommand,
    ["issue", "view", String(options.issue), "--repo", options.repo, "--json", options.fields],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue view failed: ${detail}`);
  }
  const issue = parseJsonText(result.stdout, { label: "gh issue view" });
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
    throw new Error("gh issue view did not return a JSON object");
  }
  return { ok: true, issue };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseViewIssueCliArgs(argv);
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
    result = await viewIssue(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
