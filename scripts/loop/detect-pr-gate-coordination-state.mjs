#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildParseError,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  normalizeTimestamp,
  parseJsonText,
  parseReviewThreads,
  summarizeCopilotReviews,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireOptionValue, runChild } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveGateConfig, resolveRefinementConfig, resolveWorkflowConfig } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildSnapshotFromPrFacts, interpretLoopState, summarizeLoopInterpretation } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluatePrGateCoordination, PR_CHECKPOINT, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { shouldGuardCopilotReviewRequest } from "@dev-loops/core/loop/pr-gate-coordination";
import { fetchGithubReviewThreadsPayload } from "../github/capture-review-threads.mjs";
import { detectCheckpointEvidence } from "../github/detect-checkpoint-evidence.mjs";
const UNMERGED_GIT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const USAGE = `Usage: detect-pr-gate-coordination-state.mjs --repo <owner/name> --pr <number>
Determine which PR gate/transition is legal next for a pull request.
Required:
  --repo <owner/name>   Repository slug (e.g. owner/repo)
  --pr <number>         Pull request number
Optional:
Output (stdout, JSON):
  {
    "ok": true,
    "repo": "owner/repo",
    "pr": 266,
    "currentHeadSha": "...",
    "mergeStateStatus": "DIRTY",
    "conflictFiles": ["config.test.mjs", "extension/README.md"],
    "lifecycleState": "pr_ready_no_feedback",
    "loopDisposition": "action_required",
    "gateBoundary": "conflict_resolution",
    "draftGate": {
      "visible": true,
      "markerVisible": false,
      "anyVisible": true,
      "currentHead": false,
      "contractComplete": false,
      "currentHeadClean": false,
      "headSha": "c94679e",
      "verdict": "clean"
    },
    "preApprovalGate": {
      "visible": false,
      "markerVisible": false,
      "anyVisible": false,
      "currentHead": false,
      "contractComplete": false,
      "currentHeadClean": false,
      "headSha": null,
      "verdict": null
    },
    "allowedNextActions": ["resolve_merge_conflicts"],
    "forbiddenActions": ["run_pre_approval_gate", "declare_merge_ready"],
    "nextAction": "resolve_merge_conflicts",
    "reason": "..."
  }
Error output (stderr, JSON):
  { "ok": false, "error": "...", "usage": "..." }
  { "ok": false, "error": "..." }
Exit codes:
  0  Success
  1  Argument error or gh/runtime failure`.trim();
