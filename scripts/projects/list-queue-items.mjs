#!/usr/bin/env node
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { applyDevloopsBoard } from "./_resolve-project.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { main, classifyExitCode } from "@dev-loops/core/projects/list-queue-items";

const USAGE = `Usage: dev-loops queue list --repo <owner/name> [--project <number|id>] [--column <name>] [--limit <n>]
       dev-loops queue list --repo <owner/name> [--project <number|id>] --summary [--done-limit <n>]
       (dev-loops project list … is a back-compat alias)

List GitHub Projects V2 items filtered by Status column, ordered by position
ascending. Returns machine-readable JSON.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Project number (integer) or node ID. When omitted,
                          resolved from .devloops queue.board.number /
                          queue.board.title.
  --column <name>         Filter items by Status column value (e.g. "Next Up").
  --limit <n>             Return at most <n> items (flat mode only).
  --summary               Whole-board digest grouped by Status column, in board
                          column order. Emits { ok, groups: { <status>: { count, items } } }.
  --group-by status       Alias for --summary. Only "status" is supported.
  --done-limit <n>        With --summary: cap the "Done" group's items array to
                          <n> (or the last/terminal board column if no column is
                          named "Done"). Count stays the true total; use 0 for
                          counts only.
  --help, -h              Show this help.

Grouping / aggregation is done via --summary (this mode). Do NOT pipe flat
output through inline parsers (e.g. \`| python3\`) or reduce/group_by jq filters
to build a per-status digest — the summary mode is the sanctioned one-call path.

--summary is mutually exclusive with --column and --limit (both exit 1).

Output (stdout):
  flat:    { ok: true, items: [{ issueNumber, prNumber, title, url, itemId, contentId, status }, ...] }
  summary: { ok: true, groups: { "<Status>": { count, items: [ <item>, ... ] }, ... } }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — project, field, or column not found
`.trim();

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE });
  const requireValue = (token, message) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw parseError(message);
    }
    return v;
  };

  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      column: { type: "string" },
      limit: { type: "string" },
      summary: { type: "boolean" },
      "group-by": { type: "string" },
      "done-limit": { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unexpected argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.help = true;
        break;
      case "repo":
        args.repo = requireValue(token, "--repo requires a value (owner/name)");
        break;
      case "project":
        args.project = requireValue(token, "--project requires a value (number or node ID)");
        break;
      case "column":
        args.column = requireValue(token, "--column requires a value");
        break;
      case "limit": {
        const raw = requireValue(token, "--limit requires a positive integer");
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 1) {
          throw parseError(`--limit must be a positive integer, got "${raw}"`);
        }
        args.limit = val;
        break;
      }
      case "summary":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.summary = true;
        break;
      case "group-by": {
        const val = requireValue(token, "--group-by requires a value (only \"status\" is supported)");
        if (val !== "status") {
          throw parseError(`--group-by only supports "status", got "${val}"`);
        }
        args.summary = true;
        break;
      }
      case "done-limit": {
        const raw = requireValue(token, "--done-limit requires a non-negative integer");
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 0) {
          throw parseError(`--done-limit must be a non-negative integer, got "${raw}"`);
        }
        args.doneLimit = val;
        break;
      }
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter"))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
      }
    }
  }
  return args;
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), runChild } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    stdout.write(USAGE);
    return;
  }

  // Resolve the board from .devloops when --project is absent.
  applyDevloopsBoard(args, cwd);

  try {
    const result = await main(args, { env, runChild });
    process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
  } catch (err) {
    stderr.write(JSON.stringify({ ok: false, error: err.message, code: err.code ?? "UNKNOWN" }) + "\n");
    process.exitCode = classifyExitCode(err);
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, code: error.code ?? "UNKNOWN" }) + "\n");
    process.exitCode = 2;
  });
}

export { main, parseCliArgs, runCli };
