#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatCliError,
  isDirectCliRun,
  parseJsonText,
  parseReviewThreads,
  readInput,
} from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
export const REVIEW_THREADS_QUERY = [
  "query($owner: String!, $name: String!, $pr: Int!) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $pr) {",
  "      reviewThreads(first: 100) {",
  "        nodes {",
  "          id",
  "          isResolved",
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
const HELP = `Usage: capture-review-threads.mjs [--input <path> | --repo <owner/name> --pr <number>] [--output <path>]
Capture review threads from a GitHub PR or from a local JSON snapshot.
Modes:
  --input <path>                Read JSON snapshot from file
  (no mode flag)                Read JSON snapshot from stdin
  --repo <owner/name> --pr <n>  Fetch live review threads from GitHub PR
Options:
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
    if (token.name === "jq") {
      options.jq = requireTokenValue(token);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token.rawName}`);
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
export async function fetchGithubReviewThreadsPayload(
  { repo, pr },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const result = await runChild(
    ghCommand,
    [
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
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout);
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
  let source;
  let parsed;
  if (options.repo && options.pr !== undefined) {
    source = {
      type: "github",
      repo: options.repo,
      pr: options.pr,
    };
    parsed = parseReviewThreads(await fetchGithubReviewThreadsPayload(
      { repo: options.repo, pr: options.pr },
      { env, ghCommand },
    ));
  } else if (options.inputPath) {
    source = {
      type: "input",
      inputPath: options.inputPath,
    };
    parsed = parseReviewThreads(parseJsonText(await readInput({ inputPath: options.inputPath, stdin })));
  } else {
    source = { type: "stdin" };
    parsed = parseReviewThreads(parseJsonText(await readInput({ stdin })));
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
