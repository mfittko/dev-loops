#!/usr/bin/env node
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { applyDevloopsBoard, resolveProjectSelector, findProject, parseItemRef } from "./_resolve-project.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { ghGraphql, resolveOwner } from "@dev-loops/core/github/gh";
import { validateProjectsRepo, discoverProjects, resolveProjectItem } from "@dev-loops/core/projects/projects-access";

const USAGE = `Usage: dev-loops queue remove --repo <owner/name> --project <number|id|board-uri> --item <number|node-id>
       (dev-loops project remove … is a back-compat alias)

Remove one mistakenly added item from a GitHub Projects V2 board. This is the
sanctioned writer for board-item removal; never run a raw deleteProjectV2Item
GraphQL mutation. Completion is proven by a direct item lookup after the delete,
because the whole-board listing is eventually consistent. Removal is not a
routine action: use it only to undo a wrong "queue add".

Options:
  --repo <owner/name>                 Required. Repository to scope the project search.
  --project <number|id|board-uri>     Project number, node ID, or board URI. When
                                      omitted, resolved from .devloops tracker.board.
  --item <number|node-id>             Required. Issue/PR number, or project item node ID.
  --help, -h                          Show this help.

Output (stdout):
  JSON: { ok: true, item: { itemId, issueNumber, prNumber, removed: true, verifiedAbsent: true } }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter / item still present after delete
  3 — project or item not found
`.trim();

const DELETE_ITEM = [
  "mutation($projectId:ID!, $itemId:ID!) {",
  "  deleteProjectV2Item(input:{projectId:$projectId, itemId:$itemId}) {",
  "    deletedItemId",
  "  }",
  "}",
].join("\n");

export function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE });
  const requireValue = (token, message) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) throw parseError(message);
    return v;
  };
  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      item: { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unexpected argument: ${token.value}`);
    if (token.kind !== "option") continue;
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
      case "item":
        args.item = requireValue(token, "--item requires a value (number or node ID)");
        break;
      default:
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter"))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
    }
  }
  return args;
}

function classifyExitCode(err) {
  if (["INVALID_REPO", "INVALID_PROJECT", "INVALID_ITEM", "INVALID_ARGS"].includes(err.code)) return 1;
  if (["PROJECT_NOT_FOUND", "ITEM_NOT_FOUND"].includes(err.code)) return 3;
  return 2;
}

export async function main(args, { env = process.env, runChild } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateProjectsRepo(args.repo);
  const [owner] = repo.split("/");
  const selector = resolveProjectSelector(args);
  const itemRef = parseItemRef(args.item);

  const projectOwner = selector.projectRef?.kind === "uri" ? selector.projectRef.owner : owner;
  const ownerKind = selector.projectRef?.kind === "uri"
    ? selector.projectRef.ownerKind
    : (await resolveOwner(owner, env, child)).kind;
  const project = findProject(await discoverProjects(projectOwner, ownerKind, env, child), selector, projectOwner);

  const match = await resolveProjectItem({ projectId: project.id, projectTitle: project.title, repo, itemRef, env, runChild: child });
  const issueNumber = match.content?.__typename === "PullRequest" ? null : (match.content?.number ?? null);
  const prNumber = match.content?.__typename === "PullRequest" ? match.content.number : null;

  const payload = await ghGraphql(DELETE_ITEM, { projectId: project.id, itemId: match.id }, env, child);
  if (!payload?.data?.deleteProjectV2Item?.deletedItemId) {
    throw Object.assign(new Error("Failed to remove item from project"), { code: "MUTATION_FAILED" });
  }

  // The direct lookup (not the eventually consistent board listing) must now
  // report the item absent; the lookup throws ITEM_NOT_FOUND exactly then.
  try {
    await resolveProjectItem({ projectId: project.id, projectTitle: project.title, repo, itemRef, env, runChild: child });
  } catch (err) {
    if (err?.code === "ITEM_NOT_FOUND") {
      return { ok: true, item: { itemId: match.id, issueNumber, prNumber, removed: true, verifiedAbsent: true } };
    }
    throw err;
  }
  throw Object.assign(new Error(`Item ${match.id} is still present on the board after the delete mutation`), { code: "REMOVAL_NOT_CONFIRMED" });
}

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
    return;
  }
  applyDevloopsBoard(args, cwd);
  try {
    const result = await main(args, { env });
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
