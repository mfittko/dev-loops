#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  LINKED_ISSUE_PR_QUERY,
  selectLinkedIssuePr,
  detectLinkedIssuePr,
} from "@dev-loops/core/github/issue-ops";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
export { LINKED_ISSUE_PR_QUERY, selectLinkedIssuePr, detectLinkedIssuePr };
const USAGE = `Usage: detect-linked-issue-pr.mjs --repo <owner/name> --issue <number>
Detect whether an issue already has an open linked pull request in the same repository.
This helper owns linked-event query pagination and deterministic selection.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --issue <number>      Issue number
Success output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/name",
    "issue": 85,
    "hasOpenLinkedPr": true|false,
    "prNumber": 90|null,
    "prUrl": "..."|null,
    "selection"?: {
      "eventType": "CONNECTED_EVENT"|"CROSS_REFERENCED_EVENT",
      "eventCreatedAt": "..."
    },
    "hasPriorClosedUnmergedPr"?: true|false,
    "priorClosedUnmergedPrNumber"?: 149|null,
    "priorClosedUnmergedPrUrl"?: "..."|null
  }
When hasOpenLinkedPr is false, the output also includes hasPriorClosedUnmergedPr,
priorClosedUnmergedPrNumber, and priorClosedUnmergedPrUrl reflecting any same-repo
linked PR that was closed without merging.
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectLinkedIssuePrCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
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
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.issue === undefined) {
    throw parseError("Linked PR detection requires both --repo <owner/name> and --issue <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseDetectLinkedIssuePrCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await detectLinkedIssuePr(
    { repo: options.repo, issue: options.issue },
    { env, ghCommand },
  );
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