const parseError = buildParseError(USAGE);
export function parseDetectPrGateCoordinationCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      return options;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError).trim();
      continue;
    }
    if (token === "--pr") {
      options.pr = parsePrNumber(requireOptionValue(args, "--pr", parseError), parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("detect-pr-gate-coordination-state requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
function parseRequestedReviewersPayload(text) {
  const payload = parseJsonText(text, { label: "gh requested reviewers" });
  const users = Array.isArray(payload?.users) ? payload.users : [];
  return {
    requested: users.some((user) => isCopilotLogin(user?.login)),
  };
}
export function parseGitStatusConflictFiles(text) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }
  const records = text.includes("\0")
    ? text.split("\0")
    : text.split(/\r?\n/);
  const conflictFiles = [];
  for (const rawRecord of records) {
    if (rawRecord.length < 4) {
      continue;
    }
    const status = rawRecord.slice(0, 2);
    if (!UNMERGED_GIT_STATUS_CODES.has(status)) {
      continue;
    }
    const rawPath = rawRecord.slice(3);
    if (rawPath.trim().length > 0 && !conflictFiles.includes(rawPath)) {
      conflictFiles.push(rawPath);
    }
  }
  return conflictFiles;
}
async function fetchRequestedReviewers({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseRequestedReviewersPayload(result.stdout);
}
async function fetchPrFacts({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: "gh pr view" });
}
export function resolveLinkedIssueFromPr(prData) {
  if (!prData || typeof prData !== "object") return null;
  const closing = Array.isArray(prData.closingIssuesReferences) ? prData.closingIssuesReferences : [];
  const closingNumbers = closing
    .map((entry) => Number(entry?.number))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (closingNumbers.length === 1) {
    return closingNumbers[0];
  }
  const body = typeof prData.body === "string" ? prData.body : "";
  if (body.length === 0) return null;
  const matches = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/gi) || [];
  const bodyNumbers = matches
    .map((m) => Number((/(\d+)/.exec(m) || [])[1]))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (bodyNumbers.length === 1) {
    return bodyNumbers[0];
  }
  return null;
}
async function fetchIssueBody({ repo, issue }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["issue", "view", String(issue), "--repo", repo, "--json", "body"],
    env,
  );
  if (result.code !== 0) {
    return null;
  }
  try {
    const payload = parseJsonText(result.stdout, { label: "gh issue view" });
    return typeof payload?.body === "string" ? payload.body : "";
  } catch {
    return null;
  }
}
async function loadRefinementArtifact({ repo, prData, prDraft, prClosed, prMerged }, { env = process.env, ghCommand = "gh" } = {}) {
  const linkedIssue = resolveLinkedIssueFromPr(prData);
  if (linkedIssue === null) {
    if (prDraft) {
      return {
        status: "missing",
        linkedIssue: null,
        reason: "Draft PR has no deterministically resolvable linked issue (no closingIssuesReferences, no unique Closes/Fixes/Resolves pattern in body); draft gate cannot verify a refinement artifact.",
        finding: "missing_refinement_artifact",
      };
    }
    return {
      status: "unknown",
      linkedIssue: null,
      reason: "No deterministically resolvable linked issue (no closingIssuesReferences, no unique Closes/Fixes/Resolves pattern in body).",
    };
  }
  if (!prDraft && !prClosed && !prMerged) {
    return {
      status: "unknown",
      linkedIssue,
      reason: `Linked issue #${linkedIssue} detected; refinement check is a draft-gate boundary and the PR is not draft, so the check is informational only and does not fetch the issue body.`,
    };
  }
  const body = await fetchIssueBody({ repo, issue: linkedIssue }, { env, ghCommand });
  if (body === null) {
    if (prDraft) {
      return {
        status: "missing",
        linkedIssue,
        reason: `Failed to fetch body for linked issue #${linkedIssue}; draft gate cannot verify a refinement artifact, treating as missing.`,
        finding: "missing_refinement_artifact",
      };
    }
    return {
      status: "unknown",
      linkedIssue,
      reason: `Failed to fetch body for linked issue #${linkedIssue}; refinement status is unknown.`,
    };
  }
  const { detectIssueRefinementArtifact } = await import("@dev-loops/core/loop/issue-refinement-artifact");
  const artifact = detectIssueRefinementArtifact({ body, issueNumber: linkedIssue });
  return {
    status: artifact.hasACs ? "present" : "missing",
    linkedIssue,
    source: artifact.source,
    acItems: artifact.acItems,
    dodItems: artifact.dodItems,
    sections: artifact.sections,
    linkedDoc: artifact.linkedDoc,
    reason: artifact.reason,
    finding: artifact.finding,
    _onlyEnforcedWhenDraft: prDraft === true,
  };
}
async function fetchLocalConflictFiles({ env = process.env, gitCommand = "git" } = {}) {
  let result;
  try {
    result = await runChild(
      gitCommand,
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=no"],
      env,
    );
  } catch {
    return [];
  }
  if (result.code !== 0) {
    return [];
  }
  return parseGitStatusConflictFiles(result.stdout);
}
async function loadRetrospectiveCheckpoint(repoRoot) {
  const checkpointPath = path.join(repoRoot, ".pi", "dev-loop-retrospective-checkpoint.json");
  try {
    const checkpointText = await readFile(checkpointPath, "utf8");
    const checkpoint = parseJsonText(checkpointText, { label: "retrospective checkpoint" });
    return checkpoint && typeof checkpoint === "object" ? checkpoint : null;
  } catch (error) {
    return null;
  }
}
export async function loadPrGateCoordinationContext(options, runtime = {}) {
  const prData = await fetchPrFacts(options, runtime);
  const currentHeadSha = typeof prData?.headRefOid === "string" && prData.headRefOid.trim().length > 0
    ? prData.headRefOid.trim()
    : null;
  if (!currentHeadSha) {
    throw new Error("Invalid gh pr view payload: missing headRefOid");
  }
  const requestedReviewers = await fetchRequestedReviewers(options, runtime);
  const threadsPayload = await fetchGithubReviewThreadsPayload(options, runtime);
  const parsedThreads = parseReviewThreads(threadsPayload);
  const gateEvidence = await detectCheckpointEvidence(options, runtime);
  // When draft gate was re-passed on a different head, use its timestamp
  // to reset the Copilot round count — only reviews after the re-pass count.
  // Use prefix matching for the head SHA comparison so shortened SHAs (7+)
  // from gate comments match the full headRefOid.
  const draftGateHeadSha = gateEvidence.draftGate?.headSha;
  const draftGateOnCurrentHead = typeof draftGateHeadSha === "string"
    && typeof currentHeadSha === "string"
    && currentHeadSha.startsWith(draftGateHeadSha);
  const draftGateResetAtMs = gateEvidence.draftGate?.verdict === "clean"
    && typeof draftGateHeadSha === "string"
    && !draftGateOnCurrentHead
    && typeof gateEvidence.draftGate?.updatedAt === "string"
    ? normalizeTimestamp(gateEvidence.draftGate.updatedAt)
    : null;
  const reviewSummary = summarizeCopilotReviews(prData?.reviews, { headSha: currentHeadSha, draftGateResetAtMs });
  const reviewRequestStatus = requestedReviewers.requested
    ? "requested"
    : (reviewSummary.hasPendingReviewOnCurrentHead ? "already-requested" : "none");
  const snapshot = buildSnapshotFromPrFacts({
    prData,
    prNumber: options.pr,
    copilotReviewRequestStatus: reviewRequestStatus,
    copilotReviewPresent: reviewSummary.copilotReviewPresent,
    copilotReviewOnCurrentHead: reviewSummary.hasSubmittedReviewOnCurrentHead,
    unresolvedThreadCount: parsedThreads.summary.unresolvedThreads,
    actionableThreadCount: parsedThreads.summary.actionableThreads,
    copilotReviewRoundCount: reviewSummary.completedCopilotReviewRounds,
  });
  if (snapshot.unresolvedThreadCount > 0
      && !snapshot.copilotReviewOnCurrentHead
      && snapshot.copilotReviewPresent) {
    snapshot.agentFixStatus = "applied";
  }
  const conflictFiles = await fetchLocalConflictFiles(runtime);
  if (gateEvidence.currentHeadSha !== currentHeadSha) {
    throw new Error(`PR head changed while loading gate coordination facts for ${options.repo}#${options.pr}; refuse to evaluate mixed-head gate state.`);
  }
  const interpretation = interpretLoopState(snapshot);
  const disposition = summarizeLoopInterpretation(interpretation);
  const mergeStateStatus = typeof prData?.mergeStateStatus === "string" && prData.mergeStateStatus.trim().length > 0
    ? prData.mergeStateStatus.trim().toUpperCase()
    : null;
  const isDraft = Boolean(prData?.isDraft);
  const isClosed = String(prData?.state || "").toUpperCase() === "CLOSED";
  const isMerged = String(prData?.state || "").toUpperCase() === "MERGED";
  const refinementArtifact = await loadRefinementArtifact(
    { repo: options.repo, prData, prDraft: isDraft, prClosed: isClosed, prMerged: isMerged },
    runtime,
  );
  return {
    repo: options.repo,
    pr: options.pr,
    currentHeadSha,
    mergeStateStatus,
    conflictFiles,
    prData,
    snapshot,
    gateEvidence,
    interpretation,
    disposition,
    refinementArtifact,
  };
}

