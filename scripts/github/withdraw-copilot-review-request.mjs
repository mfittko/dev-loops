#!/usr/bin/env node
// Escape hatch for the one deadlock the review loop cannot resolve on its own
// (#1441): a Copilot review was requested on a converged PR, Copilot declined to
// re-engage a change it had effectively already approved, and the request sits
// pending forever. The loop stays `waiting_for_copilot_review` with no on-head
// review, so `pre_approval_gate` can never post and the PR cannot merge.
//
// Withdrawing the request removes a signal that will never arrive and lets the
// loop re-evaluate on the evidence it already has. The path that then opens the
// gate is same-head clean convergence: a Copilot review SUBMITTED on the current
// head, zero unresolved and zero actionable threads, and strictly green CI
// (`crediblyGreen` stays blocked). Those checks are unchanged and unrelaxed —
// nothing here loosens a precondition, and a PR that could not reach the gate
// before a withdrawal still cannot reach it after one.
//
// It is NOT a general unsticker. At the round cap with clean threads and green
// CI the loop already routes to `round_cap_clean_fallback` with the request
// still pending, so nothing is stranded and this is a no-op. With non-green CI
// the gate stays blocked either way. And if the head has since advanced past
// the submitted review, withdrawing below the cap just makes the loop re-request
// — the same strand again. The case it fixes is the forced re-request on a head
// that already carries a clean submitted review.
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

Withdraw a STRANDED Copilot review request so the loop can re-evaluate on the
evidence it already has. For the case where Copilot was asked to re-review a
head that already carries its clean submitted review, declined to engage, and
left the pre_approval_gate unable to post.

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

  // `gh pr edit --remove-reviewer` is the documented inverse of the
  // `--add-reviewer "@copilot"` the request path uses, so the reviewer identity
  // is resolved by gh rather than guessed here. A raw requested_reviewers DELETE
  // needs the literal login, which is the app-style
  // `copilot-pull-request-reviewer[bot]`, not `Copilot` — getting that wrong
  // deletes nothing and still exits 0.
  const result = await runChild(
    "gh",
    ["pr", "edit", String(args.pr), "--repo", args.repo, "--remove-reviewer", "@copilot"],
    env,
  );
  if (result.code !== 0) {
    throw new Error(`gh command failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
  // Post-verify, mirroring the request path: an escape hatch whose whole job is
  // unsticking a deadlock must never report a withdrawal it did not perform.
  const after = await collectState(args, { env, runChild });
  if (after.copilotRequested) {
    throw new Error("Copilot review request is still pending after gh pr edit --remove-reviewer; nothing was withdrawn.");
  }
  return {
    ok: true,
    withdrawn: true,
    status: "withdrawn",
    reason: "Stranded Copilot review request withdrawn; the loop re-evaluates without a pending review it will never receive.",
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
