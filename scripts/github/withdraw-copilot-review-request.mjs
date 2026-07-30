#!/usr/bin/env node
// Escape hatch for the one deadlock the review loop cannot resolve on its own
// (#1441): a Copilot review was requested on a converged PR, Copilot declined to
// re-engage a change it had effectively already approved, and the request sits
// pending forever. The loop stays `waiting_for_copilot_review` with no on-head
// review, so `pre_approval_gate` can never post and the PR cannot merge.
//
// Withdrawing the stranded request returns the loop to `round_cap_reached`,
// where the existing round-cap-clean fallback grants gate entry on its own
// terms (zero unresolved threads and strictly green CI). Nothing here loosens a
// gate precondition — it removes a signal that was never going to arrive, and
// lets the hardened path decide.
//
// It is deliberately NOT automatic. "Copilot will not re-engage this" is a
// human judgement about a model's behavior, so it stays an explicit, audited
// operator action rather than an inference the loop makes about its own gate.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { isCopilotLogin } from "@dev-loops/core/github/copilot-helpers";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: node scripts/github/withdraw-copilot-review-request.mjs --repo <owner/name> --pr <number> [--reason <text>]

Withdraw a STRANDED Copilot review request so the loop can fall back to the
round-cap-clean path. For the case where Copilot was asked to re-review a
converged PR, declined to engage, and left the pre_approval_gate unable to post.

Refuses unless ALL of these hold (each is what makes the withdrawal safe):
  - a Copilot review request is actually pending
  - Copilot has already SUBMITTED a review on an earlier head (there is a real
    prior review to fall back on — never used to skip a first review)
  - no unresolved review threads remain

Options:
  --repo <owner/name>     Required.
  --pr <number>           Required.
  --reason <text>         Recorded in the output for the audit trail.
  --dry-run               Report what would happen; withdraw nothing.
  --help, -h              Show this help.

Output (stdout, JSON):
  { ok: true, withdrawn: true|false, status: "withdrawn"|"refused"|"not-requested", reason }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — withdrawn, or a no-op because nothing was pending
  1 — usage/argument error, gh failure, or a refusal (the guards did not hold)
  2 — invalid --jq filter
`.trim();

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE });
  const args = { dryRun: false };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      reason: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unexpected argument: ${token.value}`);
    if (token.kind !== "option") continue;
    switch (token.name) {
      case "help":
        args.help = true;
        break;
      case "dry-run":
        args.dryRun = true;
        break;
      case "repo":
        args.repo = requireTokenValue(token, parseError);
        break;
      case "pr":
        args.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
        break;
      case "reason":
        args.reason = requireTokenValue(token, parseError);
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireTokenValue(t, parseError))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
      }
    }
  }
  if (!args.help) {
    if (!args.repo) throw parseError("--repo is required");
    if (args.pr === undefined) throw parseError("--pr is required");
    try {
      parseRepoSlug(args.repo);
    } catch (err) {
      throw parseError(err instanceof Error ? err.message : String(err));
    }
  }
  return args;
}

async function ghJson(runChild, env, ghArgs) {
  const result = await runChild("gh", ghArgs, env);
  if (result.code !== 0) {
    throw new Error(`gh command failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
}

async function collectState(args, { env, runChild }) {
  const requested = await ghJson(runChild, env, ["api", `repos/${args.repo}/pulls/${args.pr}/requested_reviewers`]);
  const users = Array.isArray(requested?.users) ? requested.users : [];
  const copilotRequested = users.some((user) => isCopilotLogin(user?.login));

  const pr = await ghJson(runChild, env, [
    "pr", "view", String(args.pr), "--repo", args.repo, "--json", "reviews,reviewThreads,headRefOid",
  ]);
  const reviews = Array.isArray(pr?.reviews) ? pr.reviews : [];
  const submittedCopilotReview = reviews.some(
    (review) => isCopilotLogin(review?.author?.login) && review?.state !== "PENDING",
  );
  const threads = Array.isArray(pr?.reviewThreads) ? pr.reviewThreads : [];
  const unresolvedThreadCount = threads.filter((thread) => thread?.isResolved === false).length;

  return { copilotRequested, submittedCopilotReview, unresolvedThreadCount };
}

async function main(args, { env = process.env, runChild = defaultRunChild } = {}) {
  const state = await collectState(args, { env, runChild });

  if (!state.copilotRequested) {
    return { ok: true, withdrawn: false, status: "not-requested", reason: "No Copilot review request is pending; nothing to withdraw." };
  }
  if (!state.submittedCopilotReview) {
    return {
      ok: false,
      withdrawn: false,
      status: "refused",
      reason: "Copilot has not submitted any review on this PR, so there is no prior review to fall back on. Withdrawing here would skip the first review entirely.",
    };
  }
  if (state.unresolvedThreadCount > 0) {
    return {
      ok: false,
      withdrawn: false,
      status: "refused",
      reason: `${state.unresolvedThreadCount} unresolved review thread(s) remain; resolve them before withdrawing a review request.`,
    };
  }
  if (args.dryRun) {
    return { ok: true, withdrawn: false, status: "dry-run", reason: "Guards hold; the request would be withdrawn.", operatorReason: args.reason ?? null };
  }

  const result = await runChild(
    "gh",
    [
      "api", "-X", "DELETE", `repos/${args.repo}/pulls/${args.pr}/requested_reviewers`,
      "-f", "reviewers[]=Copilot",
    ],
    env,
  );
  if (result.code !== 0) {
    throw new Error(`gh command failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
  return {
    ok: true,
    withdrawn: true,
    status: "withdrawn",
    reason: "Stranded Copilot review request withdrawn; the loop falls back to the round-cap-clean path.",
    operatorReason: args.reason ?? null,
  };
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, runChild } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  let result;
  try {
    result = await main(args, { env, runChild });
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2));
}

export { main, parseCliArgs, runCli };
