#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildDraftReviewPayload } from "@dev-loops/core/loop/reviewer-loop-state";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const HELP = `Usage: stage-reviewer-draft.mjs --repo <owner/name> --pr <number> --review-file <path> [--local-state-output <path>]
Stage a pending draft review on a GitHub pull request.
Options:
  --repo <owner/name>       GitHub repository slug (required)
  --pr <number>             Pull request number (required)
  --review-file <path>      Path to JSON file containing review payload (required)
  --local-state-output <path>  Path to write local state snapshot (optional)
  --help, -h                Show this help

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;
export function parseStageDraftCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "review-file": { type: "string" },
      "local-state-output": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    repo: undefined,
    pr: undefined,
    reviewFile: undefined,
    localStateOutput: undefined,
    help: false,
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
    if (token.name === "repo") {
      options.repo = requireTokenValue(token).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePositiveInteger(requireTokenValue(token), "--pr");
      continue;
    }
    if (token.name === "review-file") {
      options.reviewFile = requireTokenValue(token);
      continue;
    }
    if (token.name === "local-state-output") {
      options.localStateOutput = requireTokenValue(token);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t))) continue;
    throw new Error(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || !options.pr || !options.reviewFile) {
    throw new Error(
      "Staging a reviewer draft requires --repo <owner/name>, --pr <number>, and --review-file <path>",
    );
  }
  parseRepoSlug(options.repo);
  return options;
}
function runChild(command, args, env, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (stdinText === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdinText);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from gh: ${text.trim() || "<empty>"}`);
  }
}
function parseDraftReviewResponse(payload) {
  const reviewId = payload?.id;
  const reviewUrl = typeof payload?.html_url === "string"
    ? payload.html_url
    : (typeof payload?._links?.html?.href === "string" ? payload._links.html.href : null);
  const state = typeof payload?.state === "string" ? payload.state.toUpperCase() : null;
  const commitSha = typeof payload?.commit_id === "string" && payload.commit_id.trim().length > 0
    ? payload.commit_id.trim()
    : null;
  if (!Number.isFinite(reviewId) || !reviewUrl || state !== "PENDING" || !commitSha) {
    throw new Error("Draft review payload from gh did not include id, url, PENDING state, and commit_id");
  }
  return { reviewId, reviewUrl, state, commitSha };
}
async function postDraftReview({ repo, pr, reviewPayload }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", "-X", "POST", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"],
    env,
    `${JSON.stringify(reviewPayload)}\n`,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJson(result.stdout);
}
async function writeLocalState(pathname, fragment) {
  if (!pathname) {
    return null;
  }
  let current = {};
  try {
    const text = await readFile(pathname, "utf8");
    const parsed = parseJsonText(text);
    if (parsed && typeof parsed === "object") {
      current = parsed;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }
  const next = {
    ...current,
    draftReviewPrepared: true,
    draftReviewPosted: true,
    draftReviewId: fragment.reviewId,
    draftReviewUrl: fragment.reviewUrl,
    draftReviewCommitSha: fragment.commitSha,
    draftReviewNotificationStatus: "none",
  };
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return pathname;
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
  const options = parseStageDraftCliArgs(argv);
  if (options.help) {
    stdout.write(HELP);
    return;
  }
  const rawReview = parseJsonText(await readFile(options.reviewFile, "utf8"));
  if (!rawReview || typeof rawReview !== "object") {
    throw new Error("--review-file must contain a JSON object");
  }
  const reviewPayload = buildDraftReviewPayload(rawReview);
  if (!reviewPayload.commit_id) {
    throw new Error("Merged review payload must include headSha so the pending review is pinned to a commit");
  }
  const draftReview = parseDraftReviewResponse(
    await postDraftReview({ repo: options.repo, pr: options.pr, reviewPayload }, { env, ghCommand }),
  );
  const localStatePath = await writeLocalState(options.localStateOutput, draftReview);
  process.exitCode = emitResult({
    ok: true,
    repo: options.repo,
    pr: options.pr,
    reviewId: draftReview.reviewId,
    reviewUrl: draftReview.reviewUrl,
    reviewState: draftReview.state,
    commitSha: draftReview.commitSha,
    localStatePath,
  }, { jq: options.jq, silent: options.silent, stdout, stderr });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
