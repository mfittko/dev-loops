#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { authorMatchesFilter } from "./_review-thread-mutations.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

// Dedicated query: unlike capture-review-threads.mjs's REVIEW_THREADS_QUERY
// (all comments, no path/line/isOutdated, no pagination past 100), this tool
// needs only the FIRST comment per thread (the reply-resolve target) plus the
// thread-level path/line/isOutdated fields, and must paginate past 100 threads.
export const LIST_REVIEW_THREADS_QUERY = [
  "query($owner: String!, $name: String!, $pr: Int!, $after: String) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $pr) {",
  "      reviewThreads(first: 100, after: $after) {",
  "        pageInfo {",
  "          hasNextPage",
  "          endCursor",
  "        }",
  "        nodes {",
  "          id",
  "          isResolved",
  "          isOutdated",
  "          path",
  "          line",
  "          comments(first: 1) {",
  "            nodes {",
  "              databaseId",
  "              body",
  "              author {",
  "                login",
  "              }",
  "            }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

// Bounded excerpt so a listing over many threads stays scannable; full body
// text is available from capture-review-threads.mjs when actually needed.
const BODY_EXCERPT_MAX_CHARS = 200;

const USAGE = `Usage: list-review-threads.mjs --repo <owner/name> --pr <number> [--unresolved-only] [--author <login>]
List review threads on a pull request with the thread id + first-comment
databaseId reply-resolve-review-thread.mjs needs, so a fixer pass can go
list -> reply-resolve without hand-written GraphQL.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --unresolved-only     Only include threads where isResolved is false
  --author <login>      Only include threads whose first comment author matches
                        (case-insensitive; "copilot" matches any Copilot review
                        login variant; "all" matches every author)
Output (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": N, "threads": [
    { "threadId": "...", "commentId": N|null, "author": "..."|null,
      "body": "...", "isResolved": bool, "isOutdated": bool,
      "path": "..."|null, "line": N|null }, ...
  ] }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

export function parseListReviewThreadsCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "unresolved-only": { type: "boolean" },
      author: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    unresolvedOnly: false,
    author: undefined,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "unresolved-only") {
      options.unresolvedOnly = true;
      continue;
    }
    if (token.name === "author") {
      options.author = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("Listing review threads requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

function buildQueryArgs({ owner, name, pr, after }) {
  const args = [
    "api",
    "graphql",
    "--field",
    `owner=${owner}`,
    "--field",
    `name=${name}`,
    "--field",
    `pr=${pr}`,
    "--field",
    `query=${LIST_REVIEW_THREADS_QUERY}`,
  ];
  if (typeof after === "string" && after.length > 0) {
    args.push("--field", `after=${after}`);
  }
  return args;
}

function readThreadsConnection(payload) {
  const connection = payload?.data?.repository?.pullRequest?.reviewThreads;
  if (!connection || typeof connection !== "object") {
    throw new Error("Invalid review-threads GraphQL payload: missing data.repository.pullRequest.reviewThreads");
  }
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const pageInfo = connection.pageInfo ?? {};
  return {
    nodes,
    hasNextPage: Boolean(pageInfo.hasNextPage),
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
  };
}

function excerptBody(rawBody) {
  const text = typeof rawBody === "string" ? rawBody.trim() : "";
  if (text.length <= BODY_EXCERPT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, BODY_EXCERPT_MAX_CHARS)}…`;
}

function normalizeThreadNode(node) {
  const firstComment = node?.comments?.nodes?.[0] ?? null;
  const commentId = Number.isFinite(firstComment?.databaseId) ? firstComment.databaseId : null;
  const authorLogin = firstComment?.author?.login;
  const author = typeof authorLogin === "string" && authorLogin.length > 0 ? authorLogin : null;
  return {
    threadId: typeof node?.id === "string" ? node.id : "",
    commentId,
    author,
    body: excerptBody(firstComment?.body),
    isResolved: Boolean(node?.isResolved),
    isOutdated: Boolean(node?.isOutdated),
    path: typeof node?.path === "string" ? node.path : null,
    line: typeof node?.line === "number" ? node.line : null,
  };
}

export async function fetchAllReviewThreads(
  { repo, pr },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const threads = [];
  let after = null;
  while (true) {
    const result = await runChild(ghCommand, buildQueryArgs({ owner, name, pr, after }), env);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`gh command failed: ${detail}`);
    }
    const payload = parseJsonText(result.stdout);
    const { nodes, hasNextPage, endCursor } = readThreadsConnection(payload);
    for (const node of nodes) {
      threads.push(normalizeThreadNode(node));
    }
    if (!hasNextPage) {
      break;
    }
    if (!endCursor) {
      throw new Error("Invalid review-threads GraphQL payload: pageInfo.hasNextPage is true but endCursor is missing");
    }
    after = endCursor;
  }
  return threads;
}

export function filterThreads(threads, { unresolvedOnly = false, author = undefined } = {}) {
  return threads.filter((thread) => {
    if (unresolvedOnly && thread.isResolved) {
      return false;
    }
    if (author !== undefined && !authorMatchesFilter(thread.author, author)) {
      return false;
    }
    return true;
  });
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseListReviewThreadsCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const allThreads = await fetchAllReviewThreads({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const threads = filterThreads(allThreads, { unresolvedOnly: options.unresolvedOnly, author: options.author });
  const result = { ok: true, repo: options.repo, pr: options.pr, threads };
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  }).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
