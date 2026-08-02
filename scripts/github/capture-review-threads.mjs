#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatCliError,
  isDirectCliRun,
  parseJsonText,
  parseReviewThreads,
  parseUnresolvedThreadBodies,
  readInput,
} from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { isGhBinaryMissing, restGraphqlJson } from "./_gh-rest-fallback.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
export const REVIEW_THREADS_QUERY = [
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
  "            nodes {",
  "              id",
  "              databaseId",
  "              body",
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
const HELP = `Usage: capture-review-threads.mjs [--input <path> | --repo <owner/name> --pr <number>] [--unresolved --bodies] [--output <path>]
Capture review threads from a GitHub PR or from a local JSON snapshot.
Modes:
  --input <path>                Read JSON snapshot from file
  (no mode flag)                Read JSON snapshot from stdin
  --repo <owner/name> --pr <n>  Fetch live review threads from GitHub PR
Options:
  --unresolved --bodies
                    Emit the fix-loop working set instead of the full capture:
                    only unresolved threads, each as
                    { threadId, path, line, isOutdated, bodies: [...] } with the
                    thread's comment bodies joined in order (plus the summary
                    block). Resolved threads are absent. The two flags are only
                    valid together; the default output shape is unchanged when
                    they are omitted. Canonical loop re-entry read — no
                    post-processing needed beyond --jq '.threads[]'.
  --output <path>   Write JSON output to file in addition to stdout
  --help, -h        Show this help
${JQ_OUTPUT_USAGE}
Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;
export function parseCaptureCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      output: { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      unresolved: { type: "boolean" },
      bodies: { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    inputPath: undefined,
    outputPath: undefined,
    repo: undefined,
    pr: undefined,
    unresolved: false,
    bodies: false,
    help: false,
    jq: undefined,
    silent: false,
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw new Error(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "input") {
      options.inputPath = requireTokenValue(token);
      continue;
    }
    if (token.name === "output") {
      options.outputPath = requireTokenValue(token);
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token);
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token));
      continue;
    }
    if (token.name === "unresolved" || token.name === "bodies") {
      if (token.value !== undefined) {
        throw new Error(`${token.rawName} is a bare flag and takes no value (got "${token.value}")`);
      }
      options[token.name] = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t))) continue;
    throw new Error(`Unknown argument: ${token.rawName}`);
  }
  if (options.unresolved !== options.bodies) {
    throw new Error("--unresolved and --bodies are only valid together (the working-set view has one shape)");
  }
  const hasLiveArgs = options.repo !== undefined || options.pr !== undefined;
  const hasCompleteLiveArgs = options.repo !== undefined && options.pr !== undefined;
  if (hasLiveArgs && !hasCompleteLiveArgs) {
    throw new Error("Live GitHub capture requires both --repo <owner/name> and --pr <number>");
  }
  if (options.inputPath && hasCompleteLiveArgs) {
    throw new Error("Choose exactly one input source: --input <path>, stdin, or live --repo/--pr");
  }
  return options;
}
function readThreadsConnection(payload) {
  const connection = payload?.data?.repository?.pullRequest?.reviewThreads ?? payload?.data?.node?.reviewThreads;
  if (connection && typeof connection === "object" && !Array.isArray(connection)) {
    const pageInfo = connection.pageInfo ?? {};
    return {
      nodes: Array.isArray(connection.nodes) ? connection.nodes : [],
      hasNextPage: Boolean(pageInfo.hasNextPage),
      endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
    };
  }
  // Legacy/snapshot shapes (plain array, { threads }, { reviewThreads } — the
  // same candidates parseReviewThreads accepts): a single page, no pagination.
  const candidates = [payload, payload?.threads, payload?.reviewThreads, payload?.reviewThreads?.nodes];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return { nodes: candidate, hasNextPage: false, endCursor: null };
    }
  }
  throw new Error("Could not find review threads in payload");
}

// Falls back to a direct GraphQL POST (GH_TOKEN/GITHUB_TOKEN) ONLY when spawning
// the `gh` binary itself fails (ENOENT — not on PATH), so a gh-less session can
// still verify review-thread resolution state (#1358). Any other `gh` failure
// (auth, rate limit) surfaces as a real error, unchanged.
//
// Paginates past 100 threads (resolved threads consume the same page budget, so
// the working-set view must walk every page to honor "exactly the unresolved
// threads"). Returns the merged raw thread-node array, which the parsers accept
// directly.
export async function fetchGithubReviewThreadsPayload(
  { repo, pr },
  { env = process.env, ghCommand = "gh", runChild = defaultRunChild } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const nodes = [];
  let after = null;
  let useRestFallback = false;
  while (true) {
    let payload;
    if (useRestFallback) {
      payload = await restGraphqlJson(REVIEW_THREADS_QUERY, { owner, name, pr, after }, env);
    } else {
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
        `query=${REVIEW_THREADS_QUERY}`,
      ];
      if (typeof after === "string" && after.length > 0) {
        args.push("--field", `after=${after}`);
      }
      let result;
      try {
        result = await runChild(ghCommand, args, env);
      } catch (error) {
        if (isGhBinaryMissing(error)) {
          useRestFallback = true;
          continue;
        }
        throw error;
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || `exit code ${result.code}`;
        throw new Error(`gh command failed: ${detail}`);
      }
      payload = parseJsonText(result.stdout);
    }
    const page = readThreadsConnection(payload);
    nodes.push(...page.nodes);
    if (!page.hasNextPage) {
      break;
    }
    if (!page.endCursor) {
      throw new Error("Invalid review-threads GraphQL payload: pageInfo.hasNextPage is true but endCursor is missing");
    }
    if (page.endCursor === after) {
      throw new Error("Invalid review-threads GraphQL payload: pagination did not advance (endCursor repeated)");
    }
    after = page.endCursor;
  }
  return nodes;
}
function createSuccessPayload(source, result, outputPath) {
  return {
    ok: true,
    source,
    ...(outputPath ? { outputPath } : {}),
    ...result,
  };
}
async function writeOutputFile(outputPath, payload) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdin = process.stdin,
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
  } = {},
) {
  const options = parseCaptureCliArgs(argv);
  if (options.help) {
    stdout.write(HELP);
    return;
  }
  const parse = options.unresolved ? parseUnresolvedThreadBodies : parseReviewThreads;
  let source;
  let parsed;
  if (options.repo && options.pr !== undefined) {
    source = {
      type: "github",
      repo: options.repo,
      pr: options.pr,
    };
    parsed = parse(await fetchGithubReviewThreadsPayload(
      { repo: options.repo, pr: options.pr },
      { env, ghCommand },
    ));
  } else if (options.inputPath) {
    source = {
      type: "input",
      inputPath: options.inputPath,
    };
    parsed = parse(parseJsonText(await readInput({ inputPath: options.inputPath, stdin })));
  } else {
    source = { type: "stdin" };
    parsed = parse(parseJsonText(await readInput({ stdin })));
  }
  const payload = createSuccessPayload(source, parsed, options.outputPath);
  if (options.outputPath) {
    await writeOutputFile(options.outputPath, payload);
  }
  return emitResult(payload, { jq: options.jq, silent: options.silent, stdout });
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
