#!/usr/bin/env node
// Escape hatch for a deadlock the review loop cannot resolve on its own
// (#1502): a Copilot review was requested on a head that ALREADY carries
// Copilot's own clean submitted review. Copilot does not re-engage a change it
// effectively approved, so the request sits pending indefinitely. BELOW the
// round cap that is a deadlock: the loop stays `waiting_for_copilot_review` and
// `pre_approval_gate` cannot post. At the cap it is not — the interpreter
// already emits `round_cap_clean_fallback` and the gate is allowed with the
// request still pending, so withdrawing there changes nothing about the gate.
//
// Withdrawing the request removes a signal that will never arrive and lets the
// loop re-evaluate on the evidence it already has. The path that then opens the
// gate is same-head clean convergence: a Copilot review SUBMITTED on the current
// head, zero unresolved and zero actionable threads, and strictly green CI
// (`crediblyGreen` stays blocked). Those checks are unchanged and unrelaxed:
// the withdrawal removes a pending signal, it does not satisfy any of them. A
// PR still short of that evidence stays blocked afterwards, and the one PR this
// moves is the one whose evidence was already complete.
//
// It is NOT a general unsticker. At the round cap with clean threads and green
// CI the loop already routes to `round_cap_clean_fallback` with the request
// still pending, so the gate is not blocked; the guards would still pass and a
// real withdrawal would occur, but it buys nothing. With non-green CI
// the gate stays blocked either way. The case it fixes is the forced re-request
// on a head that already carries a clean submitted review.
//
// It is deliberately NOT automatic. "Copilot will not re-engage this" is a
// human judgement about a model's behavior, so it stays an explicit, audited
// operator action rather than an inference the loop makes about its own gate.
//
// HEAD-ADVANCED CASE (#1441): a sibling shape of the same deadlock — the loop
// converged, the round's threads were reply-resolved on a NEW head, so
// `copilotReviewOnCurrentHead` is false. Below the round cap, withdrawing here
// alone would just make the loop re-request Copilot on that new head and strand
// again the same way, since Copilot still will not re-engage a change it
// already effectively approved. This is eligible ONLY when the delta since
// Copilot's last SUBMITTED review is provably a pure doc/prose bump (the same
// fail-closed classifier request-copilot-review.mjs already trusts for its own
// round-cap suppression, reused here via classifyDeltaSinceLastReview — see
// resolveConvergenceCarryForward in @dev-loops/core/loop/gate-carry-forward).
// Any code/test/config/CI or unclassifiable delta, a non-linear advance, or an
// unavailable compare REFUSES exactly like the round-cap check does — this tool
// never widens what counts as "provably docs-only". On success it also writes
// an operator-authorized suppression marker (scripts/loop/_post-convergence-
// review-suppression.mjs), scoped to this EXACT head, so request-copilot-
// review.mjs recognizes the same head as already-settled instead of
// re-requesting — reusing the existing `suppressed_post_convergence_docs_only`
// status rather than inventing a parallel mechanism. Any further push
// invalidates the marker (new head no longer matches).
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
// SUBMITTED_REVIEW_STATES is shared with the loop-state reader on purpose:
// whitelisting (not `!== "PENDING"`) fails a missing, null, lowercase or
// newly-invented state closed, and one copy cannot drift from the gate's.
import { isCopilotLogin, SUBMITTED_REVIEW_STATES } from "@dev-loops/core/github/copilot-helpers";
import { parseReviewThreads } from "@dev-loops/core/github/review-threads";
import { REVIEW_THREADS_QUERY } from "./capture-review-threads.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { classifyDeltaSinceLastReview, getLastCopilotReviewHeadSha } from "./request-copilot-review.mjs";
import { writeSuppressionMarker } from "../loop/_post-convergence-review-suppression.mjs";

