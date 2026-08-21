#!/usr/bin/env node
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  parseJsonText,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { fetchDraftGateEvidence } from "../github/_gate-finding-surface.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseArgs } from "node:util";
import { evaluatePrSizeBudget as realEvaluatePrSizeBudget } from "./check-size-budget.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  pre-pr-ready-gate.mjs --repo <owner/name> --pr <number>

Gate guard for gh pr ready (draft → ready-for-review transition). Blocks
unless a visible clean draft_gate checkpoint verdict exists for the PR's
current head SHA (on either surface it can live on: the round's PR review, or
a legacy verdict issue comment) AND the fail-closed PR size budget
(gates.size) does not return a block outcome. This is the guard the raw
\`gh pr ready\` hook path runs — no --waive-size-budget surface here; a size
waiver can only be granted through ready-for-review.mjs.

Exit codes:
  0  Draft gate evidence exists and the size budget does not block — ready transition is allowed
  1  Draft gate evidence missing/insufficient, or the size budget blocks — transition blocked

Output (stdout, JSON on success):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 17,
    "currentHeadSha": "abc1234",
    "draftGateSatisfied": true,
    "draftGate": { "visible": true, "headSha": "abc1234", "verdict": "clean", ... },
    "sizeBudget": { "outcome": "pass"|"escalate", ... }
  }

Error output (stderr, JSON):
  { "ok": false, "error": "<reason>" }
${JQ_OUTPUT_USAGE}`.trim();

const parseError = buildParseError(USAGE);
const PR_VIEW_QUERY = `query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { id, isDraft, headRefOid, baseRefName, state } } }`;

export function parsePrePrReadyGateCliArgs(argv) {
  const options = { help: false, repo: undefined, pr: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("pre-pr-ready-gate requires both --repo <owner/name> and --pr <number>");
  }
  try { parseRepoSlug(options.repo); } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}

async function runGhJson(args, { env, ghCommand }) {
  const result = await runChild(ghCommand, args, env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout);
}

async function fetchPrState({ repo, pr }, { env, ghCommand }) {
  const [owner, name] = repo.split("/");
  const r = await runGhJson(
    ["api", "graphql", "-f", `query=${PR_VIEW_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`],
    { env, ghCommand },
  );
  const d = r?.data?.repository?.pullRequest;
  if (!d) throw new Error(`Could not fetch PR #${pr}`);
  return {
    id: d.id,
    isDraft: d.isDraft === true,
    headRefOid: typeof d.headRefOid === "string" ? d.headRefOid.trim() : null,
    baseRefName: typeof d.baseRefName === "string" ? d.baseRefName.trim() : null,
    state: typeof d.state === "string" ? d.state.trim() : null,
  };
}

export async function prePrReadyGate(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd(), evaluatePrSizeBudget = realEvaluatePrSizeBudget } = {}) {
  const prState = await fetchPrState({ repo: options.repo, pr: options.pr }, { env, ghCommand });
  const headSha = prState.headRefOid;
  if (!headSha) throw new Error(`Could not resolve PR head SHA`);

  const gate = await fetchDraftGateEvidence({ repo: options.repo, pr: options.pr, headSha }, { env, ghCommand });

  // When the PR is no longer draft, a visible clean draft_gate comment that
  // exists at all (one-time transition record) satisfies the VERDICT check
  // (don't require head-SHA matching after draft has been left). The gate-close
  // invariant (#1585) is still enforced below: threadsResolved (0 unresolved
  // gate-authored threads) is required regardless of draft state.
  const verdictClean = prState.isDraft
    ? gate.effectiveHeadClean
    : gate.cleanEvidenceExists;
  // #1585: a clean verdict is necessary but not sufficient — every
  // gate-authored review thread (high, medium, low, question, AND nit)
  // must be resolved first. A clean verdict with dangling low threads
  // is exactly the #1584 regression this guard now catches at the
  // ready-for-review boundary instead of stalling at the merge boundary.
  const threadsResolved = gate.unresolvedGateThreadCount === 0;
  const gateSatisfied = verdictClean && threadsResolved;

  if (!gateSatisfied) {
    const shortSha = headSha.slice(0, 7);
    let reason;
    if (!verdictClean) {
      reason = gate.cleanEvidenceExists
        ? `PR #${options.pr} draft_gate evidence exists but does not match current head ${shortSha}. Re-run draft gate for the current head.`
        : `No visible clean draft_gate checkpoint verdict found on PR #${options.pr} for head ${shortSha}. Run the draft gate review and post a clean verdict before marking ready for review.`;
    } else {
      // Verdict is clean, but gate-authored threads remain unresolved.
      const threadReason = gate.unresolvedGateThreadCount === -1
        ? "could not read review-thread state from GitHub; re-run when API connectivity is restored"
        : `${gate.unresolvedGateThreadCount} unresolved gate-authored review thread(s) remain; run the disposition pass (close-gate-findings) + fixer triage to resolve (fix-close or defer-close) every gate-authored thread before ready-for-review`;
      reason = `PR #${options.pr} draft_gate verdict is clean for head ${shortSha} but ${threadReason}.`;
    }
    return {
      ok: false,
      error: reason,
      repo: options.repo,
      pr: options.pr,
      currentHeadSha: headSha,
      draftGateSatisfied: false,
      unresolvedGateThreadCount: gate.unresolvedGateThreadCount,
      draftGate: gate.draftGate,
      draftGateMarker: gate.draftGateMarker,
    };
  }

  // Fail-closed PR size budget (gates.size): the same computation
  // readyForReview() runs, via the shared evaluatePrSizeBudget code path in
  // check-size-budget.mjs — but with no waiver surface. A raw `gh pr ready`
  // intercepted by this guard can never be waived; only ready-for-review.mjs's
  // --waive-size-budget can grant one.
  if (!prState.baseRefName) throw new Error(`Could not resolve PR #${options.pr} base branch`);
  const sizeBudget = await evaluatePrSizeBudget({
    base: `origin/${prState.baseRefName}`,
    head: headSha,
    repoRoot,
  });
  if (sizeBudget.outcome === "block") {
    return {
      ok: false,
      error: `PR #${options.pr} blocked by size budget: ${sizeBudget.reasons.join("; ")}`,
      repo: options.repo,
      pr: options.pr,
      currentHeadSha: headSha,
      draftGateSatisfied: true,
      unresolvedGateThreadCount: gate.unresolvedGateThreadCount,
      draftGate: gate.draftGate,
      draftGateMarker: gate.draftGateMarker,
      sizeBudget,
    };
  }

  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    currentHeadSha: headSha,
    draftGateSatisfied: true,
    unresolvedGateThreadCount: gate.unresolvedGateThreadCount,
    draftGate: gate.draftGate,
    draftGateMarker: gate.draftGateMarker,
    sizeBudget,
  };
}

export async function runCli(argv = process.argv.slice(2), runtime = {}) {
  const options = parsePrePrReadyGateCliArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const result = await prePrReadyGate(options, runtime);
  if (!result.ok) {
    // Failure prints to stderr (existing contract); jq/silent apply there too.
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout: process.stderr, stderr: process.stderr });
    return result;
  }
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, stdout: process.stdout, stderr: process.stderr });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
                process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
  });
}
