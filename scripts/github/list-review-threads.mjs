#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { isTrustedGraphqlComment, UNTRUSTED_COMMENT_REMEDY } from "@dev-loops/core/github/comment-trust";
import { authorMatchesFilter } from "./_review-thread-mutations.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

// Dedicated query: unlike capture-review-threads.mjs's REVIEW_THREADS_QUERY
// (which fetches ALL comments per thread), this tool needs only the FIRST
// comment per thread (the reply-resolve target), so the smaller page keeps
// listings cheap. Both queries paginate past 100 threads.
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
  "          comments(first: 100) {",
  "            pageInfo {",
  "              hasNextPage",
  "            }",
  "            nodes {",
  "              databaseId",
  "              body",
  "              authorAssociation",
  "              viewerDidAuthor",
  "              author {",
  "                login",
  "                __typename",
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
// Exported so callers that must distinguish a genuinely-truncated listing
// excerpt from a short, complete body that merely happens to end with the
// same ellipsis glyph (close-gate-findings.mjs's full-body join guard) can
// probe on length, not just on the trailing glyph.
export const BODY_EXCERPT_MAX_CHARS = 200;

const USAGE = `Usage: list-review-threads.mjs --repo <owner/name> --pr <number> [--unresolved-only] [--author <login>]
List review threads on a pull request with the thread id + first-comment
databaseId reply-resolve-review-thread.mjs needs, so a fixer pass can go
list -> reply-resolve without hand-written GraphQL.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
  --unresolved-only     Only include threads where isResolved is false
  --author <login>      Only include threads whose root (first) comment author matches
                        (case-insensitive; "copilot" matches any Copilot review
                        login variant; "all" matches every author)
Output (stdout, JSON):
  { "ok": true, "repo": "owner/name", "pr": N, "threads": [
    { "threadId": "...", "trusted": true, "commentId": N|null, "author": "..."|null,
      "bodyCommentId": N|null, "body": "...", "isResolved": bool, "isOutdated": bool,
      "path": "..."|null, "line": N|null }, ...
  ], "skippedUntrusted": [ { "threadId": "...", "authors": [...], "isResolved": bool, "remedy": "..." } ] }
  commentId and author belong to the root (first) comment, the reply target; body is the
  first trusted comment's text; bodyCommentId is the id of that trusted comment. "trusted": true is the ingestion marker consumers require.
  Comments from authors who are not an OWNER, MEMBER or COLLABORATOR (the Copilot
  reviewer and comments the reading identity authored itself excepted) are never listed
  (ADR 0238); a thread with only such comments appears in skippedUntrusted (omitted
  when empty), with author logins and no text. A thread with more than 100 comments
  and no trusted comment on the first page stays listed with an empty body.
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

function excerptBody(rawBody, max = BODY_EXCERPT_MAX_CHARS) {
  const text = typeof rawBody === "string" ? rawBody.trim() : "";
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

// ADR 0238: trust is decided here, at ingestion. The listing shows the text of the first
// TRUSTED comment of a thread; a thread with comments and none trusted is returned as
// `skipped` (author logins only, no text). commentId and author come from the root
// comment (ids and logins are not prompt text), so a reply targets a top-level comment.
// A thread whose comments connection has a next page is not provably all-untrusted:
// it stays listed (a blocker) with no text.
function normalizeThreadNode(node, bodyMax) {
  const comments = Array.isArray(node?.comments?.nodes) ? node.comments.nodes : [];
  const trustedComment = comments.find((comment) => isTrustedGraphqlComment(comment, { allowCopilot: true })) ?? null;
  const truncated = node?.comments?.pageInfo?.hasNextPage === true;
  if (trustedComment === null && comments.length > 0 && !truncated) {
    const authors = [...new Set(comments.map((comment) => (typeof comment?.author?.login === "string" && comment.author.login.length > 0 ? comment.author.login : "unknown")))];
    return { skipped: { threadId: typeof node?.id === "string" ? node.id : "", authors, isResolved: Boolean(node?.isResolved), remedy: UNTRUSTED_COMMENT_REMEDY } };
  }
  const rootComment = comments[0];
  const commentId = Number.isFinite(rootComment?.databaseId) ? rootComment.databaseId : null;
  // bodyCommentId is the comment whose text `body` carries: the full-body join keys on it, since
  // the root may be untrusted (empty body in the snapshot) while a trusted reply supplies the text.
  const bodyCommentId = Number.isFinite(trustedComment?.databaseId) ? trustedComment.databaseId : null;
  const authorLogin = rootComment?.author?.login;
  const author = typeof authorLogin === "string" && authorLogin.length > 0 ? authorLogin : null;
  return {
    threadId: typeof node?.id === "string" ? node.id : "",
    trusted: true, // ADR 0238 marker: consumers refuse a thread file without it
    commentId,
    bodyCommentId,
    author,
    body: excerptBody(trustedComment?.body, bodyMax),
    isResolved: Boolean(node?.isResolved),
    isOutdated: Boolean(node?.isOutdated),
    path: typeof node?.path === "string" ? node.path : null,
    line: typeof node?.line === "number" ? node.line : null,
  };
}

/** Trusted threads only (ADR 0238). Use fetchAllReviewThreadsWithSkips to also read the skipped untrusted threads. */
export async function fetchAllReviewThreads(target, options) {
  return (await fetchAllReviewThreadsWithSkips(target, options)).threads;
}

export async function fetchAllReviewThreadsWithSkips(
  { repo, pr },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild, bodyMax = BODY_EXCERPT_MAX_CHARS } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const threads = [];
  const skipped = [];
  let after = null;
  let pages = 0;
  // 10k threads at 100/page; same ceiling as capture-review-threads.mjs, so a
  // payload cycling cursors or inventing fresh ones forever fails closed.
  const MAX_PAGES = 100;
  while (true) {
    if (pages >= MAX_PAGES) {
      throw new Error(`Invalid review-threads GraphQL payload: pagination exceeded ${MAX_PAGES} pages without completing`);
    }
    pages += 1;
    const result = await runChild(ghCommand, buildQueryArgs({ owner, name, pr, after }), env);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.code}`;
      throw new Error(`gh command failed: ${detail}`);
    }
    const payload = parseJsonText(result.stdout);
    const { nodes, hasNextPage, endCursor } = readThreadsConnection(payload);
    for (const node of nodes) {
      const normalized = normalizeThreadNode(node, bodyMax);
      if (normalized.skipped) skipped.push(normalized.skipped);
      else threads.push(normalized);
    }
    if (!hasNextPage) {
      break;
    }
    if (!endCursor) {
      throw new Error("Invalid review-threads GraphQL payload: pageInfo.hasNextPage is true but endCursor is missing");
    }
    if (endCursor === after) {
      throw new Error("Invalid review-threads GraphQL payload: pagination did not advance (endCursor repeated)");
    }
    after = endCursor;
  }
  return { threads, skipped };
}

export function filterThreads(threads, { unresolvedOnly = false, author = undefined } = {}) {
  // "all" is a match-everything sentinel: bypass the author filter entirely so
  // threads with a missing/ghost first-comment author (author null) still list.
  // authorMatchesFilter deliberately rejects empty logins for its reply-resolve
  // callers, so routing "all" through it would drop those threads.
  const authorFilter = typeof author === "string" && author.trim().toLowerCase() === "all"
    ? undefined
    : author;
  return threads.filter((thread) => {
    if (unresolvedOnly && thread.isResolved) {
      return false;
    }
    if (authorFilter !== undefined && !authorMatchesFilter(thread.author, authorFilter)) {
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
  const { threads: allThreads, skipped } = await fetchAllReviewThreadsWithSkips({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const threads = filterThreads(allThreads, { unresolvedOnly: options.unresolvedOnly, author: options.author });
  const skippedUntrusted = options.unresolvedOnly ? skipped.filter((thread) => !thread.isResolved) : skipped;
  const result = { ok: true, repo: options.repo, pr: options.pr, threads, ...(skippedUntrusted.length > 0 ? { skippedUntrusted } : {}) };
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
