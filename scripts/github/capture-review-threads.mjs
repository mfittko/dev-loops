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
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
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
Exit codes:
  0   Success
  1   Error
`;
export function parseCaptureCliArgs(argv) {
  const args = [...argv];
  const options = {
    inputPath: undefined,
    outputPath: undefined,
    repo: undefined,
    pr: undefined,
    help: false,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--input") {
      options.inputPath = requireOptionValue(args, "--input");
      continue;
    }
    if (token === "--output") {
      options.outputPath = requireOptionValue(args, "--output");
      continue;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo");
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr"));
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
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
  stdout.write(`${JSON.stringify(payload)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
