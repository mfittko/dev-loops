#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseIssueNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
const ISSUE_JSON_FIELDS = "number,title,body,url,state";
const USAGE = `Usage: resolve-tracker-local-spec.mjs (--repo <owner/name> --issue <number> | --issue-url <github-issue-url>)
Resolve the canonical tracker-backed local spec bundle from one GitHub issue reference.
This helper is intentionally bounded to the GitHub-backed tracker path and does not
create or read docs/phases/phase-<n>.md.
Allowed inputs:
  --repo <owner/name>      Repository slug (must be paired with --issue)
  --issue <number>         Issue number (must be paired with --repo)
  --issue-url <url>        Full GitHub issue URL (alternative to --repo/--issue)
Success output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/name",
    "issue": 85,
    "issueUrl": "https://github.com/owner/repo/issues/85",
    "state": "OPEN"|"CLOSED",
    "title": "...",
    "body": "...",
    "canonicalSpecSource": "tracker_issue",
    "localImplementationMode": "tracker_backed",
    "localPhaseDocAllowed": false,
    "stateSync": "tracker_issue_is_canonical"
  }
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);
export function parseGitHubIssueUrl(value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw parseError("--issue-url must be a valid GitHub issue URL");
  }
  if (!/^https?:$/i.test(parsedUrl.protocol) || parsedUrl.hostname.toLowerCase() !== "github.com") {
    throw parseError("--issue-url must be a valid GitHub issue URL");
  }
  const [owner, name, issueMarker, issueNumber, ...rest] = parsedUrl.pathname.split("/").filter(Boolean);
  if (rest.length > 0 || issueMarker !== "issues") {
    throw parseError("--issue-url must be a valid GitHub issue URL");
  }
  const repo = `${owner ?? ""}/${name ?? ""}`;
  try {
    parseRepoSlug(repo, { errorMessage: "--issue-url must be a valid GitHub issue URL" });
  } catch (error) {
    throw parseError("--issue-url must be a valid GitHub issue URL");
  }
  if (!/^\d+$/.test(issueNumber ?? "") || Number(issueNumber) === 0) {
    throw parseError("--issue-url must be a valid GitHub issue URL");
  }
  return {
    repo,
    issue: Number(issueNumber),
  };
}
export function parseResolveTrackerLocalSpecCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      "issue-url": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    issue: undefined,
    issueUrl: undefined,
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
    if (token.name === "issue") {
      options.issue = parseIssueNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "issue-url") {
      options.issueUrl = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "jq") {
      options.jq = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "silent") {
      options.silent = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const usingIssueUrl = typeof options.issueUrl === "string";
  const usingRepoIssue = options.repo !== undefined || options.issue !== undefined;
  if (usingIssueUrl && usingRepoIssue) {
    throw parseError("Use either --issue-url <url> or --repo <owner/name> with --issue <number>, but not both");
  }
  if (!usingIssueUrl && (options.repo === undefined || options.issue === undefined)) {
    throw parseError("Tracker spec resolution requires either --issue-url <url> or both --repo <owner/name> and --issue <number>");
  }
  if (usingIssueUrl) {
    const { repo, issue } = parseGitHubIssueUrl(options.issueUrl);
    return {
      help: false,
      repo,
      issue,
      issueUrl: options.issueUrl,
      ...(options.jq !== undefined ? { jq: options.jq } : {}),
      ...(options.silent !== undefined ? { silent: options.silent } : {}),
    };
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function buildIssueViewArgs({ repo, issue }) {
  return [
    "issue",
    "view",
    String(issue),
    "--repo",
    repo,
    "--json",
    ISSUE_JSON_FIELDS,
  ];
}
function readIssuePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid tracker issue payload: expected object");
  }
  const number = payload.number;
  const title = payload.title;
  const body = payload.body;
  const url = payload.url;
  const state = payload.state;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Invalid tracker issue payload: missing positive issue number");
  }
  if (typeof title !== "string") {
    throw new Error("Invalid tracker issue payload: missing title");
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Invalid tracker issue payload: missing issue URL");
  }
  if (typeof state !== "string" || state.length === 0) {
    throw new Error("Invalid tracker issue payload: missing state");
  }
  return {
    number,
    title,
    body: typeof body === "string" ? body : "",
    url,
    state,
  };
}
export async function resolveTrackerLocalSpec(
  { repo, issue },
  { env = process.env, ghCommand = "gh" } = {},
) {
  const { owner, name } = parseRepoSlug(repo);
  const canonicalRepo = `${owner}/${name}`;
  const result = await runChild(
    ghCommand,
    buildIssueViewArgs({ repo: canonicalRepo, issue }),
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  const resolvedIssue = readIssuePayload(payload);
  return {
    ok: true,
    repo: canonicalRepo,
    issue: resolvedIssue.number,
    issueUrl: resolvedIssue.url,
    state: resolvedIssue.state,
    title: resolvedIssue.title,
    body: resolvedIssue.body,
    canonicalSpecSource: "tracker_issue",
    localImplementationMode: "tracker_backed",
    localPhaseDocAllowed: false,
    stateSync: "tracker_issue_is_canonical",
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseResolveTrackerLocalSpecCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await resolveTrackerLocalSpec(
    { repo: options.repo, issue: options.issue },
    { env, ghCommand },
  );
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
