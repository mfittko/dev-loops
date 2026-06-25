#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, parseJsonText } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  buildCheckpointFilePath,
  buildDefaultCheckpointDir,
} from "./_checkpoint-paths.mjs";
import { readExistingCheckpoint } from "./_checkpoint-io.mjs";
import { loadCopilotEvidence, loadReviewerEvidence } from "./_loop-evidence.mjs";
import {
  ENTRYPOINT,
  evaluateConductorRouting,
  LOOP_FAMILY,
  ROUTING_OUTCOME,
  SOURCE_MODE,
} from "@dev-loops/core/loop/conductor-routing";
import {
  ASYNC_START_STATUS,
  buildAsyncStartRejection,
  validateAsyncStartContext,
  resolveEffectiveAsyncStartMode,
} from "@dev-loops/core/loop/async-start-contract";
import { loadDevLoopConfig, resolveConductorModel, resolveAutonomyStopAt, resolveWorkflowConfig } from "@dev-loops/core/config";
import { parseArgs } from "node:util";
const USAGE = `Usage: outer-loop.mjs --repo <owner/name> --pr <number>
Thin outer-loop wrapper for the Copilot PR remediation loop.
Detects current PR state from both the Copilot inner loop and the reviewer
inner loop, decides the outer-loop action, and persists a minimal checkpoint.
Required:
  --repo <owner/name>                   Repository slug (e.g. owner/repo)
  --pr <number>                         Pull request number
  --checkpoint-dir <dir>                Directory for checkpoint artifact
                                        (default: tmp/copilot-loop/<owner>/<repo>/pr-<n>/)
  --copilot-input <path>                Path to a pre-built copilot snapshot JSON
                                        (skips live copilot detection; for testing)
  --reviewer-input <path>               Path to a pre-built reviewer snapshot JSON
                                        (skips live reviewer detection; for testing)
Output (stdout, JSON):
  { "ok": true, "outerAction": "...", "copilotState": "...",
    "reviewerState": "...", "reviewerScope": { "mode": "...",
      "reviewerLogin": "..."|null }, "reason"?: "...",
    "conductorRouting": { "routingOutcome": "...", "outerAction": "...",
      "stopReason": null|"...", "handoffEnvelope": { ... } },
    "checkpoint": { "pr": N, "repo": "...", "outerAction": "...",
      "copilotState": "...", "reviewerState": "...",
      "reviewerScope": "...", "reviewerLogin": "..."|null,
      "reason": null|"...", "timestamp": "...", "waitCycles": N,
      "headSha": "..."|null },
    "conductorModel": "..."|null }
Outer actions:
  continue_wait          Durable outer-loop wait state; re-run after bounded wait
  reenter_copilot_loop   Copilot inner loop needs action
  reenter_reviewer_loop  Reviewer inner loop needs action
  stop                   Terminal, blocked, or reconcile-needed; do not proceed
  done                   PR is merged or closed; loop complete
Stop reasons:
  pr_not_ready                         PR does not exist
  copilot_blocked                      Copilot loop is blocked
  reviewer_blocked                     Reviewer loop is blocked
  review_unavailable                   Copilot review is unavailable
  unsafe_local_branch_mismatch_requires_reconcile
                                       Next step needs PR-local work but local
                                       branch does not match PR head branch
  unsafe_local_head_mismatch_requires_reconcile
                                       Next step needs PR-local work but local
                                       HEAD does not match PR head commit
  unknown_state                        Unrecognized combined state
Async-start contract:
  This loop must run within a visible harness-managed async context when
  workflow.asyncStartMode is set to required (default). It fails closed unless
  DEVLOOPS_RUN_ID (or the PI_SUBAGENT_RUN_ID alias) is set, to prevent hidden detached-process fallback
  (nohup, disowned shell jobs, etc.). Snapshot/test input mode
  (both --copilot-input and --reviewer-input) is exempt. Any relaxed
  async-start posture is maintainer-controlled repository policy, not an
  agent-tunable runtime path.
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  gh/git/runtime failures:
    { "ok": false, "error": "..." }
  Async-start contract rejection:
    { "ok": false, "error": "...", "asyncStartContract": "rejected" }
Exit codes:
  0  Success
  1  Argument error, gh/git failure, or indeterminate state`.trim();
