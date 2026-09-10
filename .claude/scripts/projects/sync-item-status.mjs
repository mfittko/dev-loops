#!/usr/bin/env node
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { syncBoardStatus as realSyncBoardStatus, loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const LOGICAL_COLUMNS = Object.values(LOGICAL_COLUMN);

const USAGE = `Usage: dev-loops queue sync-status --repo <owner/name> [--item <number>] [--pr <number>]
                                  (--to-column <name> | --logical-column <name>)
       --item wins when both targets are given; --pr is the fallback when
       --item is omitted, empty, or left as a bare flag by a dropped
       template substitution. At least one target is required.
       (dev-loops project sync-status … is a back-compat alias)

Sync a queued issue/PR's board Status column on a dev-loop transition (e.g.
PR opened → "In Progress", merged → "Done"). Resolves the board from .devloops
and uses local gh auth.

This command is BEST-EFFORT and NON-FATAL: a board that is not configured, an
item that is not on the board, or any GitHub API failure exits 0 with a JSON
result describing the skip/failure. It never fails the caller except under
--silent, where a falsy --jq predicate maps to exit 1 by design.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --item <number>         Linked issue/PR number (positive integer). Required
                          unless --pr is given; an empty or whitespace-only value counts as omitted.
  --pr <number>           Move target when --item is omitted (the
                          PR-is-the-queue-item case, e.g. a post-merge sync).
  --to-column <name>      Target Status column, verbatim (e.g. "In Progress", "Done").
  --logical-column <name> Target Status column by logical name (${LOGICAL_COLUMNS.join(", ")}),
                          resolved through .devloops queue.statusColumns so a
                          renamed column still converges. Exactly one of
                          --to-column / --logical-column is required.
  --help, -h              Show this help.

Output (stdout):
  JSON: the syncBoardStatus result, e.g.
    { ok: true, skipped: false, result: { item: { newColumn } } }
    { ok: true, skipped: true, reason: "board not configured" }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — always on a parsed command without --silent (best-effort sync; skips/failures
      are reported in JSON); --silent maps a falsy --jq predicate to exit 1
  1 — usage or argument error
  2 — invalid --jq filter
`.trim();

function parseCliArgs(argv) {
  const requireValue = (token, message, code) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw Object.assign(new Error(message), { code, usage: USAGE });
    }
    return v;
  };

  const args = {};
  // A dropped `<linked-issue>` template substitution leaves a bare `--item`
  // directly followed by the next flag (or the end of argv). parseArgs would
  // bind that flag as --item's value and requireValue would reject it. The
  // deleted merge hook was only lenient for an EMPTY value or a bare flag at
  // the end of argv; because the documented invocation now places
  // `--item <linked-issue>` mid-command, this deliberately goes further and
  // treats a bare `--item` as omitted in ANY position, so a dropped
  // substitution can never swallow its neighbouring flag. `--item=<value>`
  // and a space-separated real value are untouched.
  const argvList = argv.filter(
    (arg, i, list) => !(arg === "--item" && (i + 1 >= list.length || list[i + 1].startsWith("-"))),
  );
  const { tokens } = parseArgs({
    args: argvList,
    options: {
      repo: { type: "string" },
      item: { type: "string" },
      pr: { type: "string" },
      "to-column": { type: "string" },
      "logical-column": { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw Object.assign(new Error(`Unexpected argument: ${token.value}`), { code: "INVALID_ARGS", usage: USAGE });
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
        if (token.value !== undefined) {
          throw Object.assign(new Error(`Unknown flag: ${token.rawName}=${token.value}`), { code: "INVALID_ARGS", usage: USAGE });
        }
        args.help = true;
        break;
      case "repo":
        args.repo = requireValue(token, "--repo requires a value (owner/name)", "INVALID_REPO");
        break;
      case "item":
        // An empty/whitespace value (`--item ""` from an unfilled template
        // substitution) is the documented "the PR is the queue item" case —
        // leave args.item unset so it falls back to --pr. Bare `--item` forms
        // never reach here: the argv filter above already dropped them.
        if (!token.value?.trim()) break;
        args.item = requireValue(token, "--item requires a value (positive integer)", "INVALID_ITEM");
        break;
      case "pr":
        args.pr = requireValue(token, "--pr requires a value (positive integer)", "INVALID_ITEM");
        break;
      case "to-column":
        args.toColumn = requireValue(token, "--to-column requires a value", "INVALID_COLUMN");
        break;
      case "logical-column":
        args.logicalColumn = requireValue(token, "--logical-column requires a value", "INVALID_COLUMN");
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter", "INVALID_ARGS"))) break;
        throw Object.assign(new Error(`Unknown flag: ${token.rawName}`), { code: "INVALID_ARGS", usage: USAGE });
      }
    }
  }
  return args;
}

// ── Validation ───────────────────────────────────────────────────────────

const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