const USAGE = `Usage: node scripts/github/withdraw-copilot-review-request.mjs --repo <owner/name> --pr <number> [--reason <text>]

Withdraw a STRANDED Copilot review request so the loop can re-evaluate on the
evidence it already has. For the case where Copilot was asked to re-review a
head that already carries its clean submitted review, declined to engage, and
left the pre_approval_gate unable to post.

Withdraws only when ALL of these hold (each is what makes the withdrawal safe;
the last two REFUSE with exit 1, while no pending request is an exit-0 no-op):
  - a Copilot review request is actually pending
  - Copilot has already SUBMITTED a review on this PR (a real prior review to
    fall back on — never used to skip a first review)
  - no unresolved review threads remain

If that submitted review is on the CURRENT head, withdrawing is all that is
needed — same-head clean convergence opens the gate.

If the head has since ADVANCED past that review (#1441), withdrawing ALSO
requires the delta since Copilot's last submitted review to be provably a pure
doc/prose bump (the same fail-closed classifier request-copilot-review.mjs
already trusts at the round cap). A code/test/config/CI or unclassifiable
delta, a non-linear advance, or an unavailable compare REFUSES — withdrawing
there would just make the loop re-request Copilot and strand again. On success
this also writes an operator-authorized suppression marker scoped to that exact
head, so request-copilot-review.mjs recognizes it as already-settled instead of
re-requesting; any further push invalidates the marker.

Options:
  --repo <owner/name>     Required.
  --pr <number>           Required.
  --reason <text>         Recorded in the output for the audit trail.
  --dry-run               Report what would happen; withdraw nothing.
  --help, -h              Show this help.

Output (stdout, JSON):
  { ok, withdrawn, status: "withdrawn"|"refused"|"not-requested"|"dry-run", reason,
    operatorReason?, headAdvanced? }

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

async function fetchCopilotRequested(args, { env, runChild }) {
  const requested = await ghJson(runChild, env, ["api", `repos/${args.repo}/pulls/${args.pr}/requested_reviewers`]);
  const users = Array.isArray(requested?.users) ? requested.users : [];
  return users.some((user) => isCopilotLogin(user?.login));
}

async function collectState(args, { env, runChild }) {
  const copilotRequested = await fetchCopilotRequested(args, { env, runChild });

  const pr = await ghJson(runChild, env, [
    "pr", "view", String(args.pr), "--repo", args.repo, "--json", "headRefOid,reviews",
  ]);
  const reviews = Array.isArray(pr?.reviews) ? pr.reviews : [];
  const submittedCopilotReviews = reviews.filter(
    (review) => isCopilotLogin(review?.author?.login)
      && SUBMITTED_REVIEW_STATES.has(String(review?.state ?? "").toUpperCase()),
  );
  const submittedCopilotReview = submittedCopilotReviews.length > 0;
  const currentHeadSha = typeof pr?.headRefOid === "string" && pr.headRefOid.trim().length > 0
    ? pr.headRefOid.trim()
    : null;
  // Tolerate both GraphQL commit.oid and REST commit_id shapes, mirroring
  // getLastCopilotReviewHeadSha in request-copilot-review.mjs.
  const hasSubmittedReviewOnCurrentHead = currentHeadSha !== null
    && submittedCopilotReviews.some((review) => {
      const sha = review?.commit?.oid ?? review?.commit_id;
      return typeof sha === "string" && sha.trim() === currentHeadSha;
    });

  // Threads come from GraphQL, not `gh pr view --json`: there is no
  // `reviewThreads` JSON field, and every other thread-reading script here uses
  // this query. parseReviewThreads normalizes the connection shape and counts a
  // missing isResolved as unresolved, so an unfamiliar payload refuses rather
  // than reading as clean.
  const { owner, name } = parseRepoSlug(args.repo);
  const threadsPayload = await ghJson(runChild, env, [
    "api", "graphql",
    "-f", `query=${REVIEW_THREADS_QUERY}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `pr=${args.pr}`,
  ]);
  const unresolvedThreadCount = parseReviewThreads(threadsPayload).summary.unresolvedThreads;

  return {
    copilotRequested,
    submittedCopilotReview,
    unresolvedThreadCount,
    currentHeadSha,
    hasSubmittedReviewOnCurrentHead,
    prData: pr,
  };
}

async function main(args, { env = process.env, runChild = defaultRunChild, checkpointDir } = {}) {
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

  // Head-advanced case (#1441): Copilot's submitted review is NOT on the
  // current head. Withdrawing alone would just let the loop re-request Copilot
  // on this new head and strand again the same way — eligible only when the
  // delta since that review is provably a pure doc/prose bump (the review's own
  // thread resolutions, not new reviewable content). Fails closed exactly like
  // the round-cap classifier: any code/test/config/CI or unclassifiable file, a
  // non-linear advance, or an unavailable compare refuses instead of widening
  // what counts as "provably docs-only".
  const headAdvanced = !state.hasSubmittedReviewOnCurrentHead;
  let deltaClassification = null;
  let lastReviewedHeadSha = null;
  if (headAdvanced) {
    lastReviewedHeadSha = getLastCopilotReviewHeadSha(state.prData);
    if (!state.currentHeadSha || !lastReviewedHeadSha) {
      return {
        ok: false,
        withdrawn: false,
        status: "refused",
        reason: "The head has advanced past Copilot's last submitted review, but commit SHA data is unavailable, so the delta since that review could not be evaluated.",
      };
    }
    deltaClassification = await classifyDeltaSinceLastReview(
      { repo: args.repo, base: lastReviewedHeadSha, head: state.currentHeadSha },
      { env, runChild },
    );
    if (!deltaClassification.carryForward) {
      return {
        ok: false,
        withdrawn: false,
        status: "refused",
        reason: `The head has advanced past Copilot's last submitted review, and the delta since then is not provably a pure doc/prose bump (${deltaClassification.reason}); withdrawing here would just make the loop re-request Copilot and strand again.`,
      };
    }
  }

  if (args.dryRun) {
    return {
      ok: true,
      withdrawn: false,
      status: "dry-run",
      reason: "Guards hold; the request would be withdrawn.",
      operatorReason: args.reason ?? null,
      ...(headAdvanced ? { headAdvanced: true } : {}),
    };
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
  // Only the request flag matters here — re-reading reviews and threads would
  // be two more API calls to answer a question neither can change.
  if (await fetchCopilotRequested(args, { env, runChild })) {
    throw new Error("Copilot review request is still pending after gh pr edit --remove-reviewer; nothing was withdrawn.");
  }

  if (headAdvanced) {
    // Record the operator-authorized suppression marker (see the header
    // comment): scoped to this exact head, so request-copilot-review.mjs
    // recognizes it as already-settled instead of re-requesting. Any further
    // push invalidates it (new head no longer matches).
    await writeSuppressionMarker(
      {
        repo: args.repo,
        pr: args.pr,
        headSha: state.currentHeadSha,
        lastReviewedHeadSha,
        reason: deltaClassification.reason,
        operatorReason: args.reason ?? null,
      },
      { checkpointDir },
    );
    return {
      ok: true,
      withdrawn: true,
      status: "withdrawn",
      headAdvanced: true,
      reason: `Stranded Copilot review request withdrawn on a head that has advanced past Copilot's last submitted review; the delta since that review is a provable pure doc/prose bump (${deltaClassification.reason}), so the prior converged Copilot review still stands. A suppression marker was recorded for this exact head so the loop will not re-request and re-strand.`,
      operatorReason: args.reason ?? null,
    };
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
