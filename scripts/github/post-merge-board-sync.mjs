#!/usr/bin/env node
// Deliberate duplication with `dev-loops queue sync-status`
// (scripts/projects/sync-item-status.mjs): both are thin best-effort CLIs
// over the same syncBoardStatus core with the same exit contract. The deltas
// are what the merge hook needs hardwired: the target column resolves through
// the logical Done mapping (statusColumns) instead of a caller-supplied
// --to-column, and the move target defaults to the merged PR when no linked
// issue is passed — so the post-merge step needs no per-repo arguments.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseIssueNumber, parsePrNumber, requireTokenValue, runChild as _runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { syncBoardStatus as realSyncBoardStatus, loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: node scripts/github/post-merge-board-sync.mjs --repo <owner/name> --pr <number> [--issue <number>]

Post-merge board hook (issue #1458): after the dev-loop merges a PR, move the
queued item's board Status to the configured Done column. Resolves the board
from .devloops and uses local gh auth.

Pass --issue for the queued issue the merged PR closes; when omitted, the PR
itself is the move target (issue-less / PR-is-the-queue-item case).

This command is BEST-EFFORT and NON-FATAL, matching \`queue sync-status\`: a
board that is not configured, an item that is not on the board, or any GitHub
API failure logs a warning to stderr and still exits 0 — run it as a step
AFTER \`gh pr merge\` succeeds, never chained onto it, so it can never affect
the merge's own exit code.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --pr <number>           Required. The just-merged PR number (the move target
                          when --issue is omitted; always included in logs).
  --issue <number>        The queued issue this merge closes. When given, this
                          issue's board item is moved to Done instead of the PR's.
  --help, -h              Show this help.

Output (stdout):
  JSON: the syncBoardStatus result, e.g.
    { ok: true, skipped: false, result: { item: { newColumn } } }
    { ok: true, skipped: true, reason: "board not configured" }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — always on a parsed command without --silent (best-effort sync; skips/failures are
      reported in JSON + a stderr warning; --silent maps a falsy --jq predicate to exit 1)
  1 — usage or argument error
  2 — invalid --jq filter
`.trim();

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE });
  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      issue: { type: "string" },
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
    if (token.kind !== "option") continue;
    switch (token.name) {
      case "help":
        args.help = true;
        break;
      case "repo":
        args.repo = requireTokenValue(token, parseError);
        break;
      case "pr":
        args.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
        break;
      case "issue":
        // A missing or empty value (`--issue` alone, or `--issue ""` from an
        // unfilled `<linked-issue>` template substitution) is the documented
        // "PR is the queue item" case, not a usage error — leave args.issue
        // unset so it falls back to --pr below, instead of failing the whole
        // post-merge hook.
        if (token.value) {
          args.issue = parseIssueNumber(token.value, parseError);
        }
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireTokenValue(t, parseError))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
      }
    }
  }
  if (!args.help) {
    if (!args.repo) throw parseError("--repo is required");
    if (args.pr === undefined) throw parseError("--pr is required");
    try {
      parseRepoSlug(args.repo);
    } catch (err) {
      throw parseError(err instanceof Error ? err.message : String(err));
    }
  }
  return args;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild, cwd = process.cwd(), syncBoardStatus = realSyncBoardStatus } = {}) {
  const child = runChild ?? _runChild;
  const { owner, name } = parseRepoSlug(args.repo);
  const repo = `${owner}/${name}`;
  // Resolve Done through the same statusColumns mapping board-sync/archive use
  // (#1098) so a board that renamed Done still converges correctly.
  // On a config read/parse error columnNames falls back to the defaults and
  // syncBoardStatus surfaces the same error as its own best-effort skip, so
  // no separate guard is needed here.
  const { columnNames } = loadStateColumnMap(cwd);
  const doneColumn = columnNames[LOGICAL_COLUMN.DONE];
  const target = args.issue ?? args.pr;
  return syncBoardStatus(repo, cwd, target, doneColumn, env, { runChild: child });
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
    stdout.write(`${USAGE}\n`);
    // Help is a success path: clear any pre-existing non-zero process.exitCode
    // so help output can't inherit a leaked failure code.
    process.exitCode = 0;
    return;
  }

  let result;
  try {
    result = await main(args, { env, cwd, runChild, syncBoardStatus });
  } catch (err) {
    // Defensive: even an unexpected failure stays best-effort/non-fatal so it
    // never blocks the merge step that invoked this as a post-merge hook.
    result = { ok: true, skipped: true, reason: err?.message ?? "board sync failed" };
  }
  if (result.skipped) {
    stderr.write(`[post-merge-board-sync] no-op for PR #${args.pr}${args.issue ? ` / issue #${args.issue}` : ""}: ${result.reason}\n`);
  }
  process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[post-merge-board-sync] unexpected failure (non-fatal): ${error.message ?? error}\n`);
    process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: error.message ?? "board sync failed" }) + "\n");
    process.exitCode = 0;
  });
}

export { main, parseCliArgs, runCli };
