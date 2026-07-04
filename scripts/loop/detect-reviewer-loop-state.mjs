#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  interpretReviewerLoopState,
  normalizeReviewerSnapshot,
} from "@dev-loops/core/loop/reviewer-loop-state";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const HELP = `Usage: detect-reviewer-loop-state.mjs [--input <path> | --repo <owner/name> --pr <number>] [--review-requested <true|false>] [--local-state <path>]
Detect reviewer loop state for a pull request.
Modes:
  --input <path>                Interpret a JSON snapshot from file
  --repo <owner/name> --pr <n>  Auto-detect state from GitHub PR
Options (auto-detect mode only):
  --review-requested <bool>     Override review-requested detection (true/false)
  --local-state <path>          Path to local state file for snapshot merging
Reviewer scope is auto-resolved from PR requested reviewers.

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Error
  2   Invalid --jq filter
`;
function parseBool(value, flag) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${flag} must be true or false`);
}
export function parseDetectReviewerCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
      "review-requested": { type: "string" },
      "local-state": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    inputPath: undefined,
    repo: undefined,
    pr: undefined,
    reviewRequestedOverride: undefined,
    localStatePath: undefined,
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
    if (token.name === "input") {
      options.inputPath = requireTokenValue(token);
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token));
      continue;
    }
    if (token.name === "review-requested") {
      options.reviewRequestedOverride = parseBool(
        requireTokenValue(token),
        "--review-requested",
      );
      continue;
    }
    if (token.name === "local-state") {
      options.localStatePath = requireTokenValue(token);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t))) continue;
    throw new Error(`Unknown argument: ${token.rawName}`);
  }
  if (options.inputPath !== undefined) {
    if (options.repo !== undefined || options.pr !== undefined) {
      throw new Error("Choose exactly one input source: --input <path> or --repo/--pr auto-detect");
    }
    const hasInputOnlyConflict = options.localStatePath !== undefined
      || options.reviewRequestedOverride !== undefined;
    if (hasInputOnlyConflict) {
      throw new Error("--input cannot be combined with --review-requested or --local-state");
    }
    return options;
  }
  const hasRepo = options.repo !== undefined;
  const hasPr = options.pr !== undefined;
  if (hasRepo || hasPr) {
    if (!hasRepo || !hasPr) {
      throw new Error("Auto-detect mode requires both --repo <owner/name> and --pr <number>");
    }
    parseRepoSlug(options.repo);
  } else {
    throw new Error("Provide either --input <path> or --repo <owner/name> --pr <number>");
  }
  return options;
}
async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
}
async function fetchPrView({ repo, pr }, deps) {
  const result = await runChild(
    deps.ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "isDraft,state,number,headRefOid"],
    deps.env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    if (/no pull requests found/i.test(detail) || /could not find pull request/i.test(detail)) {
      return null;
    }
    throw new Error(`gh command failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
}
function isReviewInScope(review, reviewerLogin) {
  if (!reviewerLogin) return true;
  const login = typeof review?.user?.login === "string"
    ? review.user.login
    : (typeof review?.author?.login === "string" ? review.author.login : "");
  return login.toLowerCase() === reviewerLogin.toLowerCase();
}
function isSubmittedReviewState(state) {
  return ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(state);
}
function pickLatestById(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items.filter(Boolean).slice().sort((a, b) => {
    const aid = typeof a.id === "number" ? a.id : -1;
    const bid = typeof b.id === "number" ? b.id : -1;
    return bid - aid;
  })[0] ?? null;
}
async function fetchReviewRequested({ repo, pr, reviewerLogin, reviewRequestedOverride }, deps) {
  if (typeof reviewRequestedOverride === "boolean") return reviewRequestedOverride;
  const payload = await runGhJson(["api", `repos/${repo}/pulls/${pr}/requested_reviewers`], deps);
  const users = Array.isArray(payload?.users) ? payload.users : [];
  if (reviewerLogin) {
    return users.some((user) => {
      const login = typeof user?.login === "string" ? user.login : "";
      return login.toLowerCase() === reviewerLogin.toLowerCase();
    });
  }
  return users.length > 0;
}
async function fetchReviewState({ repo, pr, reviewerLogin }, deps) {
  const payload = await runGhJson(["api", `repos/${repo}/pulls/${pr}/reviews`], deps);
  const reviews = Array.isArray(payload) ? payload : [];
  const scoped = reviews.filter((review) => isReviewInScope(review, reviewerLogin));
  const pendingReview = pickLatestById(
    scoped.filter((review) => String(review?.state || "").toUpperCase() === "PENDING"),
  );
  const submittedReview = pickLatestById(
    scoped.filter((review) => isSubmittedReviewState(String(review?.state || "").toUpperCase())),
  );
  return {
    draftReviewPosted: Boolean(pendingReview),
    draftReviewId: typeof pendingReview?.id === "number" ? pendingReview.id : null,
    draftReviewUrl: typeof pendingReview?.html_url === "string" ? pendingReview.html_url : null,
    draftReviewCommitSha: typeof pendingReview?.commit_id === "string" ? pendingReview.commit_id : null,
    submittedReviewPresent: Boolean(submittedReview),
    submittedReviewCommitSha: typeof submittedReview?.commit_id === "string" ? submittedReview.commit_id : null,
    submittedReviewState: typeof submittedReview?.state === "string" ? submittedReview.state.toUpperCase() : null,
  };
}
async function readLocalState(pathname) {
  if (!pathname) return {};
  let text;
  try { text = await readFile(pathname, "utf8"); }
  catch (error) { if (error && error.code === "ENOENT") return {}; throw error; }
  const parsed = parseJsonText(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Local state file must contain a JSON object");
  return parsed;
}
export async function autoDetectReviewerSnapshot(
  { repo, pr, reviewerLogin, reviewRequestedOverride, localStatePath }, deps,
) {
  const prView = await fetchPrView({ repo, pr }, deps);
  if (prView === null) return normalizeReviewerSnapshot({ prExists: false, reviewerLogin });
  let effectiveReviewerLogin = reviewerLogin;
  if (effectiveReviewerLogin === undefined) {
    try {
      const reviewersPayload = await runGhJson(["api", `repos/${repo}/pulls/${pr}/requested_reviewers`], deps);
      const users = Array.isArray(reviewersPayload?.users) ? reviewersPayload.users : [];
      const humanReviewers = users.filter((user) => {
        const login = typeof user?.login === "string" ? user.login : "";
        return login.length > 0 && login !== "copilot-pull-request-reviewer";
      });
      if (humanReviewers.length === 1) {
        effectiveReviewerLogin = humanReviewers[0].login;
      }
    } catch {
    }
  }
  const localState = await readLocalState(localStatePath);
  const prState = typeof prView.state === "string" ? prView.state.toUpperCase() : "OPEN";
  const prMerged = prState === "MERGED";
  const prClosed = prState === "CLOSED";
  if (prMerged || prClosed) {
    return normalizeReviewerSnapshot({ ...localState, prExists: true, prNumber: typeof prView.number === "number" ? prView.number : pr, prMerged, prClosed, prHeadSha: typeof prView.headRefOid === "string" ? prView.headRefOid : null, reviewerLogin: effectiveReviewerLogin });
  }
  const reviewRequested = await fetchReviewRequested({ repo, pr, reviewerLogin: effectiveReviewerLogin, reviewRequestedOverride }, deps);
  const reviewState = await fetchReviewState({ repo, pr, reviewerLogin: effectiveReviewerLogin }, deps);
  return normalizeReviewerSnapshot({ ...localState, prExists: true, prNumber: typeof prView.number === "number" ? prView.number : pr, prDraft: Boolean(prView.isDraft), prMerged: false, prClosed: false, prHeadSha: typeof prView.headRefOid === "string" ? prView.headRefOid : null, reviewerLogin: effectiveReviewerLogin, reviewRequested, ...reviewState });
}
export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, ghCommand = "gh" } = {},
) {
  const options = parseDetectReviewerCliArgs(argv);
  if (options.help) { stdout.write(HELP); return; }
  let snapshot;
  if (options.inputPath) {
    const text = await readFile(options.inputPath, "utf8");
    snapshot = normalizeReviewerSnapshot(parseJsonText(text));
  } else {
    snapshot = await autoDetectReviewerSnapshot(options, { env, ghCommand });
  }
  const interpretation = interpretReviewerLoopState(snapshot);
  process.exitCode = emitResult(
    { ok: true, snapshot, state: interpretation.state, allowedTransitions: interpretation.allowedTransitions, nextAction: interpretation.nextAction },
    { jq: options.jq, silent: options.silent, stdout, stderr },
  );
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => { process.stderr.write(`${formatCliError(error)}\n`); process.exitCode = 1; });
}