const parseError = buildParseError(USAGE);
export function parseOuterLoopCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    checkpointDir: undefined,
    copilotInputPath: undefined,
    reviewerInputPath: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      "checkpoint-dir": { type: "string" },
      "copilot-input": { type: "string" },
      "reviewer-input": { type: "string" },
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
    if (token.name === "checkpoint-dir") {
      options.checkpointDir = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "copilot-input") {
      options.copilotInputPath = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "reviewer-input") {
      options.reviewerInputPath = requireTokenValue(token, parseError);
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.help) {
    if (options.repo === undefined || options.pr === undefined) {
      throw parseError("outer-loop requires both --repo <owner/name> and --pr <number>");
    }
    try {
      parseRepoSlug(options.repo);
    } catch (error) {
      throw parseError(error instanceof Error ? error.message : String(error));
    }
  }
  return options;
}
async function checkGitStatus({ env = process.env, gitCommand = "git" } = {}) {
  const [statusResult, headRefResult, headShaResult] = await Promise.all([
    runChild(gitCommand, ["status", "--porcelain"], env),
    runChild(gitCommand, ["rev-parse", "--abbrev-ref", "HEAD"], env),
    runChild(gitCommand, ["rev-parse", "HEAD"], env),
  ]);
  const isDirty = statusResult.code === 0
    ? statusResult.stdout.trim().length > 0
    : false;
  const headRef = headRefResult.code === 0
    ? headRefResult.stdout.trim()
    : "";
  const isDetached = headRef === "HEAD";
  const branchName = !isDetached && headRef.length > 0 ? headRef : null;
  const headSha = headShaResult.code === 0
    ? headShaResult.stdout.trim() || null
    : null;
  return { isDirty, isDetached, branchName, headSha };
}
async function fetchPrHeadIdentity({ repo, pr }, { env = process.env, ghCommand = "gh" } = {}) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefName,headRefOid"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`Failed to read PR head identity: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  const branchName = typeof payload.headRefName === "string" && payload.headRefName.trim().length > 0
    ? payload.headRefName.trim()
    : null;
  const headSha = typeof payload.headRefOid === "string" && payload.headRefOid.trim().length > 0
    ? payload.headRefOid.trim()
    : null;
  return { branchName, headSha };
}
function requiresPrLocalIdentityGate(outerAction) {
  return outerAction === "reenter_copilot_loop" || outerAction === "reenter_reviewer_loop";
}
function evaluatePrLocalIdentity({
  localBranch,
  localHeadSha,
  prBranch,
  prHeadSha,
}) {
  const branchMatches = typeof prBranch === "string" && prBranch.length > 0
    ? localBranch === prBranch
    : null;
  const headMatches = typeof prHeadSha === "string" && prHeadSha.length > 0
    ? localHeadSha === prHeadSha
    : null;
  const mismatchReason = branchMatches === false
    ? "unsafe_local_branch_mismatch_requires_reconcile"
    : (headMatches === false ? "unsafe_local_head_mismatch_requires_reconcile" : null);
  return {
    localBranch,
    localHeadSha,
    prBranch,
    prHeadSha,
    branchMatches,
    headMatches,
    mismatchReason,
  };
}
function buildPrLocalIdentityStopRouting({
  repo,
  pr,
  branchIdentity,
}) {
  const targetIdentity = { repo, pr };
  const reason = branchIdentity.mismatchReason === "unsafe_local_branch_mismatch_requires_reconcile"
    ? `Local branch '${branchIdentity.localBranch ?? "(unknown)"}' does not match PR head branch '${branchIdentity.prBranch ?? "(unknown)"}'; reconcile local branch/worktree before PR-local follow-up.`
    : `Local HEAD '${branchIdentity.localHeadSha ?? "(unknown)"}' does not match PR head '${branchIdentity.prHeadSha ?? "(unknown)"}'; reconcile local branch/worktree before PR-local follow-up.`;
  return {
    routingOutcome: ROUTING_OUTCOME.STOP_NEEDS_HUMAN,
    outerAction: "stop",
    stopReason: branchIdentity.mismatchReason,
    handoffEnvelope: {
      targetIdentity,
      loopFamily: LOOP_FAMILY.NONE,
      entrypoint: ENTRYPOINT.NONE,
      reason,
      requiredArgs: { repo, pr },
      requiresLocalIsolation: false,
      confidence: SOURCE_MODE.LOCAL,
    },
  };
}
function enrichHandoffWithPrHeadIdentity(routing, { branchName, headSha }) {
  if (!routing || typeof routing !== "object" || !routing.handoffEnvelope || typeof routing.handoffEnvelope !== "object") {
    return routing;
  }
  const requiredArgs = {
    ...(routing.handoffEnvelope.requiredArgs && typeof routing.handoffEnvelope.requiredArgs === "object"
      ? routing.handoffEnvelope.requiredArgs
      : {}),
    ...(typeof branchName === "string" && branchName.length > 0 ? { headRefName: branchName } : {}),
    ...(typeof headSha === "string" && headSha.length > 0 ? { headRefOid: headSha } : {}),
  };
  return {
    ...routing,
    handoffEnvelope: {
      ...routing.handoffEnvelope,
      requiredArgs,
    },
  };
}
async function writeCheckpoint(checkpointDir, checkpoint) {
  await mkdir(checkpointDir, { recursive: true });
  const filePath = buildCheckpointFilePath(checkpointDir);
  await writeFile(filePath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}
function shouldCarryForwardWaitCycles(previousCheckpoint, { repo, pr, headSha, outerAction }) {
  return previousCheckpoint !== null
    && previousCheckpoint.outerAction === "continue_wait"
    && outerAction === "continue_wait"
    && previousCheckpoint.repo === repo
    && previousCheckpoint.pr === pr
    && typeof previousCheckpoint.headSha === "string"
    && previousCheckpoint.headSha.length > 0
    && typeof headSha === "string"
    && headSha.length > 0
    && previousCheckpoint.headSha === headSha;
}
export function decideOuterAction({ copilotState, reviewerState, gitStatus }) {
  const routing = evaluateConductorRouting({
    target: { repo: "routing/sentinel", pr: 1 },
    copilotState,
    reviewerState,
    requiresLocalIsolation: gitStatus.isDirty || gitStatus.isDetached,
  });
  return {
    outerAction: routing.outerAction,
    ...(routing.stopReason !== null ? { reason: routing.stopReason } : {}),
  };
}
export async function runOuterLoop(options, { env = process.env, ghCommand = "gh", gitCommand = "git" } = {}) {
  const { repo, pr, copilotInputPath, reviewerInputPath } = options;
  const normalizedRepo = repo.trim().toLowerCase();
  const checkpointDir = options.checkpointDir ?? buildDefaultCheckpointDir(normalizedRepo, pr);
  const isSnapshotMode = copilotInputPath !== undefined && reviewerInputPath !== undefined;
  let devLoopConfig = null;
  if (!isSnapshotMode) {
    const loaded = await loadDevLoopConfig();
    if (loaded.errors.length === 0) {
      devLoopConfig = loaded.config;
    }
  }
  const configuredAsyncStartMode = devLoopConfig === null
    ? "required"
    : resolveWorkflowConfig(devLoopConfig, "asyncStartMode");
  // Relaxed to "allowed" under the Claude harness (Pi async-start contract does not apply).
  const asyncStartMode = resolveEffectiveAsyncStartMode(configuredAsyncStartMode, env);
  const asyncStartValidation = validateAsyncStartContext({ env, isSnapshotMode, asyncStartMode });
  if (asyncStartValidation.status === ASYNC_START_STATUS.REJECTED) {
    return buildAsyncStartRejection(asyncStartValidation);
  }
  const { snapshot: copilotSnapshot, interpretation: copilotInterpretation } = await loadCopilotEvidence(
    { repo: normalizedRepo, pr, copilotInputPath },
    { env, ghCommand },
  );
  const { snapshot: reviewerSnapshot, interpretation: reviewerInterpretation } = await loadReviewerEvidence(
    { repo: normalizedRepo, pr, reviewerInputPath },
    { env, ghCommand },
  );
  const currentHeadSha = typeof reviewerSnapshot?.prHeadSha === "string" && reviewerSnapshot.prHeadSha.length > 0
    ? reviewerSnapshot.prHeadSha
    : null;
  const gitStatus = await checkGitStatus({ env, gitCommand });
  const sourceMode = (copilotInputPath !== undefined && reviewerInputPath !== undefined)
    ? "snapshot"
    : "local";
  let conductorRouting = evaluateConductorRouting({
    target: { repo: normalizedRepo, pr },
    copilotState: copilotInterpretation.state,
    reviewerState: reviewerInterpretation.state,
    sourceMode,
    requiresLocalIsolation: gitStatus.isDirty || gitStatus.isDetached,
  });
  let outerAction = conductorRouting.outerAction;
  let outerReason = conductorRouting.stopReason;
  let branchIdentity = null;
  if (outerReason === null && sourceMode === "local" && requiresPrLocalIdentityGate(outerAction)) {
    const prHeadIdentity = await fetchPrHeadIdentity({ repo: normalizedRepo, pr }, { env, ghCommand });
    conductorRouting = enrichHandoffWithPrHeadIdentity(conductorRouting, prHeadIdentity);
    branchIdentity = evaluatePrLocalIdentity({
      localBranch: gitStatus.branchName,
      localHeadSha: gitStatus.headSha,
      prBranch: prHeadIdentity.branchName,
      prHeadSha: prHeadIdentity.headSha ?? currentHeadSha,
    });
    const isolationManagedHandoff = conductorRouting.handoffEnvelope?.requiresLocalIsolation === true;
    if (branchIdentity.mismatchReason !== null && !isolationManagedHandoff) {
      outerAction = "stop";
      outerReason = branchIdentity.mismatchReason;
      conductorRouting = buildPrLocalIdentityStopRouting({
        repo: normalizedRepo,
        pr,
        branchIdentity,
      });
    }
  }
  const { checkpoint: prevCheckpoint } = await readExistingCheckpoint(normalizedRepo, pr, {
    checkpointDir: options.checkpointDir,
  });
  const prevWaitCycles = typeof prevCheckpoint?.waitCycles === "number" ? prevCheckpoint.waitCycles : 0;
  const waitCycles = shouldCarryForwardWaitCycles(prevCheckpoint, {
    repo: normalizedRepo,
    pr,
    headSha: currentHeadSha,
    outerAction,
  })
    ? prevWaitCycles + 1
    : (outerAction === "continue_wait" ? 1 : 0);
  const checkpoint = {
    pr,
    repo: normalizedRepo,
    outerAction,
    copilotState: copilotInterpretation.state,
    reviewerState: reviewerInterpretation.state,
    reviewerScope: reviewerSnapshot.reviewerScope,
    reviewerLogin: reviewerSnapshot.reviewerLogin,
    reason: outerReason ?? null,
    timestamp: new Date().toISOString(),
    waitCycles,
    headSha: currentHeadSha,
  };
  await writeCheckpoint(checkpointDir, checkpoint);
  let conductorModel = null;
  let autonomyStopAt = null;
  if (devLoopConfig !== null) {
    conductorModel = resolveConductorModel(devLoopConfig);
    autonomyStopAt = resolveAutonomyStopAt(devLoopConfig);
  }
  return {
    ok: true,
    outerAction,
    copilotState: copilotInterpretation.state,
    reviewerState: reviewerInterpretation.state,
    reviewerScope: {
      mode: reviewerSnapshot.reviewerScope,
      reviewerLogin: reviewerSnapshot.reviewerLogin,
    },
    ...(outerReason !== null && outerReason !== undefined ? { reason: outerReason } : {}),
    ...(branchIdentity !== null ? { branchIdentity } : {}),
    conductorRouting,
    checkpoint,
    conductorModel,
    autonomyStopAt,
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    ghCommand = "gh",
    gitCommand = "git",
  } = {},
) {
  const options = parseOuterLoopCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runOuterLoop(options, { env, ghCommand, gitCommand });
  if (result.ok === false) {
    stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
