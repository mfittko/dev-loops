#!/usr/bin/env node
// Discover issues parked in the non-pickup park column WITHOUT a refinement
// artifact — the fail-safe backstop diverts un-refined issues here rather than
// into the pickup column. This is the deterministic query a headless/auto
// dev-loop session uses to find items it should auto-refine (via the refiner /
// loop-grill --auto) and then promote into the pickup column (via `queue move`;
// an already-parked item is on the board, so `add-queue-item` is a no-op for it).
// It is PURE-DETERMINISTIC: it reads the
// board (list-queue-items) and each issue body (gh issue view) and runs the
// single-source refinement-completeness module (detectIssueRefinementArtifact).
// It NEVER grills, NEVER synthesizes ACs, and runs NO LLM / inline interpreter —
// synthesizing the missing artifact is an orchestration-layer responsibility,
// not this script's.
//
// The park column is the configured queue.nonSuccessStatus (default "Backlog");
// PRs are skipped because the refinement gate is issue-only.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { main as listQueueItems } from "./list-queue-items.mjs";
import { fetchIssueBody } from "../loop/detect-issue-refinement-artifact.mjs";
import { applyDevloopsBoard } from "./_resolve-project.mjs";
import { nonSuccessBoardColumn } from "@dev-loops/core/loop/queue-board-sync";
import { detectIssueRefinementArtifact, REFINEMENT_ARTIFACT_SOURCES } from "@dev-loops/core/loop/issue-refinement-artifact";

const USAGE = `Usage: dev-loops queue parked-unrefined --repo <owner/name> [--project <number|id>]

List issues parked in the non-pickup park column (queue.nonSuccessStatus,
default "Backlog") that carry NO refinement artifact — the items a headless/
auto dev-loop session should auto-refine (refiner / loop-grill --auto) and then
promote into the pickup column (via queue move). Deterministic: reads the board + each issue body and runs the same
refinement-completeness check as the enqueue gate. It never grills or mutates.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Project number (integer) or node ID. When omitted,
                          resolved from .devloops queue.board.number /
                          queue.board.title.
  --help, -h              Show this help.

Output (stdout):
  JSON: { ok: true, parkedColumn, items: [ { issueNumber, title, url, itemId,
          finding, reason, missing } ... ] }
  items lists ONLY un-refined issues in the park column (refined issues and PRs
  are excluded). An empty array means nothing is parked awaiting refinement.

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success (list may be empty)
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
  if (!args.help && (typeof args.repo !== "string" || args.repo.length === 0)) {
    throw Object.assign(new Error("--repo is required (owner/name)"), { usage: USAGE, code: "INVALID_REPO" });
  }
  return args;
}

async function main(args, { env = process.env, runChild = _runChild, cwd = process.cwd() } = {}) {
  // The park column is where the enqueue fail-safe diverts un-refined issues.
  const parkedColumn = nonSuccessBoardColumn(cwd);
  const listed = await listQueueItems(
    { repo: args.repo, project: args.project, column: parkedColumn },
    { env, runChild },
  );
  const items = listed.items ?? [];

  const unrefined = [];
  for (const item of items) {
    // Issue-only: a PR in the park column is not gated by the refinement check.
    if (item.issueNumber == null) continue;
    const body = await fetchIssueBody(
      { repo: args.repo, issue: item.issueNumber },
      { env, runChild },
    );
    const artifact = detectIssueRefinementArtifact({ body, issueNumber: item.issueNumber });
    // finding !== null is the explicit "has NO refinement artifact" signal.
    if (artifact.finding === null) continue;
    unrefined.push({
      issueNumber: item.issueNumber,
      title: item.title ?? null,
      url: item.url ?? null,
      itemId: item.itemId ?? null,
      finding: artifact.finding,
      reason: artifact.reason,
      // The three artifact sources any ONE of which clears the gate — the same
      // single-source vocabulary the enqueue gate reports (one taxonomy, no drift).
      missing: [...REFINEMENT_ARTIFACT_SOURCES],
    });
  }

  return { ok: true, parkedColumn, items: unrefined };
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

  // Resolve the board from .devloops when --project is absent.
  applyDevloopsBoard(args, cwd);

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
