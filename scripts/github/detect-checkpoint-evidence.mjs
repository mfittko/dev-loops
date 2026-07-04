#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  parseJsonText,
  parseReviewThreads,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../_core-helpers.mjs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { fetchGithubReviewThreadsPayload } from "./capture-review-threads.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { FANOUT_PROVENANCE_MIN_REVIEWERS, loadDevLoopConfig, resolveGateConfig, resolveRequireFanoutEvidence, resolveRequireFanoutProvenance } from "@dev-loops/core/config";
import { FANOUT_UNAVAILABLE_MESSAGE, provenanceConsistencyError } from "@dev-loops/core/loop/gate-fanin";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { ensureAsyncRunnerOwnership } from "../loop/_pr-runner-coordination.mjs";
import { detectStaleRunner } from "../loop/_stale-runner-detection.mjs";
import { resolveLedgerCheckouts, resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const USAGE = `Usage: detect-checkpoint-evidence.mjs --repo <owner/name> --pr <number>
Fetch the live PR head SHA and visible PR issue comments, then summarize the
latest valid draft-gate and pre-approval checkpoint verdict comments. Always fail
closed (exit 1) unless both required gate comments exist: a clean draft_gate
comment for the one-time draft boundary and a clean current-head
pre_approval_gate comment.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Output (stdout, JSON; always includes preMergeGateCheck):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 17,
    "currentHeadSha": "abc1234",
    "draftGate": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "mark ready for review",
      "commentId": 101,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "draftGateMarker": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "mark ready for review",
      "contractComplete": true,
      "commentId": 101,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "draftGateSatisfied": true,
    "preApprovalGate": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "await final human approval",
      "commentId": 102,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-102",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "preApprovalGateMarker": {
      "visible": true,
      "headSha": "abc1234",
      "verdict": "clean",
      "findingsSummary": "no issues found",
      "nextAction": "await final human approval",
      "contractComplete": true,
      "commentId": 102,
      "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-102",
      "updatedAt": "2026-05-29T22:00:00Z"
    },
    "preMergeGateCheck": {
      "ok": true,
      "failures": []
    }
  }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success (gate evidence is valid)
  1  Argument error, gh failure, malformed gh JSON, or missing required pre-merge gate evidence.
  2  Invalid --jq filter.`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectCheckpointEvidenceCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "require-before-merge": { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
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
    if (token.name === "require-before-merge") {
      throw parseError(`--require-before-merge has been removed: gate evidence enforcement is now always-on by default. Omit the flag.`);
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-checkpoint-evidence requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
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
  return parseJsonText(result.stdout, { label: `gh ${args.slice(0, 2).join(" ")}` });
}
function normalizeIssueCommentsPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("Invalid gh issue comments payload: expected an array");
  }
  if (payload.every((entry) => Array.isArray(entry))) {
    return payload.flat();
  }
  return payload;
}
function normalizePrReviewsPayload(payload) {
  if (!Array.isArray(payload)) return [];
  const flat = payload.every((entry) => Array.isArray(entry)) ? payload.flat() : payload;
  return flat
    .filter((r) => r && typeof r === "object" && r.state !== "PENDING" && typeof r.submitted_at === "string" && r.submitted_at.trim().length > 0 && typeof r.body === "string" && r.body.trim().length > 0)
    .map((r) => ({
      id: r.id,
      body: r.body,
      html_url: typeof r.html_url === "string" ? r.html_url : null,
      created_at: typeof r.submitted_at === "string" ? r.submitted_at : null,
      updated_at: typeof r.submitted_at === "string" ? r.submitted_at : null,
    }));
}
function emptyGateSummary() {
  return {
    visible: false,
    headSha: null,
    verdict: null,
    findingsSummary: null,
    nextAction: null,
    commentId: null,
    commentUrl: null,
    updatedAt: null,
  };
}
function normalizeGateSummary(summary) {
  if (!summary) {
    return emptyGateSummary();
  }
  return {
    visible: true,
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
function emptyGateMarkerSummary() {
  return {
    visible: false,
    headSha: null,
    verdict: null,
    findingsSummary: null,
    nextAction: null,
    executionMode: null,
    inlineReason: null,
    contractComplete: false,
    commentId: null,
    commentUrl: null,
    updatedAt: null,
  };
}
function normalizeGateMarkerSummary(summary) {
  if (!summary) {
    return emptyGateMarkerSummary();
  }
  return {
    visible: true,
    headSha: summary.headSha,
    verdict: summary.verdict,
    findingsSummary: summary.findingsSummary,
    nextAction: summary.nextAction,
    executionMode: summary.executionMode ?? null,
    inlineReason: summary.inlineReason ?? null,
    contractComplete: summary.contractComplete === true,
    commentId: summary.commentId,
    commentUrl: summary.commentUrl,
    updatedAt: summary.updatedAt,
  };
}
export function buildPreMergeGateCheck(evidence, unresolvedThreadCount = null, staleRunnerCheck = null, fanoutEnforcement = null) {
  const failures = [];
  if (!(evidence.draftGate.visible && evidence.draftGate.verdict === "clean")) {
    failures.push("missing visible clean draft_gate comment");
  }
  const preApproval = evidence.preApprovalGateMarker;
  if (!(
    preApproval.visible
    && preApproval.contractComplete
    && preApproval.verdict === "clean"
    && preApproval.headSha === evidence.currentHeadSha
  )) {
    failures.push("missing visible clean current-head pre_approval_gate comment");
  }
  // Fail-closed fan-out evidence enforcement (gates.requireFanoutEvidence, ON by
  // default / opt-out). When disabled or config-unavailable, fanoutEnforcement is
  // { required: false, gates: [] } so the `.required` guard skips this block.
  if (fanoutEnforcement && fanoutEnforcement.required) {
    for (const gate of fanoutEnforcement.gates) {
      if (gate.executionMode !== "fanout_fanin") {
        failures.push(
          `${gate.name}: requireFanoutEvidence is enabled but executionMode is "${gate.executionMode ?? "unset"}" (expected "fanout_fanin"); inline gate verdicts are not accepted`,
        );
        continue;
      }
      if (!gate.ledgerExists) {
        failures.push(
          `${gate.name}: requireFanoutEvidence is enabled but no findings-log ledger exists for the reviewed head (${gate.ledgerPath})`,
        );
        continue;
      }
      // Opt-in provenance enforcement (gates.requireFanoutProvenance), layered on
      // top of fan-out evidence. When off (default) requireProvenance is falsy so
      // NO new failure is added — behavior is byte-identical to today. When on, a
      // fanout_fanin ledger must record INTERNALLY-CONSISTENT provenance (checked
      // the same way the write path validates it — a hand-edited or shadow ledger
      // is re-validated here, not trusted) with distinctReviewers >= the floor.
      if (fanoutEnforcement.requireProvenance) {
        const prov = gate.provenance;
        const consistencyErr = provenanceConsistencyError(prov);
        const reviewers = prov && Number.isInteger(prov.distinctReviewers) ? prov.distinctReviewers : null;
        if (consistencyErr) {
          failures.push(
            `${gate.name}: requireFanoutProvenance is enabled but the findings-log ledger lacks valid fan-out provenance (${consistencyErr}); ${FANOUT_UNAVAILABLE_MESSAGE}`,
          );
        } else if (reviewers === null || reviewers < FANOUT_PROVENANCE_MIN_REVIEWERS) {
          failures.push(
            `${gate.name}: requireFanoutProvenance is enabled but the findings-log ledger lacks valid fan-out provenance (need provenance.distinctReviewers >= ${FANOUT_PROVENANCE_MIN_REVIEWERS}, got ${reviewers === null ? "none" : reviewers}); ${FANOUT_UNAVAILABLE_MESSAGE}`,
          );
        }
      }
    }
  }
  if (typeof unresolvedThreadCount === "number" && unresolvedThreadCount !== 0) {
    if (unresolvedThreadCount === -1) {
      failures.push("could not fetch review thread state from GitHub API; re-run gate evidence check when API connectivity is restored");
    } else {
      failures.push(`unresolved review threads present (${unresolvedThreadCount}); must resolve all threads before merge`);
    }
  }
  if (staleRunnerCheck && !staleRunnerCheck.ok) {
    for (const failure of staleRunnerCheck.failures) {
      failures.push(failure);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
  };
}
async function ledgerExists(fullPath) {
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}
/**
 * True if the ledger (relative path) exists under ANY enumerated checkout
 * (main + every worktree). Fixes #1050: a ledger written in the PR worktree is
 * found even when the check runs from a different checkout's git-toplevel.
 */
async function ledgerExistsInAny(checkouts, ledgerPath) {
  for (const root of checkouts) {
    if (await ledgerExists(path.resolve(root, ledgerPath))) {
      return true;
    }
  }
  return false;
}
/**
 * Read the recorded fan-out `provenance` object from a ledger across the
 * enumerated checkouts. Mirrors ledgerExistsInAny's "ANY checkout satisfies"
 * semantics: prefers the FIRST checkout whose ledger provenance actually
 * SATISFIES enforcement (internally consistent AND distinctReviewers >= floor),
 * so a below-floor or provenance-less ledger in an earlier-enumerated checkout
 * cannot SHADOW a valid one in the PR worktree (which would falsely fail closed).
 * Falls back to the first non-null provenance (for a useful diagnostic message)
 * only when NO checkout satisfies, and null only when none is present. Only
 * called when requireFanoutProvenance is enabled so the default path pays no I/O.
 */
async function readLedgerProvenanceInAny(checkouts, ledgerPath) {
  let firstNonNull = null;
  for (const root of checkouts) {
    const full = path.resolve(root, ledgerPath);
    try {
      const parsed = JSON.parse(await readFile(full, "utf8"));
      const prov = parsed && typeof parsed === "object" ? parsed.provenance : null;
      if (prov == null) continue; // ledger present but no provenance — keep scanning.
      if (provenanceConsistencyError(prov) === null && prov.distinctReviewers >= FANOUT_PROVENANCE_MIN_REVIEWERS) {
        return prov; // satisfying ledger — prefer it over any earlier below-floor one.
      }
      if (firstNonNull === null) firstNonNull = prov; // remember for diagnostics.
    } catch {
      // Missing/unreadable/malformed ledger in this checkout — try the next.
    }
  }
  return firstNonNull;
}
/**
 * Build the fan-out evidence enforcement descriptor.
 *
 * Enforcement is ON by default (opt-out via gates.requireFanoutEvidence: false).
 * Returns { required: false } when enforcement is disabled OR when config is
 * unavailable (config == null — null or undefined — after a failed load) — config-unavailable must
 * fail open and never enable enforcement. When enabled, records per-required-gate
 * executionMode and whether the deterministic findings-log ledger exists for the
 * reviewed head SHA so the pre-merge check can fail closed on inline verdicts or
 * missing ledgers.
 */
export async function buildFanoutEnforcement({ repo, pr, currentHeadSha, draftGateMarker, preApprovalGateMarker, config, cwd }) {
  // Fail open when config could not be loaded/validated. `== null` covers both
  // null and undefined; the loader only ever yields null on failure, but the
  // loose check defensively treats an absent config as unavailable.
  if (config == null || !resolveRequireFanoutEvidence(config)) {
    // Disabled/unavailable return is intentionally byte-identical to before
    // (no requireProvenance key): buildPreMergeGateCheck only reads it inside
    // the `required` block, so this preserves the exact existing shape.
    return { required: false, gates: [] };
  }
  // Provenance enforcement is opt-in and layered ON TOP of fan-out evidence: it
  // only takes effect while evidence enforcement (above) is active.
  const requireProvenance = resolveRequireFanoutProvenance(config);
  const draftRequired = resolveGateConfig(config, "draft").required;
  const preApprovalRequired = resolveGateConfig(config, "preApproval").required;
  const gateSpecs = [
    { name: "draft_gate", marker: draftGateMarker, required: draftRequired },
    { name: "pre_approval_gate", marker: preApprovalGateMarker, required: preApprovalRequired },
  ].filter((spec) => spec.required && spec.marker.visible);
  const gates = [];
  const checkouts = resolveLedgerCheckouts(cwd);
  for (const spec of gateSpecs) {
    const headSha = spec.marker.headSha ?? currentHeadSha;
    const ledgerPath = buildLogPath({ repo, pr, gate: spec.name, headSha, tmpRoot: "tmp" });
    gates.push({
      name: spec.name,
      executionMode: spec.marker.executionMode ?? null,
      ledgerPath,
      ledgerExists: await ledgerExistsInAny(checkouts, ledgerPath),
      provenance: requireProvenance ? await readLedgerProvenanceInAny(checkouts, ledgerPath) : null,
    });
  }
  return { required: true, requireProvenance, gates };
}
export async function detectCheckpointEvidence(options, { env = process.env, ghCommand = "gh", cwd = process.cwd() } = {}) {
  const runnerOwnership = await ensureAsyncRunnerOwnership({
    repo: options.repo,
    pr: options.pr,
    env,
    cwd,
    claimIfMissing: false,
    requireExisting: false,
  });
  if (!runnerOwnership.ok) {
    const error = new Error(runnerOwnership.message);
    error.runnerOwnership = runnerOwnership;
    throw error;
  }
  const staleRunnerDetection = await detectStaleRunner({
    repo: options.repo,
    pr: options.pr,
    cwd,
  });
  if (!staleRunnerDetection.ok) {
    const error = new Error(staleRunnerDetection.message);
    error.staleRunner = staleRunnerDetection;
    throw error;
  }
  const prPayload = await runGhJson(["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid"], { env, ghCommand });
  const commentsPayload = normalizeIssueCommentsPayload(await runGhJson(["api", "--paginate", "--slurp", `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`], { env, ghCommand }));
  const currentHeadSha = typeof prPayload?.headRefOid === "string" && prPayload.headRefOid.trim().length > 0
    ? prPayload.headRefOid.trim()
    : null;
  if (!currentHeadSha) {
    throw new Error("Invalid gh pr view payload: missing headRefOid");
  }
  // Also scan PR reviews for gate comments posted via the review API.
  // This prevents duplicates when an escape-hatch path posted a gate verdict
  // as a PR review rather than an issue comment (root cause 3 from issue #692).
  let prReviews = [];
  try {
    const reviewsRaw = await runGhJson(["api", "--paginate", "--slurp", `repos/${options.repo}/pulls/${options.pr}/reviews?per_page=100`], { env, ghCommand });
    prReviews = normalizePrReviewsPayload(reviewsRaw);
  } catch {
    // Graceful fallback: PR reviews fetch failure is non-fatal.
    // We continue with issue comments only.
  }
  const allComments = [...commentsPayload, ...prReviews];
  const commentSummary = summarizeGateReviewComments(allComments);
  const markerSummary = summarizeGateReviewCommentMarkers(allComments, { headSha: currentHeadSha });
  const draftGateMarker = normalizeGateMarkerSummary(markerSummary.draft_gate);
  const preApprovalGateMarker = normalizeGateMarkerSummary(markerSummary.pre_approval_gate);
  // loadDevLoopConfig never throws: it returns { config, warnings, errors }.
  // A non-empty errors array means the config could not be loaded/validated, so
  // treat it as config-unavailable and leave fan-out enforcement disabled
  // (preserves default behavior). Other gate checks remain unaffected.
  let config = null;
  const { config: loadedConfig, errors: configErrors } = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(cwd) });
  config = Array.isArray(configErrors) && configErrors.length > 0 ? null : loadedConfig;
  const fanoutEnforcement = await buildFanoutEnforcement({
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    draftGateMarker,
    preApprovalGateMarker,
    config,
    cwd,
  });
  return {
    ok: true,
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    draftGate: normalizeGateSummary(commentSummary.draft_gate),
    preApprovalGate: normalizeGateSummary(commentSummary.pre_approval_gate),
    draftGateMarker,
    preApprovalGateMarker,
    draftGateSatisfied: commentSummary.draft_gate?.verdict === "clean" && typeof commentSummary.draft_gate?.headSha === "string",
    fanoutEnforcement,
    ...(runnerOwnership.status !== "skipped_no_async_run_id" ? { runnerOwnership } : {}),
    staleRunner: {
      status: staleRunnerDetection.status,
      activeRun: staleRunnerDetection.activeRun,
      exitSignals: staleRunnerDetection.exitSignal?.signals ?? [],
      staleRunner: staleRunnerDetection.staleRunner,
      maxAgeMs: staleRunnerDetection.maxAgeMs,
      filePath: staleRunnerDetection.filePath,
    },
  };
}
async function main() {
  let options;
  try {
    options = parseDetectCheckpointEvidenceCliArgs(process.argv.slice(2));
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
    const result = await detectCheckpointEvidence(options);
    let unresolvedThreadCount = -1;
    try {
      const threadsPayload = await fetchGithubReviewThreadsPayload(options, { env: process.env });
      const parsedThreads = parseReviewThreads(threadsPayload);
      unresolvedThreadCount = parsedThreads?.summary?.unresolvedThreads ?? 0;
    } catch {
      unresolvedThreadCount = -1;
    }
    const staleRunnerCheck = {
      ok: result.staleRunner.status === "fresh_runner" || result.staleRunner.status === "no_owner_record",
      failures: result.staleRunner.status === "stale_runner"
        ? [`stale runner: ${result.staleRunner.staleRunner?.runId} claimed ${result.staleRunner.staleRunner?.claimedAgeMs}ms ago, last updated ${result.staleRunner.staleRunner?.updatedAgeMs}ms ago (max age ${result.staleRunner.staleRunner?.maxAgeMs}ms)`]
        : result.staleRunner.status === "exit_signal_recorded"
        ? [`exit signal recorded for run ${result.staleRunner.activeRun?.runId}: refuse to merge`]
        : [],
    };
    const preMergeGateCheck = buildPreMergeGateCheck(result, unresolvedThreadCount, staleRunnerCheck, result.fanoutEnforcement);
    const output = { ...result, preMergeGateCheck, staleRunnerCheck };
    if (!preMergeGateCheck.ok) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: `Pre-merge gate evidence check failed: ${preMergeGateCheck.failures.join("; ")}`,
        repo: result.repo,
        pr: result.pr,
        currentHeadSha: result.currentHeadSha,
        preMergeGateCheck,
        staleRunnerCheck,
        staleRunner: result.staleRunner,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = emitResult(output, { jq: options.jq, silent: options.silent });
  } catch (error) {
    if (error && typeof error === "object" && "staleRunner" in error && error.staleRunner) {
      const staleRunnerCheck = {
        ok: false,
        failures: error.staleRunner.status === "stale_runner"
          ? [`stale runner: ${error.staleRunner.staleRunner?.runId} claimed ${error.staleRunner.staleRunner?.claimedAgeMs}ms ago, last updated ${error.staleRunner.staleRunner?.updatedAgeMs}ms ago (max age ${error.staleRunner.staleRunner?.maxAgeMs}ms)`]
          : error.staleRunner.status === "exit_signal_recorded"
          ? [`exit signal recorded for run ${error.staleRunner.activeRun?.runId}: refuse to merge`]
          : [],
      };
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: error.staleRunner.error,
        status: error.staleRunner.status,
        message: error.staleRunner.message,
        staleRunner: {
          status: error.staleRunner.status,
          activeRun: error.staleRunner.activeRun,
          exitSignals: error.staleRunner.exitSignal?.signals ?? [],
          staleRunner: error.staleRunner.staleRunner,
          maxAgeMs: error.staleRunner.maxAgeMs,
          filePath: error.staleRunner.filePath,
        },
        staleRunnerCheck,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    if (error && typeof error === "object" && "runnerOwnership" in error && error.runnerOwnership) {
      process.stderr.write(`${JSON.stringify(error.runnerOwnership)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
