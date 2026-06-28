#!/usr/bin/env node
// Collapse the board's "In Progress" column to a SINGLE continue target (#988 P1).
//
// Pure list->single-target collapse with NO routing opinions: it lists the
// In-Progress items via list-queue-items.mjs and either returns the lone target
// or FAILS CLOSED. It never guesses among multiple active items.
//
//   exactly one  -> { ok: true, target: { kind: "issue"|"pr", number } }
//   zero         -> { ok: false, reason: "..." }  (no in-progress item)
//   multiple     -> { ok: false, reason: "..." }  (names the items)
//
// Downstream (the dev-loop skill) resolves authoritative state from this number;
// this helper deliberately makes no further decisions.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { main as listQueueItems } from "./list-queue-items.mjs";

const IN_PROGRESS_COLUMN = "In Progress";

const USAGE = `Usage: dev-loops queue resolve-active --repo <owner/name> --project <number|id>

Collapse the board's "${IN_PROGRESS_COLUMN}" column to a single continue target.
Used by bare \`/continue\` to pick up the one in-progress item. Fails closed
(no guessing) when the board has zero or more than one in-progress item.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Required. Project number (integer) or node ID.
  --help, -h              Show this help.

Output (stdout):
  JSON, exactly one in-progress item:
    { ok: true, target: { kind: "issue"|"pr", number } }
  JSON, zero or multiple (fail closed):
    { ok: false, reason: "..." }

${JQ_OUTPUT_USAGE}

Exit codes (default / unfiltered output):
  0 — exactly one in-progress item resolved
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — fail closed: zero or multiple in-progress items (pass an explicit issue/PR)

With --jq/--silent the result is filtered to a value/predicate, so the exit code
follows the shared jq-output contract (0 = truthy/ok, 1 = falsy/non-ok, 2 =
invalid filter) — fail closed surfaces as a falsy \`.ok\`, i.e. exit 1, not 3.
`.trim();

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE, code: "INVALID_ARGS" });
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
        args.help = true;
        break;
      case "repo":
        args.repo = requireValue(token, "--repo requires a value (owner/name)");
        break;
      case "project":
        args.project = requireValue(token, "--project requires a value (number or node ID)");
        break;
      case "jq":
        args.jq = requireValue(token, "--jq requires a filter");
        break;
      case "silent":
        args.silent = true;
        break;
      default:
        throw parseError(`Unknown flag: ${token.rawName}`);
    }
  }
  return args;
}

function describeItem(item) {
  const ref = item.prNumber != null ? `PR #${item.prNumber}` : `issue #${item.issueNumber}`;
  return item.title ? `${ref} (${item.title})` : ref;
}

// Collapse a list of board items to a single continue target. Prefer the linked
// PR number when present (the canonical artifact once work is in flight), else
// the issue. No routing opinion beyond that single pick.
function collapseToTarget(items) {
  if (items.length === 0) {
    return {
      ok: false,
      reason: `No in-progress board item to continue. Pass an explicit issue/PR, e.g. \`/continue #N\`.`,
    };
  }
  if (items.length > 1) {
    const listed = items.map(describeItem).join(", ");
    return {
      ok: false,
      reason: `${items.length} in-progress board items: ${listed}. Pass an explicit issue/PR to disambiguate, e.g. \`/continue #N\`.`,
    };
  }
  const item = items[0];
  const target = item.prNumber != null
    ? { kind: "pr", number: item.prNumber }
    : { kind: "issue", number: item.issueNumber };
  return { ok: true, target };
}

async function main(args, { env = process.env, runChild } = {}) {
  const listed = await listQueueItems(
    { repo: args.repo, project: args.project, column: IN_PROGRESS_COLUMN },
    { env, runChild },
  );
  return collapseToTarget(listed.items ?? []);
}

function classifyExitCode(err) {
  if (err.code === "INVALID_ARGS" || err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND") return 3;
  return 2;
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, runChild } = {}) {
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
  try {
    const result = await main(args, { env, runChild });
    // Fail closed (zero/multiple) is a clean, expected outcome — distinct exit code 3,
    // not a crash; --jq/--silent still apply so callers can probe `.ok`.
    process.exitCode = emitResult(result, {
      jq: args.jq,
      silent: args.silent,
      stdout,
      stderr,
      ok: result.ok,
    });
    if (result.ok !== true && args.jq === undefined && !args.silent) {
      process.exitCode = 3;
    }
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

export { main, collapseToTarget, runCli };
