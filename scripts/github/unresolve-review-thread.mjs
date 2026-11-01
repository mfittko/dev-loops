#!/usr/bin/env node
import { execFile } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { isDirectCliRun } from "@dev-loops/core/cli/helpers";
import { parsePositiveInteger } from "@dev-loops/core/cli/primitives";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { isCopilotLogin, isGateMachineArtifactBody, matchGateReviewCommentHeader } from "@dev-loops/core/github/copilot-helpers";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { formatCliError } from "../_core-helpers.mjs";

const execFileAsync = promisify(execFile);

const USAGE = `Usage: dev-loops-run scripts/github/unresolve-review-thread.mjs --repo <owner/name> --pr <n> --thread-id <id>

Reopen a resolved review thread (undo of a wrong or premature resolve). Orchestrator and
dev-loop coordinator only; the fixer, review and judge agents are denied by the Bash hook.

Refuses with a named reason: thread_not_resolved, thread_not_on_pr, pr_closed_or_merged,
thread_author_not_reviewer (the thread's first comment is neither Copilot nor a gate review).

${JQ_OUTPUT_USAGE}`;

const THREAD_QUERY = `query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread {
  id isResolved
  pullRequest { number state repository { nameWithOwner } }
  comments(first: 1) { nodes { author { login } pullRequestReview { body } } }
} } }`;
const UNRESOLVE_MUTATION = `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;

export class UnresolveRefusal extends Error {
  constructor(reason, remedy) {
    super(`${reason}: ${remedy}`);
    this.reason = reason;
  }
}

async function ghRun(args) {
  return (await execFileAsync("gh", args, { env: process.env })).stdout;
}

async function gql(run, query, id) {
  let out;
  try {
    out = await run(["api", "graphql", "--raw-field", `id=${id}`, "--raw-field", `query=${query}`]);
  } catch (err) {
    if (/Could not resolve to a node/.test(`${err?.stderr ?? ""}${err?.message ?? ""}`)) return { data: { node: null } };
    throw err;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`Malformed gh JSON for thread ${id} (${query.trim().split("(")[0]}): ${err.message}`);
  }
}

export async function unresolveReviewThread({ repo, pr, threadId }, { run = ghRun } = {}) {
  const thread = (await gql(run, THREAD_QUERY, threadId))?.data?.node;
  const onPr = thread?.pullRequest;
  if (!thread?.id || onPr?.number !== pr || onPr?.repository?.nameWithOwner?.toLowerCase() !== repo.toLowerCase()) {
    throw new UnresolveRefusal("thread_not_on_pr",
      `thread ${threadId} is not on ${repo}#${pr}. Re-list threads with \`dev-loops gate capture-threads --repo ${repo} --pr ${pr}\` and pass an id from that snapshot.`);
  }
  if (onPr.state !== "OPEN") {
    throw new UnresolveRefusal("pr_closed_or_merged",
      `${repo}#${pr} is ${onPr.state}. Open a follow-up issue for the finding instead of reopening a thread on a closed PR.`);
  }
  if (!thread.isResolved) {
    throw new UnresolveRefusal("thread_not_resolved",
      `thread ${threadId} is already unresolved. Dispatch the fixer on it; no unresolve is needed.`);
  }
  // ponytail: a human review pasting a gate marker passes this author check; acceptable for a coordinator-only undo.
  const first = thread.comments?.nodes?.[0];
  const reviewBody = first?.pullRequestReview?.body ?? "";
  if (!isCopilotLogin(first?.author?.login) && !isGateMachineArtifactBody(reviewBody) && matchGateReviewCommentHeader(reviewBody) === null) {
    throw new UnresolveRefusal("thread_author_not_reviewer",
      `thread ${threadId} was not opened by Copilot or a gate review. Ask the operator to reopen a human thread in the GitHub UI, or post a new gate finding.`);
  }
  const result = (await gql(run, UNRESOLVE_MUTATION, threadId))?.data?.unresolveReviewThread?.thread;
  if (result?.isResolved !== false) throw new Error(`Review thread did not unresolve successfully: ${threadId}`);
  return { ok: true, threadId, isResolved: false };
}

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        "thread-id": { type: "string" },
        help: { type: "boolean", short: "h" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) return { help: true };
  for (const name of ["repo", "pr", "thread-id"]) {
    if (!values[name]) throw parseError(`Missing required option: --${name}`);
  }
  parseRepoSlug(values.repo);
  return {
    repo: values.repo,
    pr: parsePositiveInteger(values.pr, "--pr", parseError),
    threadId: values["thread-id"],
    jq: values.jq,
    silent: values.silent === true,
  };
}

async function main(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const jqSyntaxError = preflightJqFilter(parsed.jq, { stderr: process.stderr });
  if (jqSyntaxError !== undefined) return jqSyntaxError;
  const result = await unresolveReviewThread(parsed);
  return emitResult(result, { jq: parsed.jq, silent: parsed.silent });
}

if (isDirectCliRun(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = typeof code === "number" ? code : 0; },
    (error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
