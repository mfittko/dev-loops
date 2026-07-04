#!/usr/bin/env node
import process from "node:process";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { interpretTrackerLoopState } from "@dev-loops/core/loop/tracker-first-loop-state";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

function showHelp() {
  process.stdout.write(`Usage: detect-tracker-first-loop-state.mjs --repo <owner/name> --issue <number>
Detect tracker-first loop state for a GitHub issue.
Options:
  --repo <owner/name>   GitHub repository slug
  --issue <number>      GitHub issue number
  --help, -h            Show this help

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`);
  process.exit(0);
}

function parseCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      issue: { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const opts = { repo: null, issue: null };
  for (const token of tokens) {
    if (token.kind === "option") {
      if (token.name === "help") {
        if (token.value !== undefined) {
          throw new Error(`unknown argument: ${token.rawName}=${token.value}`);
        }
        showHelp();
      }
      if (token.name === "repo") {
        opts.repo = token.value ?? null;
        continue;
      }
      if (token.name === "issue") {
        opts.issue = token.value ?? null;
        continue;
      }
      if (token.name === "jq") {
        opts.jq = token.value;
        continue;
      }
      if (token.name === "silent") {
        opts.silent = true;
      }
    }
  }
  return opts;
}

async function main() {
  const rawOpts = parseCliArgs(process.argv.slice(2));
  if (!rawOpts.repo || !rawOpts.issue) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: "--repo and --issue required" }) + "\n"
    );
    process.exitCode = 1;
    return;
  }
  const repo = rawOpts.repo;
  const issue = rawOpts.issue;
  let rawState = "";
  let prContext = null;
  try {
    const issueJson = execFileSync(
      "gh",
      ["issue", "view", String(issue), "--repo", repo, "--json", "state,title", "--jq", ".state"],
      { encoding: "utf8" }
    ).trim();
    rawState = issueJson;
    try {
      const prJson = execFileSync(
        "gh",
        ["pr", "list", "--repo", repo, "--search", `${issue} in:body`, "--state", "open", "--json", "number,state,headRefName", "--jq", ".[0]"],
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
      ).trim();
      if (prJson) prContext = JSON.parse(prJson);
    } catch {
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      JSON.stringify({ ok: false, error: `gh command failed: ${message}` }) + "\n"
    );
    process.exitCode = 1;
    return;
  }
  const result = interpretTrackerLoopState({ trackerState: rawState, prContext });
  process.exitCode = emitResult(result, { jq: rawOpts.jq, silent: rawOpts.silent });
}
const isDirectRun =
  process.argv[1] && process.argv[1].includes("detect-tracker-first-loop-state.mjs");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
export { main };
