#!/usr/bin/env node
// Reconcile board Status columns from live GitHub state. For each queue
// item it derives the target column from live facts (merged PR / closed issue →
// Done; open ready non-draft PR → In Progress) and moves ONLY the items whose
// derived column differs from their current Status. Backlog/Next Up ordering is
// left untouched (items that derive null are skipped). Idempotent: a second run
// over a converged board performs no moves.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { applyDevloopsBoard } from "./_resolve-project.mjs";
import { main as listQueueItems } from "./list-queue-items.mjs";
import { main as moveQueueItem } from "./move-queue-item.mjs";
import { detectLinkedIssuePrs } from "@dev-loops/core/github/issue-ops";
import { planReconcile, loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";

const USAGE = `Usage: dev-loops queue reconcile --repo <owner/name> [--project <number|id|board-uri>]
       (dev-loops project reconcile … is a back-compat alias)

Reconcile board Status columns from live GitHub state. Derives each item's
target column from live GitHub facts (merged PR or closed issue → Done; an open,
ready non-draft PR → In Progress) and moves ONLY the items whose derived column
differs from their current Status. Backlog/Next Up ordering is left untouched.
Idempotent: a second run over a converged board performs no moves. Best-effort:
individual per-item failures are recorded but do not fail the run.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id|board-uri>
                          Project number (integer), node ID, or board URI. When
                          omitted, resolved from .devloops tracker.board number /
                          title.
  --help, -h              Show this help.

Output (stdout):
  JSON: { ok: true, moved, unchanged, reconciled: [{ number, from, to, ok }, ...] }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success (reconcile is best-effort; per-item failures do not fail the run)
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — project, field, or column not found
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

// Real live-facts gatherer. Item state comes from the board listing
// (item.contentState); open issues share one batched linked-PR query. Keyed by
// the stable item node id (item.itemId), not the bare number, so a multi-repo
// board where two items share a number cannot collide. Best-effort: an item
// without contentState, or an issue missing from the batch result, records
// inert facts → derives null → untouched. No per-item gh call is made.
export async function gatherLiveFacts(items, repo, { env, runChild, doneColumn } = {}) {
  const eligible = items.filter((item) => {
    const number = item.prNumber != null ? item.prNumber : item.issueNumber;
    if (number == null || item.itemId == null) return false;
    // Done is terminal for reconcile; planReconcile treats a missing fact as
    // unchanged. At loop startup (doneColumn set) Done items are skipped. An
    // explicit `dev-loops queue reconcile` run passes no doneColumn, so Done
    // items ARE gathered and a reopened/re-linked artifact can leave Done.
    if (doneColumn != null && item.status === doneColumn) return false;
    return true;
  });

  const isOpenIssue = (item) => item.prNumber == null && String(item.contentState ?? "").toUpperCase() === "OPEN";
  const openIssues = eligible.filter(isOpenIssue).map((item) => item.issueNumber);
  const linked = openIssues.length > 0
    ? await detectLinkedIssuePrs({ repo, issues: openIssues }, { env, runChild })
    : new Map();

  return new Map(eligible.map((item) => {
    const state = String(item.contentState ?? "").toUpperCase();
    if (item.prNumber != null) {
      return [item.itemId, { itemKind: "pr", issueState: null, prState: state || null, prIsDraft: null }];
    }
    if (state === "CLOSED") {
      return [item.itemId, { itemKind: "issue", issueState: "CLOSED", prState: null, prIsDraft: null }];
    }
    const prState = isOpenIssue(item) && linked.get(item.issueNumber) === true ? "OPEN" : null;
    return [item.itemId, { itemKind: "issue", issueState: "OPEN", prState, prIsDraft: null }];
  }));
}

async function main(args, { env = process.env, runChild, cwd = process.cwd(), listItems, gatherFacts, moveItem, skipTerminalColumn = false } = {}) {
  // Resolve the board from .devloops when --project is absent. Idempotent (only
  // mutates when args.project === undefined), so callers that reach main()
  // directly (e.g. the loop-startup self-heal) still resolve the board.
  applyDevloopsBoard(args, cwd);

  const list = await (listItems ?? ((a, o) => listQueueItems(a, o)))(
    { repo: args.repo, project: args.project, projectTitle: args.projectTitle },
    { env, runChild },
  );
  const items = list.items ?? [];

  const { columnNames } = loadStateColumnMap(cwd);

  // Loop startup (skipTerminalColumn: true) skips Done items for speed. An
  // explicit CLI run (default false) leaves doneColumn null so Done items are
  // gathered and a reopened/re-linked artifact can be recovered out of Done.
  const doneColumn = skipTerminalColumn ? columnNames[LOGICAL_COLUMN.DONE] : null;

  const factsByItemId = await (gatherFacts ?? ((its, repo, o) => gatherLiveFacts(its, repo, o)))(
    items,
    args.repo,
    { env, runChild, doneColumn },
  );

  const { moves, unchanged } = planReconcile(items, factsByItemId, columnNames);

  const move = moveItem ?? ((a, o) => moveQueueItem(a, o));
  const reconciled = [];
  let moved = 0;
  for (const m of moves) {
    try {
      // Move by the stable item node id (move-queue-item accepts a node id per
      // its `--item <number|node-id>` contract) so a multi-repo number collision
      // can never target the wrong item.
      await move(
        { repo: args.repo, project: args.project, projectTitle: args.projectTitle, item: m.itemId, toColumn: m.to },
        { env, runChild },
      );
      reconciled.push({ number: m.number, from: m.from, to: m.to, ok: true });
      moved += 1;
    } catch (err) {
      // Best-effort: a single failed move does not abort the reconcile loop.
      reconciled.push({ number: m.number, from: m.from, to: m.to, ok: false, error: err?.message ?? "move failed" });
    }
  }

  return { ok: true, moved, unchanged, reconciled };
}

function classifyExitCode(err) {
  if (err.code === "INVALID_ARGS" || err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND") return 3;
  return 2;
}

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

  try {
    const result = await main(args, { env, runChild, cwd });
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
