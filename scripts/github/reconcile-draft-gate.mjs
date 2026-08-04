#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveGateConfig } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { detectCheckpointEvidence } from "./detect-checkpoint-evidence.mjs";
import { upsertCheckpointVerdict } from "./upsert-checkpoint-verdict.mjs";
// convertPrToDraft/markPrReady live in their own module (no dependency on this
// file or upsert-checkpoint-verdict.mjs) so both callers can import them
// statically without a circular reference back to upsert-checkpoint-verdict.mjs
// — see _draft-transition.mjs's header comment for the deadlock that reference
// caused (#1455).
import { convertPrToDraft, markPrReady } from "./_draft-transition.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const USAGE = `Usage: reconcile-draft-gate.mjs --repo <owner/name> --pr <number>
Optional/manual recovery tool for an already non-draft PR when you want to
retroactively record clean \`draft_gate\` evidence.
Converts the PR to draft, validates the head, posts a reconciling clean
draft_gate comment, then marks the PR ready for review again.
Fail-closed guards:
  - Refuses to reconcile if any draft_gate evidence already exists on the PR.
  - Requires CI to be green on the current head SHA before posting the
    reconciling gate comment unless config disables \`gates.draft.requireCi\`.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Output (stdout, JSON):
  {
    "ok": true,
    "action": "reconciled",
    "repo": "owner/repo",
    "pr": 17,
    "headSha": "abc1234",
    "currentHeadSha": "abc1234",
    "commentId": 101,
    "commentUrl": "https://github.com/owner/repo/pull/17#pullrequestreview-101"
  }
  (commentId/commentUrl identify the posted gate verdict review; a legacy
  verdict issue comment corrected in place yields an #issuecomment- URL.)
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success — PR was reconciled and gate evidence posted
  1  Argument error, gh failure, or unrecoverable state
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
export function parseReconcileDraftGateCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, pr: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
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
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr"].filter((key) => options[key] === undefined);
  if (missing.length > 0) {
    throw parseError("reconcile-draft-gate requires --repo and --pr");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function normalizeCheckBucket(check = {}) {
  const bucket = typeof check.bucket === "string" ? check.bucket.trim().toLowerCase() : "";
  if (bucket) {
    return bucket;
  }
  const state = typeof check.state === "string" ? check.state.trim().toLowerCase() : "";
  if (["success", "passed", "pass"].includes(state)) {
    return "pass";
  }
  if (["skipped", "skipping"].includes(state)) {
    return "skipping";
  }
  if (["pending", "queued", "in_progress", "waiting", "requested", "expected", "action_required"].includes(state)) {
    return "pending";
  }
  if (["failure", "failed", "fail", "error", "timed_out", "startup_failure"].includes(state)) {
    return "fail";
  }
  if (["cancel", "cancelled", "canceled"].includes(state)) {
    return "cancel";
  }
  return state || "unknown";
}
function summarizeBlockingChecks(blockingChecks) {
  if (!Array.isArray(blockingChecks) || blockingChecks.length === 0) {
    return "unknown blocking CI state";
  }
  return blockingChecks
    .map((check) => `${check.name || "unnamed-check"}=${check.bucket}`)
    .join(", ");
}
async function checkCiStatus({ repo, pr, headSha }, { env, ghCommand, runChild = defaultRunChild }) {
  const result = await runChild(ghCommand, [
    "pr", "checks", String(pr),
    "--repo", repo,
    "--json", "bucket,state,name,workflow",
  ], env);
  const stdout = result.stdout.trim();
  if (result.code !== 0) {
    if ((result.code !== 1 && result.code !== 8) || stdout.length === 0) {
      throw new Error(
        `Failed to check PR #${pr} CI status: ${result.stderr.trim() || `exit code ${result.code}`}`
      );
    }
  }
  const payload = parseJsonText(stdout || "[]", {
    label: `gh pr checks #${pr}`,
  });
  if (!Array.isArray(payload)) {
    throw new Error(`Invalid gh pr checks payload for PR #${pr}: expected an array`);
  }
  if (payload.length === 0) {
    return {
      status: "none",
      checks: [],
      blockingSummary: `No CI/check runs were reported for PR #${pr} head ${headSha.slice(0, 7)}.`,
    };
  }
  const checks = payload.map((check) => ({
    name: typeof check?.name === "string" && check.name.trim().length > 0 ? check.name.trim() : null,
    workflow: typeof check?.workflow === "string" && check.workflow.trim().length > 0 ? check.workflow.trim() : null,
    state: typeof check?.state === "string" && check.state.trim().length > 0 ? check.state.trim() : null,
    bucket: normalizeCheckBucket(check),
  }));
  const blockingChecks = checks.filter((check) => !["pass", "skipping"].includes(check.bucket));
  return {
    status: blockingChecks.length === 0 ? "success" : "blocked",
    checks,
    blockingChecks,
    blockingSummary: blockingChecks.length === 0
      ? null
      : `Blocking CI/check state on head ${headSha.slice(0, 7)}: ${summarizeBlockingChecks(blockingChecks)}.`,
  };
}
export async function reconcileDraftGate(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd(), runChild = defaultRunChild } = {}) {
  const { config } = await loadDevLoopConfig({ repoRoot });
  const draftGateConfig = resolveGateConfig(config, "draft");
  const initialEvidence = await detectCheckpointEvidence(
    { repo: options.repo, pr: options.pr },
    { env, ghCommand, runChild }
  );
  const headSha = initialEvidence.currentHeadSha;
  if (!headSha) {
    throw new Error(`Could not resolve current head SHA for PR #${options.pr}`);
  }
  if (initialEvidence.draftGate?.visible) {
    throw new Error(
      `PR #${options.pr} already has a visible draft_gate comment (verdict: ` +
      `${initialEvidence.draftGate.verdict || "unknown"}). Refusing to overwrite existing ` +
      `evidence. Reconcile manually or clear the existing comment first.`
    );
  }
  if (initialEvidence.draftGateMarker?.visible) {
    throw new Error(
      `PR #${options.pr} already has a visible draft_gate marker. Refusing to overwrite ` +
      `existing evidence. Reconcile manually or clear the existing marker first.`
    );
  }
  if (draftGateConfig.requireCi) {
    const ciStatus = await checkCiStatus(
      { repo: options.repo, pr: options.pr, headSha },
      { env, ghCommand, runChild }
    );
    if (ciStatus.status !== "success") {
      throw new Error(
        `PR #${options.pr} CI is not green. ${ciStatus.blockingSummary || "No successful check state was confirmed."} ` +
        `Refusing to post a clean draft_gate comment. Fix CI first.`
      );
    }
  }
  const draftConversion = await convertPrToDraft({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
  let gateResult;
  try {
    gateResult = await upsertCheckpointVerdict({
      repo: options.repo,
      pr: options.pr,
      gate: "draft_gate",
      headSha,
      verdict: "clean",
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
      findingsSummary: draftGateConfig.requireCi
        ? "Reconciled non-draft PR — draft gate auto-reconciled (CI green)."
        : "Reconciled non-draft PR — draft gate auto-reconciled (CI optional by config).",
      nextAction: "Mark ready for review (auto-reconciled).",
    }, { env, ghCommand, repoRoot, runChild });
  } catch (error) {
    if (draftConversion.alreadyDraft !== true) {
      try {
        await markPrReady({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
      } catch {
      }
    }
    throw error;
  }
  await markPrReady({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild });
  return {
    ok: true,
    action: "reconciled",
    repo: options.repo,
    pr: options.pr,
    headSha: gateResult.headSha || headSha,
    currentHeadSha: gateResult.currentHeadSha || headSha,
    commentId: gateResult.commentId,
    commentUrl: gateResult.commentUrl,
  };
}
async function main() {
  let options;
  try {
    options = parseReconcileDraftGateCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await reconcileDraftGate(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
