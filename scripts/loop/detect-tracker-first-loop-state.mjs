#!/usr/bin/env node
import process from "node:process";
import { execFileSync } from "node:child_process";
import { interpretTrackerLoopState } from "@dev-loops/core/loop/tracker-first-loop-state";
function showHelp() {
  process.stdout.write(`Usage: detect-tracker-first-loop-state.mjs --repo <owner/name> --issue <number>
Detect tracker-first loop state for a GitHub issue.
Options:
  --repo <owner/name>   GitHub repository slug
  --issue <number>      GitHub issue number
  --help, -h            Show this help
Exit codes:
  0   Success
  1   Error
`);
  process.exit(0);
}
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { repo: null, issue: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      showHelp();
    }
    if (args[i] === "--repo" && i + 1 < args.length) opts.repo = args[++i];
    else if (args[i] === "--issue" && i + 1 < args.length) opts.issue = args[++i];
  }
  return opts;
}
async function main() {
  const opts = parseArgs();
  if (!opts.repo || !opts.issue) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: "--repo and --issue required" }) + "\n"
    );
    process.exitCode = 1;
    return;
  }
  let rawState = "";
  let prContext = null;
  try {
    const issueJson = execFileSync(
      "gh",
      ["issue", "view", String(opts.issue), "--repo", opts.repo, "--json", "state,title", "--jq", ".state"],
      { encoding: "utf8" }
    ).trim();
    rawState = issueJson;
    try {
      const prJson = execFileSync(
        "gh",
        ["pr", "list", "--repo", opts.repo, "--search", `${opts.issue} in:body`, "--state", "open", "--json", "number,state,headRefName", "--jq", ".[0]"],
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
  process.stdout.write(JSON.stringify(result) + "\n");
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
