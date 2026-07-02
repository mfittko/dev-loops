#!/usr/bin/env node
import path from "node:path";
import {
  buildParseError,
  formatCliError,
  isCopilotLogin,
  isDirectCliRun,
  parseJsonText,
  parseReviewThreads,
  resolveDraftGateRoundResetMs,
  summarizeCopilotReviews,
} from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { loadDevLoopConfig, resolveGateConfig, resolveRefinement, resolveRefinementConfig, resolveWorkflowConfig } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildSnapshotFromPrFacts, interpretLoopState, summarizeLoopInterpretation } from "@dev-loops/core/loop/copilot-loop-state";
import { evaluatePrGateCoordination, PR_CHECKPOINT, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import { shouldGuardCopilotReviewRequest } from "@dev-loops/core/loop/pr-gate-coordination";
import { UI_E2E_CHECK_NAMES } from "@dev-loops/core/loop/ui-e2e-scoping";
import { fetchGithubReviewThreadsPayload } from "../github/capture-review-threads.mjs";
import { detectCheckpointEvidence } from "../github/detect-checkpoint-evidence.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { parseArgs } from "node:util";
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
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
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
    throw parseError(`Unknown argument: ${token.rawName}`);
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
    ["pr", "view", String(pr), "--repo", repo, "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  return parseJsonText(result.stdout, { label: "gh pr view" });
}

// GitHub computes `mergeable` asynchronously, so a freshly-pushed head briefly
// reads `UNKNOWN`. After the initial fetch, re-poll up to `maxPolls` more times
// while the value stays UNKNOWN (so at most 1 + maxPolls total fetches) before
// deciding; never treat a transient UNKNOWN as a pass — the caller fails closed
// to recheck if it never settles. (issue #980)
export async function fetchPrFactsWithSettledMergeable(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    maxPolls = 3,
    pollDelayMs = 1500,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch = fetchPrFacts,
  } = {},
) {
  let prData = await fetch(options, { env, ghCommand });
  let polls = 0;
  while (String(prData?.mergeable || "").toUpperCase() === "UNKNOWN" && polls < maxPolls) {
    polls += 1;
    await sleep(pollDelayMs);
    prData = await fetch(options, { env, ghCommand });
  }
  return prData;
}
// Changed-file paths from `gh pr view --json files` (issue #976). Feeds the
// path-triggered UI e2e scoping precondition in the evaluator.
export function extractChangedFiles(prData) {
  const files = Array.isArray(prData?.files) ? prData.files : [];
  return files
    .map((entry) => (typeof entry?.path === "string" ? entry.path : null))
    .filter((p) => typeof p === "string" && p.length > 0);
}

// Whether the shared UI e2e suite passed for this head, read deterministically
// from the statusCheckRollup: every UI e2e check that is present must be
// SUCCESS. Returns null when no UI e2e check is present in the rollup (unknown
// → the evaluator fails closed), false if any present UI e2e check is not a
// success, true if all present ones succeeded.
export function deriveUiE2ePassed(prData, checkNames = UI_E2E_CHECK_NAMES) {
  const rollup = Array.isArray(prData?.statusCheckRollup) ? prData.statusCheckRollup : [];
  const wanted = new Set(checkNames);
  const present = rollup.filter((entry) => wanted.has(entry?.name) || wanted.has(entry?.context));
  if (present.length === 0) return null;
  return present.every((entry) => {
    const conclusion = String(entry?.conclusion ?? "").toUpperCase();
    const state = String(entry?.state ?? "").toUpperCase();
    // SKIPPED = "not applicable to this run" (e.g. viewer-smoke when no viewer files changed) — not a failure.
    return conclusion === "SUCCESS" || conclusion === "SKIPPED" || state === "SUCCESS" || state === "SKIPPED";
  });
}

