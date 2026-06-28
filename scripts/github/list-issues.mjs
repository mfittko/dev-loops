#!/usr/bin/env node
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const STATES = new Set(["open", "closed", "all"]);

const USAGE = `Usage: list-issues.mjs --repo <owner/name> [--state <open|closed|all>] [--label <l>] [--limit <n>]
List/filter repository issues. Thin wrapper over \`gh issue list\` — use this instead
of an agent-level raw \`gh issue list\` so the loop's internal-tooling record stays
clean (#993). The queue tool lists the project board, not arbitrary issue queries;
this fills that gap (siblings: comment-issue.mjs, fetch-ci-logs.mjs).
Required:
  --repo <owner/name>           Repository slug (e.g. owner/repo)
Optional:
  --state <open|closed|all>     Issue state filter (default open)
  --label <l>                   Filter by label (repeatable; AND-combined by gh)
  --limit <n>                   Return at most <n> issues (default 30)
Output (stdout, JSON):
  { "ok": true, "issues": [{ "number": 17, "title": "...", "state": "open", "labels": ["bug"] }, ...] }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage"?: "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);

export function parseListIssuesCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      state: { type: "string" },
      label: { type: "string", multiple: true },
      limit: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    state: "open",
    labels: [],
    limit: 30,
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
    if (token.name === "state") {
      const state = requireTokenValue(token, parseError).trim().toLowerCase();
      if (!STATES.has(state)) {
        throw parseError("--state must be one of: open, closed, all");
      }
      options.state = state;
      continue;
    }
    if (token.name === "label") {
      const label = requireTokenValue(token, parseError).trim();
      if (label.length === 0) {
        throw parseError("--label must be a non-empty string");
      }
      options.labels.push(label);
      continue;
    }
    if (token.name === "limit") {
      const raw = requireTokenValue(token, parseError);
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw parseError(`--limit must be a positive integer, got "${raw}"`);
      }
      options.limit = value;
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
  if (options.repo === undefined) {
    throw parseError("Listing issues requires --repo <owner/name>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

function normalizeIssue(raw) {
  return {
    number: Number.isInteger(raw?.number) ? raw.number : null,
    title: typeof raw?.title === "string" ? raw.title : null,
    // gh reports issue state UPPERCASE (OPEN/CLOSED); normalize to lowercase to
    // match the --state flag vocabulary.
    state: typeof raw?.state === "string" ? raw.state.toLowerCase() : null,
    labels: Array.isArray(raw?.labels)
      ? raw.labels.map((l) => (typeof l?.name === "string" ? l.name : null)).filter((n) => n !== null)
      : [],
  };
}

export async function listIssues(options, { env = process.env, ghCommand = "gh", run = runChild } = {}) {
  const args = [
    "issue",
    "list",
    "--repo",
    options.repo,
    "--state",
    options.state,
    "--limit",
    String(options.limit),
    "--json",
    "number,title,state,labels",
  ];
  for (const label of options.labels) {
    args.push("--label", label);
  }
  const result = await run(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh issue list failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout, { label: "gh issue list" });
  if (!Array.isArray(payload)) {
    throw new Error("gh issue list did not return a JSON array");
  }
  return { ok: true, issues: payload.map(normalizeIssue) };
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh", run = runChild } = {},
) {
  let options;
  try {
    options = parseListIssuesCliArgs(argv);
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
    result = await listIssues(options, { env, ghCommand, run });
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