async function fetchCopilotEverFormallyRequested({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["api", `repos/${repo}/issues/${pr}/timeline`, "--paginate", "--jq",
      '.[] | select(.event == "review_requested") | select(.requested_reviewer.login != null) | .requested_reviewer.login'],
    env,
  );
  if (result.code !== 0) return false;
  for (const line of result.stdout.trim().split("\n")) {
    const login = line.trim();
    if (login && isCopilotLogin(login)) return true;
  }
  return false;
}

export async function detectPrGateCoordinationState(options, runtime = {}) {
  const context = await loadPrGateCoordinationContext(options, runtime);
  const repoRoot = runtime.repoRoot ?? process.cwd();
  const configLoadResult = await loadDevLoopConfig({ repoRoot });
  const hasConfigErrors = Array.isArray(configLoadResult.errors) && configLoadResult.errors.length > 0;
  const config = hasConfigErrors ? {} : (configLoadResult.config ?? {});
  const draftGateConfig = resolveGateConfig(config, "draft");
  const maxCopilotRounds = resolveRefinementConfig(config, "maxCopilotRounds");
  const requireRetrospectiveGate = resolveWorkflowConfig(config, "requireRetrospectiveGate");
  const retrospectiveCheckpoint = await loadRetrospectiveCheckpoint(repoRoot);
  const result = evaluatePrGateCoordination({
    repo: context.repo,
    pr: context.pr,
    currentHeadSha: context.currentHeadSha,
    prDraft: Boolean(context.prData?.isDraft),
    prClosed: String(context.prData?.state || "").toUpperCase() === "CLOSED",
    prMerged: String(context.prData?.state || "").toUpperCase() === "MERGED",
    prTitle: context.prData?.title,
    mergeStateStatus: context.mergeStateStatus,
    conflictFiles: context.conflictFiles,
    lifecycleState: context.interpretation.state,
    loopDisposition: context.disposition.loopDisposition,
    ciStatus: context.snapshot?.ciStatus ?? null,
    copilotReviewRoundCount: context.snapshot?.copilotReviewRoundCount ?? 0,
    maxCopilotRounds,
    sameHeadCleanConverged: context.interpretation.sameHeadCleanConverged,
    draftGateRequireCi: draftGateConfig.requireCi,
    requireRetrospectiveGate,
    retrospectiveCheckpoint,
    draftGate: context.gateEvidence.draftGate,
    draftGateMarker: context.gateEvidence.draftGateMarker,
    preApprovalGate: context.gateEvidence.preApprovalGate,
    preApprovalGateMarker: context.gateEvidence.preApprovalGateMarker,
    refinementArtifact: context.refinementArtifact,
  });
  // Copilot review request guard (#613): When Copilot has reviewed the PR
  // but no formal review request was made, block pre-approval gate entry.
  // Only query timeline when cheap preconditions pass — avoids unnecessary
  // API call when guard cannot possibly trigger.
  const copilotReviewRequestStatus = context.snapshot?.copilotReviewRequestStatus ?? "none";
  const guardBoundaries = new Set([
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  const roundCapReached = maxCopilotRounds !== null
    && typeof (context.snapshot?.copilotReviewRoundCount) === "number"
    && context.snapshot?.copilotReviewRoundCount >= maxCopilotRounds;
  const sameHeadCleanConverged = context.interpretation?.sameHeadCleanConverged ?? false;
  const copilotReviewEverFormallyRequested = copilotReviewRequestStatus === "none"
    && guardBoundaries.has(result.gateBoundary)
    && !(roundCapReached && sameHeadCleanConverged)
    ? await fetchCopilotEverFormallyRequested(
        { repo: context.repo, pr: context.pr },
        runtime,
      )
    : false;
  if (shouldGuardCopilotReviewRequest({
    copilotReviewRequestStatus,
    copilotReviewRoundCount: context.snapshot?.copilotReviewRoundCount ?? 0,
    copilotReviewEverFormallyRequested,
    maxCopilotRounds,
    sameHeadCleanConverged: context.interpretation?.sameHeadCleanConverged ?? false,
    gateBoundary: result.gateBoundary,
  })) {
    result.gateBoundary = PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW;
    result.nextAction = PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW;
    result.reason = "No formal Copilot review request found — run request-copilot-review.mjs first.";
    result.allowedNextActions = [PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW];
    result.forbiddenActions = [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ];
  }

  const preApprovalNeverEntered = !(result.preApprovalGate?.contractComplete === true);
  const gateBoundariesExpectingPreApproval = new Set([
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  if (preApprovalNeverEntered && gateBoundariesExpectingPreApproval.has(result.gateBoundary)) {
    result.gateBoundary = PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED;
    result.nextAction = PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE;
    result.reason = "No contract-complete pre_approval_gate marker exists for the current head SHA; run pre_approval_gate before proceeding.";
    result.allowedNextActions = [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE];
  }
  const draftGateEvidenceMissing = !(result.draftGate?.cleanEvidenceExists);
  const gateBoundariesExpectingDraftGate = new Set([
    PR_CHECKPOINT.POST_DRAFT_EXTERNAL_REVIEW,
    PR_CHECKPOINT.FEEDBACK_RESOLUTION,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_NEEDED,
    PR_CHECKPOINT.PRE_APPROVAL_GATE_WINDOW,
    PR_CHECKPOINT.FINAL_APPROVAL_READY,
  ]);
  if (draftGateEvidenceMissing && gateBoundariesExpectingDraftGate.has(result.gateBoundary)) {
    result.gateBoundary = PR_CHECKPOINT.DRAFT_GATE_NEEDED;
    result.nextAction = PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE;
    result.reason = result.draftGate?.anyVisible
      ? "Clean draft_gate evidence is required before merge (no gate exemptions, #579). A draft_gate comment exists but is not clean; convert the PR back to draft before re-running draft_gate, or clear the existing evidence before running reconcile_draft_gate."
      : "Clean draft_gate evidence is required before merge (no gate exemptions, #579). No visible clean draft_gate comment exists for this PR; run reconcile_draft_gate before proceeding.";
    result.allowedNextActions = [PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE];
    result.forbiddenActions = [
      PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE,
      PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW,
      PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW,
      PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE,
      PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL,
      PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY,
    ];
    result.gateEvidenceNote = null;
  }
  // Expose effective round count in output for testability (#560)
  result.copilotReviewRoundCount = context.snapshot?.copilotReviewRoundCount ?? 0;
  return result;
}
async function main() {
  let options;
  try {
    options = parseDetectPrGateCoordinationCliArgs(process.argv.slice(2));
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
    const result = await detectPrGateCoordinationState(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}
if (isDirectCliRun(import.meta.url)) {
  await main();
}