// Ordered, de-duplicated list of ALL closing-referenced issue numbers for a PR.
// Umbrella PRs legitimately close multiple issues (#1052), so the refinement
// guard resolves against every one of them, not just a unique single ref.
export function resolveLinkedIssuesFromPr(prData) {
  if (!prData || typeof prData !== "object") return [];
  const dedupe = (nums) => {
    const seen = new Set();
    const out = [];
    for (const n of nums) {
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };
  const closing = Array.isArray(prData.closingIssuesReferences) ? prData.closingIssuesReferences : [];
  const closingNumbers = dedupe(closing.map((entry) => Number(entry?.number)));
  if (closingNumbers.length > 0) {
    return closingNumbers;
  }
  const body = typeof prData.body === "string" ? prData.body : "";
  if (body.length === 0) return [];
  const matches = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/gi) || [];
  return dedupe(matches.map((m) => Number((/(\d+)/.exec(m) || [])[1])));
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
export async function loadRefinementArtifact({ repo, prData, prDraft, prClosed, prMerged }, { env = process.env, ghCommand = "gh" } = {}) {
  const linkedIssues = resolveLinkedIssuesFromPr(prData);
  if (linkedIssues.length === 0) {
    if (prDraft) {
      return {
        status: "missing",
        linkedIssue: null,
        linkedIssues: [],
        reason: "Draft PR has no deterministically resolvable linked issue (no closingIssuesReferences and no Closes/Fixes/Resolves #n reference in body); draft gate cannot verify a refinement artifact.",
        finding: "missing_refinement_artifact",
      };
    }
    return {
      status: "unknown",
      linkedIssue: null,
      linkedIssues: [],
      reason: "No deterministically resolvable linked issue (no closingIssuesReferences and no Closes/Fixes/Resolves #n reference in body).",
    };
  }
  const scopeLabel = linkedIssues.map((n) => `#${n}`).join(", ");
  if (!prDraft && !prClosed && !prMerged) {
    return {
      status: "unknown",
      linkedIssue: linkedIssues.length === 1 ? linkedIssues[0] : null,
      linkedIssues,
      reason: `Linked issue(s) ${scopeLabel} detected (${linkedIssues.length}); refinement check is a draft-gate boundary and the PR is not draft, so the check is informational only and does not fetch issue bodies.`,
    };
  }
  const { detectIssueRefinementArtifact } = await import("@dev-loops/core/loop/issue-refinement-artifact");
  // Fetch and evaluate every closing-referenced issue. An umbrella PR's scope
  // is refined if AT LEAST ONE linked issue carries a refinement artifact.
  const evaluated = [];
  for (const issue of linkedIssues) {
    const body = await fetchIssueBody({ repo, issue }, { env, ghCommand });
    if (body === null) {
      evaluated.push({ issue, artifact: null });
      continue;
    }
    evaluated.push({ issue, artifact: detectIssueRefinementArtifact({ body, issueNumber: issue }) });
  }
  const refinedIssues = evaluated
    .filter((e) => e.artifact && e.artifact.hasACs === true)
    .map((e) => e.issue);
  const firstPresent = evaluated.find((e) => e.artifact && e.artifact.hasACs === true);
  const isUmbrella = linkedIssues.length > 1;

  if (firstPresent) {
    const a = firstPresent.artifact;
    return {
      status: "present",
      linkedIssue: firstPresent.issue,
      linkedIssues,
      refinedIssues,
      source: a.source,
      acItems: a.acItems,
      dodItems: a.dodItems,
      sections: a.sections,
      linkedDoc: a.linkedDoc,
      reason: isUmbrella
        ? `Refinement artifact present via linked issue #${firstPresent.issue} (umbrella PR closes ${scopeLabel}).`
        : a.reason,
      finding: a.finding,
      _onlyEnforcedWhenDraft: prDraft === true,
    };
  }

  // None of the linked issues carry a refinement artifact (or all bodies failed
  // to fetch). Report against the first linked issue for single-value consumers.
  // Note: `finding`/`missing` here is only enforced by the gate when the PR is
  // draft (`_onlyEnforcedWhenDraft`); closed/merged PRs surface it informationally.
  const firstEvaluated = evaluated[0];
  const allFailed = evaluated.every((e) => e.artifact === null);
  if (allFailed) {
    // Preserve prior single-issue semantics: draft → missing, else unknown.
    if (prDraft) {
      return {
        status: "missing",
        linkedIssue: firstEvaluated.issue,
        linkedIssues,
        refinedIssues,
        reason: `Failed to fetch body for linked issue(s) ${scopeLabel}; draft gate cannot verify a refinement artifact, treating as missing.`,
        finding: "missing_refinement_artifact",
      };
    }
    return {
      status: "unknown",
      linkedIssue: linkedIssues.length === 1 ? linkedIssues[0] : firstEvaluated.issue,
      linkedIssues,
      refinedIssues,
      reason: `Failed to fetch body for linked issue(s) ${scopeLabel}; refinement status is unknown.`,
    };
  }
  // Mixed branch: not allFailed, so at least one body fetched but none is
  // refined. Report against the first successfully-fetched (non-null) issue —
  // `evaluated[0]` may be a failed fetch: it still retains its `issue` field but
  // has `artifact: null` (body fetch / artifact detection failed for that issue).
  const firstFetched = evaluated.find((e) => e.artifact !== null);
  const first = firstFetched.artifact;
  return {
    status: "missing",
    linkedIssue: firstFetched.issue,
    linkedIssues,
    refinedIssues,
    source: first.source,
    acItems: first.acItems,
    dodItems: first.dodItems,
    sections: first.sections,
    linkedDoc: first.linkedDoc,
    reason: isUmbrella
      ? `No linked issue (${scopeLabel}) carries a refinement artifact (ACs/DoD); draft gate cannot verify a refinement artifact.`
      : first.reason,
    finding: "missing_refinement_artifact",
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
export async function loadPrGateCoordinationContext(options, runtime = {}) {
  const prData = await fetchPrFactsWithSettledMergeable(options, runtime);
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
  // Shared with request-copilot-review so both scripts compute the same
  // completed round count / cap (#896). Prefix matching for the head SHA lets
  // shortened SHAs (7+) from gate comments match the full headRefOid.
  const draftGateResetAtMs = resolveDraftGateRoundResetMs({
    draftGate: gateEvidence.draftGate,
    currentHeadSha,
  });
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
  // Resolve the refinement config (round cap, low-signal heuristic) and feed it to
  // the interpreter. Without it, the interpreter cannot see maxCopilotRounds and so
  // never resolves ROUND_CAP_CLEAN_FALLBACK — a post-cap clean head would fall to
  // READY_TO_REREQUEST_REVIEW, dead-ending the loop at the round cap (#896). This
  // keeps the gate-coordination interpretation consistent with the standalone
  // detect-copilot-loop-state path and with request-copilot-review's cap logic.
  const interpreterRepoRoot = runtime.repoRoot ?? resolveRepoRoot(process.cwd());
  const interpreterConfigResult = await loadDevLoopConfig({ repoRoot: interpreterRepoRoot });
  const interpreterRefinementConfig = (Array.isArray(interpreterConfigResult.errors) && interpreterConfigResult.errors.length > 0)
    ? resolveRefinement({ version: 1 })
    : resolveRefinement(interpreterConfigResult.config ?? { version: 1 });
  const interpretation = interpretLoopState(snapshot, interpreterRefinementConfig);
  const disposition = summarizeLoopInterpretation(interpretation, interpreterRefinementConfig);
  const mergeStateStatus = typeof prData?.mergeStateStatus === "string" && prData.mergeStateStatus.trim().length > 0
    ? prData.mergeStateStatus.trim().toUpperCase()
    : null;
  const mergeable = typeof prData?.mergeable === "string" && prData.mergeable.trim().length > 0
    ? prData.mergeable.trim().toUpperCase()
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
    mergeable,
    conflictFiles,
    prData,
    snapshot,
    gateEvidence,
    interpretation,
    disposition,
    refinementArtifact,
    refinementConfig: interpreterRefinementConfig,
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
  const repoRoot = runtime.repoRoot ?? resolveRepoRoot(process.cwd());
  const configLoadResult = await loadDevLoopConfig({ repoRoot });
  const hasConfigErrors = Array.isArray(configLoadResult.errors) && configLoadResult.errors.length > 0;
  const config = hasConfigErrors ? {} : (configLoadResult.config ?? {});
  const draftGateConfig = resolveGateConfig(config, "draft");
  const maxCopilotRounds = resolveRefinementConfig(config, "maxCopilotRounds");
  const result = evaluatePrGateCoordination({
    repo: context.repo,
    pr: context.pr,
    currentHeadSha: context.currentHeadSha,
    prDraft: Boolean(context.prData?.isDraft),
    prClosed: String(context.prData?.state || "").toUpperCase() === "CLOSED",
    prMerged: String(context.prData?.state || "").toUpperCase() === "MERGED",
    prTitle: context.prData?.title,
    mergeStateStatus: context.mergeStateStatus,
    mergeable: context.mergeable,
    conflictFiles: context.conflictFiles,
    // UI e2e auto-scoping (#976): path-triggered + fail-closed precondition.
    changedFiles: extractChangedFiles(context.prData),
    uiE2ePassed: deriveUiE2ePassed(context.prData),
    lifecycleState: context.interpretation.state,
    loopDisposition: context.disposition.loopDisposition,
    ciStatus: context.snapshot?.ciStatus ?? null,
    copilotReviewRoundCount: context.snapshot?.copilotReviewRoundCount ?? 0,
    maxCopilotRounds,
    sameHeadCleanConverged: context.interpretation.sameHeadCleanConverged,
    draftGateRequireCi: draftGateConfig.requireCi,
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
  // Round-cap clean fallback (#896): the interpreter resolved a clean post-cap head
  // (zero unresolved threads + green CI) that Copilot will not re-review. The formal
  // request guard must not fire here — pre_approval_gate reviews the post-cap head.
  const roundCapCleanFallback = context.interpretation?.roundCapCleanEligible ?? false;
  const copilotReviewEverFormallyRequested = copilotReviewRequestStatus === "none"
    && guardBoundaries.has(result.gateBoundary)
    && !(roundCapReached && (sameHeadCleanConverged || roundCapCleanFallback))
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
    sameHeadCleanConverged,
    roundCapCleanFallback,
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
