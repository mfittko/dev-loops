#!/usr/bin/env node
// Resolve the board's single continue target for the live `/loop-continue` path
// (#988 P1, extended #1091). It lists the "In Progress" column and, failing
// that, the "Next Up" column via list-queue-items.mjs — with NO routing opinions
// beyond a single pick and NO guessing. It never touches Backlog.
//
//   exactly one In Progress   -> { ok: true, target: {kind,number}, source: "in-progress" }
//   multiple In Progress      -> { ok: false, reason: "..." }  (names the items)
//   zero In Progress:
//     Next Up has items        -> { ok: true, target: {kind,number}, source: "next-up" }
//                                  (HEAD of Next Up, by POSITION ascending)
//     Next Up empty            -> { ok: false, reason: <canonical empty-queue msg>, source: "next-up" }
//     Next Up query errors     -> propagates (fail closed — surface it, no fallback)
//
// Downstream (the dev-loop skill) resolves authoritative state from this number;
// this helper deliberately makes no further decisions.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { main as listQueueItems } from "./list-queue-items.mjs";
import { EMPTY_NEXT_UP_MESSAGE } from "@dev-loops/core/loop/queue-board-ordering";
import { loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";

const IN_PROGRESS_COLUMN = "In Progress";
// Illustrative default label for USAGE/help + comments only; the actual query
// column resolves through queue.statusColumns.next_up at runtime (#1098).
const NEXT_UP_COLUMN = "Next Up";
// Canonical fail-closed empty-queue message — matches queue-driver.mjs so
// operators see one string regardless of which layer detects it (#1091).
const EMPTY_QUEUE_REASON = EMPTY_NEXT_UP_MESSAGE;

const USAGE = `Usage: dev-loops queue resolve-active --repo <owner/name> --project <number|id>

Resolve the board's single continue target for bare \`/loop-continue\`:
continues the one "${IN_PROGRESS_COLUMN}" item; if there is none, picks the HEAD
of "${NEXT_UP_COLUMN}" by POSITION ascending. Fails closed (no guessing) on
multiple in-progress items, and when "${NEXT_UP_COLUMN}" is empty. Never pulls
from Backlog.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Required. Project number (integer) or node ID.
  --help, -h              Show this help.

Output (stdout):
  JSON, exactly one in-progress item:
    { ok: true, target: { kind: "issue"|"pr", number }, source: "in-progress" }
  JSON, zero in-progress + "${NEXT_UP_COLUMN}" head:
    { ok: true, target: { kind: "issue"|"pr", number }, source: "next-up" }
  JSON, fail closed (multiple in-progress, or empty "${NEXT_UP_COLUMN}"):
    { ok: false, reason: "..." }

${JQ_OUTPUT_USAGE}

Exit codes (default / unfiltered output):
  0 — a single continue target resolved (in-progress or "${NEXT_UP_COLUMN}" head)
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — fail closed (pass an explicit issue/PR): multiple in-progress items, an
      empty "${NEXT_UP_COLUMN}" column, or the board/project could not be
      resolved (project, status field, or the column not found)

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
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter"))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
      }
    }
  }
  return args;
}

function describeItem(item) {
  const ref = item.prNumber != null ? `PR #${item.prNumber}` : `issue #${item.issueNumber}`;
  return item.title ? `${ref} (${item.title})` : ref;
}

// Prefer the linked PR number when present (the canonical artifact once work is
// in flight), else the issue. No routing opinion beyond that single pick.
function itemToTarget(item) {
  return item.prNumber != null
    ? { kind: "pr", number: item.prNumber }
    : { kind: "issue", number: item.issueNumber };
}

// Collapse the "In Progress" column to a single continue target. The caller only
// invokes this with a NON-EMPTY column (zero In Progress falls through to
// resolveNextUpHead in main()), so this only decides among the in-progress items
// and never guesses when there is more than one.
function collapseToTarget(items) {
  if (items.length > 1) {
    const listed = items.map(describeItem).join(", ");
    return {
      ok: false,
      reason: `${items.length} in-progress board items: ${listed}. Pass an explicit issue/PR to disambiguate, e.g. \`/loop-continue #N\`.`,
    };
  }
  return { ok: true, target: itemToTarget(items[0]), source: "in-progress" };
}

// Zero in-progress: the live continue path falls through to the "Next Up"
// column, HEAD by POSITION ascending (list-queue-items returns position order).
// NEVER pulls from Backlog; empty Next Up fails closed with the canonical
// message, and a query error propagates (fail closed — surface it, no fallback).
async function resolveNextUpHead(args, { env, runChild, cwd = process.cwd() } = {}) {
  // Resolve the next_up column name through the SAME statusColumns mapping
  // board-sync uses (#1098): a repo that renamed Next Up (e.g. to "Todo") gets
  // its configured column queried, not the literal default. Pickup SEMANTICS
  // (position-ascending HEAD, fail-closed on empty, never Backlog) are unchanged.
  const nextUpColumn = loadStateColumnMap(cwd).columnNames[LOGICAL_COLUMN.NEXT_UP];
  const listed = await listQueueItems(
    { repo: args.repo, project: args.project, column: nextUpColumn },
    { env, runChild },
  );
  const items = listed.items ?? [];
  if (items.length === 0) {
    return { ok: false, reason: EMPTY_QUEUE_REASON, source: "next-up" };
  }
  return { ok: true, target: itemToTarget(items[0]), source: "next-up" };
}

async function main(args, { env = process.env, runChild, cwd = process.cwd() } = {}) {
  const listed = await listQueueItems(
    { repo: args.repo, project: args.project, column: IN_PROGRESS_COLUMN },
    { env, runChild },
  );
  const items = listed.items ?? [];
  // Exactly one → continue it. Multiple → fail closed (never guess). Zero →
  // fall through to the Next Up head (the live pickup path, #1091).
  if (items.length === 0) {
    return resolveNextUpHead(args, { env, runChild, cwd });
  }
  return collapseToTarget(items);
}

function classifyExitCode(err) {
  if (err.code === "INVALID_ARGS" || err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND") return 3;
  return 2;
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, runChild, cwd = process.cwd() } = {}) {
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
    const result = await main(args, { env, runChild, cwd });
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

export { main, collapseToTarget, resolveNextUpHead, runCli };
