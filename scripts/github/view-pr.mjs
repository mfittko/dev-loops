#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

// Default PR facts a follow-up run reads: the fields loop info surfaces plus the
// head SHA. Callers needing a different set pass --json <fields> (a comma list,
// same vocabulary as `gh pr view --json`).
const DEFAULT_FIELDS =
  "number,title,body,state,isDraft,headRefName,baseRefName,headRefOid,author,mergedAt,mergeable,mergeStateStatus,url";

const USAGE = `Usage: view-pr.mjs --repo <owner/name> --pr <number> [--json <fields>]
Read PR facts (branch/state/mergeStateStatus/head SHA/etc.). Thin wrapper over
\`gh pr view --json …\` — use this instead of an agent-level raw \`gh pr view\` so the
loop's internal-tooling record stays clean (siblings: list-issues.mjs,
comment-issue.mjs, fetch-ci-logs.mjs; #1057). For composite loop routing/CI facts
prefer \`dev-loops loop info --pr\`; this is the thin field-read counterpart.
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
  --pr <number>                 Pull request number
Optional:
  --json <fields>               Comma-separated gh pr view field list
                                (default: ${DEFAULT_FIELDS})
Output (stdout, JSON):
  { "ok": true, "pr": { <requested fields> } }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseViewPrCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
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
    pr: undefined,
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
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
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
        throw parseError("--json fields must be gh pr view field names (letters/digits)");
      }
      options.fields = fields.join(",");
      continue;
    }
    if (token.name === "jq") {
      options.jq = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Viewing a PR requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

export async function viewPr(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  const result = await run(
    ghCommand,
    ["pr", "view", String(options.pr), "--repo", options.repo, "--json", options.fields],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh pr view failed: ${detail}`);
  }
  const pr = parseJsonText(result.stdout, { label: "gh pr view" });
  if (pr === null || typeof pr !== "object" || Array.isArray(pr)) {
    throw new Error("gh pr view did not return a JSON object");
  }
  return { ok: true, pr };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseViewPrCliArgs(argv);
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
    result = await viewPr(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
