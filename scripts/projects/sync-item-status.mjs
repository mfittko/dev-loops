#!/usr/bin/env node
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { syncBoardStatus } from "@dev-loops/core/loop/queue-board-sync";
import { parseArgs } from "node:util";

const USAGE = `Usage: dev-loops project sync-status --repo <owner/name> --item <number> --to-column <name>

Sync a queued issue/PR's board Status column on a dev-loop transition (e.g.
PR opened → "In Progress", merged → "Done"). Resolves the board from .devloops
and uses local gh auth.

This command is BEST-EFFORT and NON-FATAL: a board that is not configured, an
item that is not on the board, or any GitHub API failure exits 0 with a JSON
result describing the skip/failure. It never fails the caller.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --item <number>         Required. Linked issue/PR number (positive integer).
  --to-column <name>      Required. Target Status column (e.g. "In Progress", "Done").
  --help, -h              Show this help.

Output (stdout):
  JSON: the syncBoardStatus result, e.g.
    { ok: true, skipped: false, result: { item: { newColumn } } }
    { ok: true, skipped: true, reason: "board not configured" }

Exit codes:
  0 — always on a parsed command (best-effort sync; skips/failures are reported in JSON)
  1 — usage or argument error
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
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      item: { type: "string" },
      "to-column": { type: "string" },
      help: { type: "boolean", short: "h" },
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
        args.item = requireValue(token, "--item requires a value (positive integer)", "INVALID_ITEM");
        break;
      case "to-column":
        args.toColumn = requireValue(token, "--to-column requires a value", "INVALID_COLUMN");
        break;
      default:
        throw Object.assign(new Error(`Unknown flag: ${token.rawName}`), { code: "INVALID_ARGS", usage: USAGE });
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

function parseItemNumber(raw) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error("--item is required"), { code: "INVALID_ITEM" });
  }
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return asNum;
  }
  throw Object.assign(new Error(`--item must be a positive integer, got "${raw}"`), { code: "INVALID_ITEM" });
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild, cwd = process.cwd() } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const item = parseItemNumber(args.item);
  const toColumn = (args.toColumn ?? "").trim();
  if (!toColumn) {
    throw Object.assign(new Error("--to-column is required"), { code: "INVALID_COLUMN" });
  }

  // syncBoardStatus owns the fail-open contract: a not-configured board, an
  // item not on the board, or any gh/API failure resolves to a skipped/failure
  // result rather than throwing. We surface that result verbatim and exit 0.
  return syncBoardStatus(repo, cwd, item, toColumn, env, { runChild: child });
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd() } = {}) {
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

  // Argument validation errors (bad --repo / --item / missing --to-column) are
  // genuine usage errors → exit 1. Everything past validation is best-effort:
  // syncBoardStatus never throws for board/API conditions, so a parsed command
  // always reports its result on stdout and exits 0.
  let result;
  try {
    result = await main(args, { env, cwd });
  } catch (err) {
    if (err.code === "INVALID_REPO" || err.code === "INVALID_ITEM" || err.code === "INVALID_COLUMN" || err.code === "INVALID_ARGS") {
      stderr.write(`${formatCliError(err)}\n`);
      process.exitCode = 1;
      return;
    }
    // Defensive: any unexpected error stays best-effort/non-fatal — report it
    // as a skip and keep exit 0 so it never blocks the PR/merge caller.
    stdout.write(JSON.stringify({ ok: true, skipped: true, reason: err.message ?? "board sync failed" }) + "\n");
    // Explicitly assert success: a pre-existing non-zero process.exitCode from a
    // long-lived caller must not leak through this best-effort path.
    process.exitCode = 0;
    return;
  }
  stdout.write(JSON.stringify(result) + "\n");
  // Best-effort contract: a parsed command always reports success. Explicitly
  // clear any pre-existing non-zero process.exitCode so it cannot leak.
  process.exitCode = 0;
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