function validateRepo(repo) {
  if (!repo || typeof repo !== "string") {
    throw Object.assign(new Error("--repo is required"), { code: "INVALID_REPO" });
  }
  const trimmed = repo.trim();
  if (trimmed !== repo) {
    throw Object.assign(
      new Error(`--repo must not have leading/trailing whitespace, got "${repo}"`),
      { code: "INVALID_REPO" },
    );
  }
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    throw Object.assign(new Error(`--repo must be exactly owner/name, got "${repo}"`), { code: "INVALID_REPO" });
  }
  const owner = repo.slice(0, slashIdx);
  const name = repo.slice(slashIdx + 1);
  if (!owner || !name || !OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) {
    throw Object.assign(new Error(`--repo must be exactly owner/name, got "${repo}"`), { code: "INVALID_REPO" });
  }
  return repo;
}

function parseItemNumber(raw, flag = "--item") {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error(`${flag} is required`), { code: "INVALID_ITEM" });
  }
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return asNum;
  }
  throw Object.assign(new Error(`${flag} must be a positive integer, got "${raw}"`), { code: "INVALID_ITEM" });
}

// The move target is --item when given, else --pr (the PR-is-the-queue-item
// case a post-merge sync uses when no linked issue was passed).
function resolveItemNumber(args) {
  if (typeof args.item === "string" && args.item.trim().length > 0) {
    return parseItemNumber(args.item);
  }
  if (args.pr !== undefined) {
    return parseItemNumber(args.pr, "--pr");
  }
  throw Object.assign(new Error("--item is required (or --pr as the move target)"), { code: "INVALID_ITEM" });
}

// --to-column is the column name verbatim; --logical-column resolves through
// the .devloops statusColumns mapping, so a board that renamed e.g. Done still
// converges. Exactly one of the two must be given. On a config read/parse
// error loadStateColumnMap falls back to the default names and syncBoardStatus
// surfaces the same error as its own best-effort skip, so no guard is needed.
function resolveTargetColumn(args, cwd) {
  const toColumn = (args.toColumn ?? "").trim();
  const logical = (args.logicalColumn ?? "").trim();
  if (toColumn && logical) {
    throw Object.assign(new Error("--to-column and --logical-column are mutually exclusive"), { code: "INVALID_COLUMN" });
  }
  if (toColumn) return toColumn;
  if (!logical) {
    throw Object.assign(new Error("one of --to-column or --logical-column is required"), { code: "INVALID_COLUMN" });
  }
  if (!LOGICAL_COLUMNS.includes(logical)) {
    throw Object.assign(
      new Error(`--logical-column must be one of ${LOGICAL_COLUMNS.join(", ")}, got "${logical}"`),
      { code: "INVALID_COLUMN" },
    );
  }
  return loadStateColumnMap(cwd).columnNames[logical];
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild, cwd = process.cwd(), syncBoardStatus = realSyncBoardStatus } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const item = resolveItemNumber(args);
  const toColumn = resolveTargetColumn(args, cwd);

  // syncBoardStatus owns the fail-open contract: a not-configured board, an
  // item not on the board, or any gh/API failure resolves to a skipped/failure
  // result rather than throwing. We surface that result verbatim and exit 0.
  return syncBoardStatus(repo, cwd, item, toColumn, env, { runChild: child });
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), runChild, syncBoardStatus } = {}) {
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
    // Help is a success path: clear any pre-existing non-zero process.exitCode
    // so help output can't inherit a leaked failure code.
    process.exitCode = 0;
    return;
  }

  // Argument validation errors (bad --repo / --item / no target column) are
  // genuine usage errors → exit 1. Everything past validation is best-effort:
  // syncBoardStatus never throws for board/API conditions, so a parsed command
  // always reports its result on stdout and exits 0.
  let result;
  try {
    result = await main(args, { env, cwd, runChild, syncBoardStatus });
  } catch (err) {
    if (err.code === "INVALID_REPO" || err.code === "INVALID_ITEM" || err.code === "INVALID_COLUMN" || err.code === "INVALID_ARGS") {
      stderr.write(`${formatCliError(err)}\n`);
      process.exitCode = 1;
      return;
    }
    // Defensive: any unexpected error stays best-effort/non-fatal — report it
    // as a skip and keep exit 0 (ok:true) so it never blocks the PR/merge caller,
    // unless --jq/--silent turns a filter/predicate into a non-zero exit — same
    // shared contract as the normal result path below.
    process.exitCode = emitResult({ ok: true, skipped: true, reason: err.message ?? "board sync failed" }, { jq: args.jq, silent: args.silent, stdout, stderr });
    return;
  }
  // Best-effort contract: result.ok is always true, so without --jq/--silent this
  // always exits 0. An invalid --jq filter still fails closed (exit 2).
  process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    // Best-effort: even an unexpected failure must not fail the caller.
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: error.message ?? "board sync failed" }) + "\n");
    // Force the documented exit-0 contract even on this last-resort path.
    process.exitCode = 0;
  });
}

export { main, parseCliArgs, parseItemNumber, runCli };
