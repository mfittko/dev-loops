#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parsePrNumber, requireTokenValue, runChild as defaultRunChild } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION } from "@dev-loops/core/loop/public-dev-loop-routing";
import { watchCopilotReview } from "../github/probe-copilot-review.mjs";
import { watchCiStatus } from "../github/probe-ci-status.mjs";
import { runHandoff } from "./copilot-pr-handoff.mjs";
import { STATE } from "@dev-loops/core/loop/copilot-loop-state";
import { DEFAULT_POLL_INTERVAL_MS } from "@dev-loops/core/loop/policy-constants";
import { detectCopilotSessionActivity } from "./detect-copilot-session-activity.mjs";
import { ensureAsyncRunnerOwnership, recordWatchClaim as defaultRecordWatchClaim } from "./_pr-runner-coordination.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { resolveStaleRunnerMaxAgeMs } from "./_stale-runner-detection.mjs";
import { isClaudeHarness, resolveRunId } from "@dev-loops/core/loop/run-context";
import { assertNoOverlappingObserver, resolveWatchOwnership } from "@dev-loops/core/loop/watcher-exclusivity";
import { buildExecutionUnitRecord } from "@dev-loops/core/loop/execution-record";
import { parseArgs } from "node:util";
import {
  EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY,
  enforceExternalHealthyWaitTimeout,
} from "@dev-loops/core/loop/timeout-policy";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
const REMOVED_FLAGS = new Set([
  "--force-rerequest-review",
  "--probe-only",
]);
const USAGE = `Usage: run-watch-cycle.mjs --repo <owner/name> --pr <number>
Run one deterministic Copilot wait-cycle boundary.
Required:
  --repo <owner/name>       Repository slug (e.g. owner/repo)
  --pr <number>             Pull request number
Output (stdout, JSON):
  { "ok": true, "handoffAction": "watch"|"fix"|"stop", "state": "...",
    "allowedTransitions": [...], "nextAction": "...", "snapshot": {...},
    "requestWatchContract"?: { ... },
    "reviewRequestStatus"?: "...", "watchArgs"?: { ... },
    "watchTimeoutPolicy"?: { "classification": "...", "minimumTimeoutMs": N, "defaultTimeoutMs": N },
    "contractTrace"?: { ... },
    "sessionActivity"?: { ... },
    "watchStatus"?: "changed"|"timeout"|"idle", "watch"?: { ... },
    "loopDisposition": "pending"|"unresolved_feedback"|"clean_converged"|"blocked"|"action_required"|"done",
    "cycleDisposition": "pending"|"needs_followup"|"terminal",
    "roundCapCleanEligible": true|false,
    "terminal": true|false }
Cycle disposition:
  pending         Watch state persists; keep waiting or re-enter later
  needs_followup  Fresh review activity or fix-state follow-up needs action
  terminal        No automatic next step remains
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  runtime failures:
    { "ok": false, "error": "..." }
Concise mode:
  --concise, --summary      Human-readable summary: loop state, copilot rounds,
                            unresolved/actionable thread counts, round-cap-clean
                            eligibility, CI status, next action, AND the current
                            round's new Copilot comment bodies.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or runtime failure
  2  Invalid --jq filter`.trim();
const parseError = buildParseError(USAGE);
function rejectRemovedFlag(token) {
  throw parseError(
    `${token} has been removed. Copilot re-requests and probe-only mode are managed internally. Omit the flag.`,
  );
}
async function fetchPrHeadBranch({ repo, pr }, { env, ghCommand, runChild = defaultRunChild }) {
  const result = await runChild(
    ghCommand,
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefName"],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Invalid JSON from gh: ${result.stdout.trim() || "<empty>"}`);
  }
  if (typeof payload.headRefName !== "string" || payload.headRefName.trim().length === 0) {
    throw new Error("Missing required PR facts: headRefName");
  }
  return payload.headRefName.trim();
}
export async function watchWorkflowRun(
  { repo, runId, timeoutMs = null },
  {
    env,
    ghCommand,
    spawnImpl = spawn,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  },
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      ghCommand,
      ["run", "watch", String(runId), "--repo", repo],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let timeoutId = null;
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (Number.isInteger(timeoutMs) && timeoutMs >= 0) {
      timeoutId = setTimeoutImpl(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      if (timeoutId !== null) {
        clearTimeoutImpl(timeoutId);
      }
      if (timedOut) {
        resolve({ status: "timed_out" });
        return;
      }
      if (spawnError !== null) {
        reject(spawnError);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new Error(`gh command failed: ${detail}`));
        return;
      }
      resolve({ status: "completed" });
    });
  });
}
function determineWatchTimeout(defaultTimeoutMs) {
  return enforceExternalHealthyWaitTimeout({
    timeoutMs: defaultTimeoutMs,
    contextLabel: "Copilot review wait",
  });
}
function buildWatchCycleContractTrace({
  handoff,
  watchArgs = null,
  watchTimeoutPolicy = null,
  watchStatus,
  cycleDisposition,
  sessionActivity = null,
  workflowRunWatch = null,
  ciWatchArgs = null,
  ciWatchStatus = null,
}) {
  // The CI-watch branch (waiting_for_ci) routes through probe-ci-status.mjs even
  // though handoff.action !== "watch". It is an observational wait, so it mirrors
  // the Copilot watch classification: a quiet timeout is a HEALTHY_WAIT, while
  // success/failure/changed route a follow-up. Without this the boundary-action
  // path below would misclassify a CI timeout as routed_followup.
  const isCiWatch = ciWatchArgs !== null;
  const isWatchBoundary = handoff.action === "watch" || isCiWatch;
  const observedStatus = isCiWatch ? ciWatchStatus : watchStatus;
  const boundaryClassification = isWatchBoundary
    ? (observedStatus === "timeout" || observedStatus === "idle"
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT
      : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP)
    : handoff.loopDisposition === "blocked"
      ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.BLOCKED
      : handoff.terminal
        ? DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.TERMINAL
        : DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.ROUTED_FOLLOWUP;
  const healthyWait = boundaryClassification === DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION.HEALTHY_WAIT;
  const helper = handoff.action === "watch"
    ? "scripts/github/probe-copilot-review.mjs"
    : isCiWatch
      ? "scripts/github/probe-ci-status.mjs"
      : null;
  const effectiveArgs = isCiWatch ? ciWatchArgs : watchArgs;
  return {
    handoff: {
      action: handoff.action,
      state: handoff.state,
      loopDisposition: handoff.loopDisposition,
      terminal: Boolean(handoff.terminal),
    },
    waitStrategy: {
      helper,
      mode: isWatchBoundary ? "persistent_watch" : "not_applicable",
      effectiveTimeoutMs: effectiveArgs?.timeoutMs ?? null,
      effectivePollIntervalMs: effectiveArgs?.pollIntervalMs ?? null,
      timeoutPolicyClassification: watchTimeoutPolicy?.classification ?? null,
    },
    orchestration: {
      emittedWatchArgs: handoff.watchArgs ?? null,
      effectiveWatchArgs: effectiveArgs,
      ciWatchArgs,
      sessionActivity,
      workflowRunWatch,
    },
    stateRefresh: isWatchBoundary
      ? {
          boundaryKind: "post_watch_or_probe",
          observedStatus,
          refreshRequired: true,
          refreshReason: healthyWait
            ? "Healthy watch boundaries are observational only; refresh authoritative state before treating timeout/idle as stop or completion."
            : "Watch boundaries with fresh activity require an authoritative state refresh before routing the follow-up path.",
        }
      : null,
    stopReason: {
      classification: boundaryClassification,
      terminal: Boolean(handoff.terminal),
      cycleDisposition,
      reason: isWatchBoundary
        ? (healthyWait
          ? "Quiet watcher boundaries remain healthy waits and must not be treated as terminal completion by themselves."
          : "Fresh watcher activity requires follow-up instead of staying in a healthy wait boundary.")
        : handoff.nextAction,
    },
  };
}
// A blocking watch can run for the full external-healthy-wait timeout (30 min for
// Copilot/CI), which equals the runner-coordination stale window. Without a
// heartbeat the claim ages to stale across a single watch and the next step is
// refused. Refresh the lease on entry, on a periodic interval below
// the stale window, and once more on return so the resuming runner has a fresh claim.
async function runWatchHoldingLease(watchFactory, { repo, pr, env, cwd, ensureOwnershipImpl }) {
  const heartbeat = async () => {
    try {
      // claimIfMissing:true self-heals a missing record but never stomps a live
      // competitor (assertRunnerOwnership refuses to write on OWNERSHIP_LOST), so
      // fail-closed competitor semantics are preserved.
      await ensureOwnershipImpl({ repo, pr, env, cwd, claimIfMissing: true, requireExisting: false });
    } catch {
      // best-effort: a heartbeat failure must never affect the watch
    }
  };
  const intervalMs = Math.max(1, Math.floor(resolveStaleRunnerMaxAgeMs({}, env) / 2));
  await heartbeat();
  const timer = setInterval(() => { void heartbeat(); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await watchFactory();
  } finally {
    clearInterval(timer);
    await heartbeat();
  }
}
export function parseWatchCycleCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    pr: undefined,
    concise: false,
    jq: undefined,
    silent: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      concise: { type: "boolean" },
      summary: { type: "boolean" },
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
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (REMOVED_FLAGS.has(token.rawName)) {
      rejectRemovedFlag(token.rawName);
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "concise" || token.name === "summary") {
      options.concise = true;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.repo === undefined || options.pr === undefined) {
    throw parseError("run-watch-cycle requires both --repo <owner/name> and --pr <number>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
// Live watcher-exclusivity gate: BEFORE a watcher starts, prove
// THIS run is the sole owner of the (target, head, wait-kind) boundary. With no
// async run id the harness is single-runner by construction, so the gate
// permits without touching the lease (`engaged:false`) — this keeps every
// non-async watch path byte-identical to before. With a run id present, record
// this run's watch claim (fails closed unless this run owns the PR lease) and
// resolve the ownership verdict; a claim failure means another run owns the
// boundary, so starting a watcher here is a prohibited second-observer op
// (`assertNoOverlappingObserver`). A blocked verdict never authorizes a second
// observer — the coordinator waits on the owner's evidence instead.
async function gateWatcherExclusivity(
  { repo, pr, head, waitKind, env, cwd },
  { recordWatchClaimImpl = defaultRecordWatchClaim, nowMs = Date.now(), staleAfterMs } = {},
) {
  const runId = resolveRunId(env);
  if (runId === null) {
    return { engaged: false, ok: true, reason: "no_lease_single_runner" };
  }
  const target = `${repo}#${pr}`;
  if (typeof head !== "string" || head.trim().length === 0) {
    return { engaged: true, ok: false, reason: "missing_head", target, waitKind };
  }
  const claim = await recordWatchClaimImpl({ repo, pr, runId, head: head.trim(), waitKind, cwd });
  if (!claim.ok) {
    // Not the boundary owner — a watcher here would be a second observer.
    let prohibition = null;
    try {
      assertNoOverlappingObserver({ kind: "start_watcher" });
    } catch (error) {
      prohibition = error instanceof Error ? error.message : String(error);
    }
    return { engaged: true, ok: false, reason: claim.error ?? "watch_claim_failed", detail: claim.message, prohibition, target, waitKind };
  }
  const owner = { runId, target, head: claim.watch.head, waitKind: claim.watch.waitKind, updatedAt: claim.watch.updatedAt };
  const verdict = resolveWatchOwnership({
    boundary: { target, head: claim.watch.head, waitKind },
    evidence: { owner, transition: null },
    now: nowMs,
    staleAfterMs,
  });
  return { engaged: true, ok: verdict.ok, reason: verdict.ok ? verdict.status : verdict.reason, verdict, owner, target, waitKind };
}
// Map an observed CI watcher result to the resolver's transition status, or
// null when the observation does not correspond to a resolver transition. A
// settled (terminal success/failure) wait maps to `completed`; a fresh push
// (status "changed") stays "changed"; quiet outcomes are non-advancing. Only
// the `ci` boundary feeds a post-watch transition verdict (see
// resolveWatchTransitionVerdict's call sites): `copilot_review` watch results
// carry no headSha, so a current-head-validated post-watch transition there
// would fall back to the pre-watch owned head and fabricate a validated
// advance; `workflow_run` is gated pre-watch but its watch result carries no
// transition. Neither is handled here.
function watchResultToTransitionStatus(watchResult) {
  // A watcher result is only a valid observation when ok === true. A malformed
  // result (e.g. { ok:false, status:"success", settled:true }) must never map
  // to a transition (fail-closed: non-advancing, not a silent success).
  if (watchResult?.ok !== true) return null;
  const status = watchResult?.status;
  if (watchResult?.settled === true) {
    // settled must be corroborated by a terminal status (success/failure);
    // a malformed { settled:true, status:"pending" } observation must NOT
    // authorize a completed transition (fail-closed: no transition, not a
    // silent idle fallback).
    return status === "success" || status === "failure" ? "completed" : null;
  }
  if (status === "changed") return "changed";
  if (status === "timeout") return "timeout";
  if (status === "pending" || status === "stuck") return "idle";
  return null;
}
// After a watcher returns, resolve the phase-advance verdict from the
// watcher-reported transition, carrying the watcher-reported head through. When
// that head differs from the owned boundary head (a fresh push during the wait)
// the resolver blocks — current-head validation, re-baseline instead of
// advancing. Returns null when the gate did not engage (single-runner) or the
// observation has no resolver transition.
function resolveWatchTransitionVerdict({ gate, waitKind, watchResult, nowMs, staleAfterMs }) {
  if (!gate?.engaged || !gate.ok || !gate.owner) return null;
  const transitionStatus = watchResultToTransitionStatus(watchResult);
  if (transitionStatus === null) return null;
  const head = typeof watchResult?.headSha === "string" && watchResult.headSha.trim().length > 0
    ? watchResult.headSha.trim()
    : gate.owner.head;
  const verdict = resolveWatchOwnership({
    boundary: { target: gate.target, head: gate.owner.head, waitKind },
    evidence: {
      owner: gate.owner,
      transition: { target: gate.target, head, waitKind, status: transitionStatus },
    },
    now: nowMs,
    staleAfterMs,
  });
  return {
    transitionStatus,
    head,
    advancePhaseAuthorized: verdict.advancePhaseAuthorized === true,
    verdict,
  };
}
// A blocking watch can run long enough that this run's lease is taken over or
// lost mid-wait; the pre-watch `gate` snapshot alone would then authorize a
// phase advance on stale ownership evidence. Re-validate ownership for the
// same (waitKind, head) boundary via the existing gateExclusivity helper
// (which calls recordWatchClaimImpl, fail-closed if this run no longer owns
// the boundary) before resolving the transition verdict, so a takeover/lease
// loss during the wait always blocks the advance.
async function resolvePostWatchTransition({ waitKind, watchResult, gate, gateExclusivityImpl, nowMs, staleAfterMs }) {
  if (!gate?.engaged || !gate.ok || !gate.owner) return null;
  const transitionStatus = watchResultToTransitionStatus(watchResult);
  if (transitionStatus === null) return null;
  const postGate = await gateExclusivityImpl(waitKind, gate.owner.head);
  if (!postGate.ok) {
    return {
      transitionStatus,
      head: gate.owner.head,
      advancePhaseAuthorized: false,
      verdict: { ok: false, reason: postGate.reason ?? "post_watch_ownership_lost" },
    };
  }
  return resolveWatchTransitionVerdict({ gate: postGate, waitKind, watchResult, nowMs, staleAfterMs });
}
// A blocked exclusivity gate never starts a watcher and never advances the
// phase. The coordinator stays in a healthy wait on the existing owner's
// evidence (the existing timeout policy governs escalation), so the cycle stays
// pending/non-terminal with a marker explaining why no second watcher started.
// The waiting_for_ci early-blocked path reaches this before any handoff
// watchTimeoutPolicy is populated (that path's handoff action is "stop"), so
// this always ensures the coordinator's healthy-wait/escalation timeout
// policy is present on a blocked result rather than silently absent.
function attachWatcherExclusivityBlock(result, gate) {
  if (result.watchTimeoutPolicy === undefined) {
    result.watchTimeoutPolicy = EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY;
  }
  result.watcherExclusivity = {
    blocked: true,
    reason: gate.reason,
    target: gate.target,
    waitKind: gate.waitKind,
    ...(gate.detail ? { detail: gate.detail } : {}),
    ...(gate.prohibition ? { prohibition: gate.prohibition } : {}),
  };
  result.cycleDisposition = "pending";
  result.terminal = false;
  return result;
}
// One compact execution-unit telemetry record built
// from the cycle's OWN real owner/verdict/disposition data — never a
// hand-built bag. A watch cycle performs no model turn, so every
// provider-token dimension is honestly unavailable, never zero/estimated;
// `turns: 0` is still a genuine measured local zero.
export function buildWatchCycleExecutionRecord({
  owner,
  cycleDisposition,
  headSha,
  harness = "pi",
  localToolTimeMs,
  toolCalls,
}) {
  const noModelTurnReason = "watch cycle performs no model turn; no provider tokens consumed";
  return buildExecutionUnitRecord({
    harness,
    role: "watch_cycle",
    identity: { headSha, unitId: owner?.runId ?? "single-runner" },
    promptBytes: 0,
    contextBytes: 0,
    turns: 0,
    toolCalls,
    providerTokens: {
      input: null,
      output: null,
      cacheRead: null,
      reasons: { input: noModelTurnReason, output: noModelTurnReason, cacheRead: noModelTurnReason },
    },
    localToolTimeMs,
    childWallTimeMs: null,
    waitOwner: owner?.runId ?? null,
    outcome: cycleDisposition,
  });
}
export async function runWatchCycle(
  options,
  {
    env = process.env,
    ghCommand = "gh",
    runChild = defaultRunChild,
    runHandoffImpl = runHandoff,
    watchCopilotReviewImpl = watchCopilotReview,
    watchCiStatusImpl = watchCiStatus,
    detectCopilotSessionActivityImpl = detectCopilotSessionActivity,
    fetchPrHeadBranchImpl = fetchPrHeadBranch,
    watchWorkflowRunImpl = watchWorkflowRun,
    ensureOwnershipImpl = ensureAsyncRunnerOwnership,
    recordWatchClaimImpl = defaultRecordWatchClaim,
    detectSessionActivity = false,
  } = {},
) {
  const leaseCwd = resolveRepoRoot(process.cwd());
  const nowMs = Date.now();
  const exclusivityStaleAfterMs = resolveStaleRunnerMaxAgeMs({}, env);
  const gateExclusivity = (waitKind, head) => gateWatcherExclusivity(
    { repo: options.repo, pr: options.pr, head, waitKind, env, cwd: leaseCwd },
    { recordWatchClaimImpl, nowMs, staleAfterMs: exclusivityStaleAfterMs },
  );
  // Counts the actual gh/network calls this cycle issues through the shared
  // runChild seam — buildWatchCycleExecutionRecord's toolCalls must report
  // the real count, never a hardcoded telemetry zero.
  let toolCallCount = 0;
  const countedRunChild = (...args) => {
    toolCallCount += 1;
    return runChild(...args);
  };
  const handoff = await runHandoffImpl(options, { env, ghCommand, runChild: countedRunChild });
  const headSha = typeof handoff.snapshot?.currentHeadSha === "string" && handoff.snapshot.currentHeadSha.trim().length > 0
    ? handoff.snapshot.currentHeadSha.trim()
    : null;
  // Sourced from the existing run-context harness-detection seam, not a new
  // per-harness branch in this loop.
  const harness = isClaudeHarness(env) ? "claude" : "pi";
  const result = {
    ok: true,
    handoffAction: handoff.action,
    state: handoff.state,
    allowedTransitions: handoff.allowedTransitions,
    nextAction: handoff.nextAction,
    snapshot: handoff.snapshot,
    roundCapCleanEligible: handoff.roundCapCleanEligible ?? false,
    loopDisposition: handoff.loopDisposition,
    cycleDisposition: handoff.action === "stop" ? "terminal" : "needs_followup",
    terminal: Boolean(handoff.terminal),
  };
  if (handoff.requestWatchContract !== undefined) {
    result.requestWatchContract = handoff.requestWatchContract;
  }
  if (handoff.reviewRequestStatus !== undefined) {
    result.reviewRequestStatus = handoff.reviewRequestStatus;
  }
  if (handoff.watchArgs !== undefined) {
    result.watchArgs = handoff.watchArgs;
  }
  if (handoff.watchTimeoutPolicy !== undefined) {
    result.watchTimeoutPolicy = handoff.watchTimeoutPolicy;
  }
  // Best-effort telemetry attach: a malformed/absent head must never break
  // the cycle itself, only the (optional) record.
  const attachExecutionRecord = (owner) => {
    if (!headSha) return;
    try {
      result.executionRecord = buildWatchCycleExecutionRecord({
        owner: owner ?? null,
        cycleDisposition: result.cycleDisposition,
        headSha,
        harness,
        toolCalls: toolCallCount,
        // Cycle's own wall span (entry to emit) — the cycle does real work
        // (handoff/watch probes) even though it runs no model turn, so this
        // must be measured, never a hardcoded zero.
        localToolTimeMs: Date.now() - nowMs,
      });
    } catch {
      // ponytail: telemetry is best-effort, never load-bearing for the cycle.
    }
  };
  // Provider-agnostic CI wait: a waiting_for_ci boundary would otherwise
  // dead-end at action:"stop". Route it to the helper-owned CI watcher
  // (CircleCI / GH Actions / external commit-status), not gh run watch.
  if (handoff.action !== "watch" && handoff.state === STATE.WAITING_FOR_CI) {
    // Mirror determineWatchTimeout but with a CI-specific context label so
    // timeout diagnostics read "CI wait" instead of "Copilot review wait".
    const ciTimeoutMs = enforceExternalHealthyWaitTimeout({
      timeoutMs: EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY.defaultTimeoutMs,
      contextLabel: "CI wait",
    });
    const ciWatchArgs = {
      repo: options.repo,
      pr: options.pr,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      timeoutMs: ciTimeoutMs,
    };
    const ciGate = await gateExclusivity("ci", headSha);
    if (ciGate.engaged && !ciGate.ok) {
      attachWatcherExclusivityBlock(result, ciGate);
      attachExecutionRecord(ciGate.owner ?? null);
      return result;
    }
    const ciWatch = await watchCiStatusImpl(ciWatchArgs, { env, ghCommand, runChild: countedRunChild });
    result.ciWatchArgs = ciWatchArgs;
    result.ciWatch = ciWatch;
    result.watchStatus = ciWatch.status;
    const ciTransition = await resolvePostWatchTransition({
      gate: ciGate,
      waitKind: "ci",
      watchResult: ciWatch,
      gateExclusivityImpl: gateExclusivity,
      nowMs,
      staleAfterMs: exclusivityStaleAfterMs,
    });
    if (ciTransition !== null) {
      result.watcherExclusivity = { blocked: ciTransition.verdict?.ok === false, waitKind: "ci", target: ciGate.target, ...ciTransition };
    }
    // success/failure/changed all need authoritative re-detection (follow-up);
    // a quiet timeout stays a healthy pending wait.
    result.cycleDisposition = ciWatch.status === "timeout" ? "pending" : "needs_followup";
    result.terminal = false;
    result.contractTrace = buildWatchCycleContractTrace({
      handoff,
      watchTimeoutPolicy: result.watchTimeoutPolicy ?? null,
      cycleDisposition: result.cycleDisposition,
      ciWatchArgs,
      ciWatchStatus: ciWatch.status,
    });
    attachExecutionRecord(ciGate.owner ?? null);
    return result;
  }
  if (handoff.action !== "watch") {
    result.contractTrace = buildWatchCycleContractTrace({
      handoff,
      watchArgs: result.watchArgs ?? null,
      watchTimeoutPolicy: result.watchTimeoutPolicy ?? null,
      watchStatus: result.watchStatus,
      cycleDisposition: result.cycleDisposition,
    });
    attachExecutionRecord(null);
    return result;
  }
  if (result.watchTimeoutPolicy === undefined) {
    result.watchTimeoutPolicy = EXTERNAL_HEALTHY_WAIT_TIMEOUT_POLICY;
  }
  const persistentWatchTimeoutMs = determineWatchTimeout(
    handoff.watchArgs.timeoutMs,
  );
  let workflowRunWatch = null;
  if (detectSessionActivity) {
    const headBranch = await fetchPrHeadBranchImpl({ repo: options.repo, pr: options.pr }, { env, ghCommand, runChild: countedRunChild });
    const session = await detectCopilotSessionActivityImpl(
      {
        repo: options.repo,
        branch: headBranch,
      },
      { env, ghCommand, runChild: countedRunChild },
    );
    result.sessionActivity = session;
    if (
      session.activity === "active"
      && Number.isInteger(session.runId)
    ) {
      const wfGate = await gateExclusivity("workflow_run", headSha);
      if (wfGate.engaged && !wfGate.ok) {
        attachWatcherExclusivityBlock(result, wfGate);
        attachExecutionRecord(wfGate.owner ?? null);
        return result;
      }
      const workflowWatchResult = await runWatchHoldingLease(
        () => watchWorkflowRunImpl(
          {
            repo: options.repo,
            runId: session.runId,
            timeoutMs: persistentWatchTimeoutMs,
          },
          { env, ghCommand },
        ),
        { repo: options.repo, pr: options.pr, env, cwd: leaseCwd, ensureOwnershipImpl },
      );
      workflowRunWatch = {
        attempted: true,
        timeoutMs: persistentWatchTimeoutMs,
        runId: session.runId,
        status: workflowWatchResult?.status ?? "unknown",
      };
    }
  }
  const copilotGate = await gateExclusivity("copilot_review", headSha);
  if (copilotGate.engaged && !copilotGate.ok) {
    attachWatcherExclusivityBlock(result, copilotGate);
    attachExecutionRecord(copilotGate.owner ?? null);
    return result;
  }
  const watchOptions = {
    ...handoff.watchArgs,
    timeoutMs: persistentWatchTimeoutMs,
  };
  const watch = await watchCopilotReviewImpl(watchOptions, { env, ghCommand, runChild: countedRunChild });
  result.watchArgs = watchOptions;
  result.watchStatus = watch.status;
  result.watch = watch;
  // No post-watch transition marker for copilot_review: watchCopilotReview
  // reports no headSha, so a current-head-validated transition here would
  // fall back to the pre-watch owned head and fabricate a validated advance
  // (Copilot review finding). The pre-watch exclusivity gate above is the
  // only enforcement boundary on this path; AC 3 (current-head-validated
  // post-watch transition) is CI-only.
  result.cycleDisposition = watch.status === "changed" ? "needs_followup" : "pending";
  result.terminal = false;
  result.contractTrace = buildWatchCycleContractTrace({
    handoff,
    watchArgs: watchOptions,
    watchTimeoutPolicy: result.watchTimeoutPolicy,
    watchStatus: watch.status,
    cycleDisposition: result.cycleDisposition,
    sessionActivity: result.sessionActivity ?? null,
    workflowRunWatch: detectSessionActivity
      ? (workflowRunWatch ?? {
          attempted: false,
          timeoutMs: persistentWatchTimeoutMs,
          runId: result.sessionActivity?.runId ?? null,
          status: null,
        })
      : null,
  });
  attachExecutionRecord(copilotGate.owner ?? null);
  return result;
}
// Human-readable concise summary covering loop state, Copilot round count,
// unresolved/actionable thread counts, round-cap-clean eligibility, CI status,
// next action, AND the current round's new Copilot comment bodies (from the
// embedded watch probe result). This is the field set the loop needs to read
// without parsing the full JSON blob.
export function formatWatchCycleConcise(result) {
  const snapshot = result.snapshot ?? {};
  const lines = [
    `Watch cycle: PR #${snapshot.prNumber ?? "?"}`,
    `  loop state:          ${result.state}`,
    `  handoff action:      ${result.handoffAction}`,
    `  copilot rounds:      ${snapshot.copilotReviewRoundCount ?? 0}`,
    `  unresolved threads:  ${snapshot.unresolvedThreadCount ?? 0}`,
    `  actionable threads:  ${snapshot.actionableThreadCount ?? 0}`,
    `  round-cap clean:     ${result.roundCapCleanEligible ? "yes" : "no"}`,
    `  CI status:           ${snapshot.ciStatus ?? "none"}`,
    `  loop disposition:    ${result.loopDisposition}`,
    `  cycle disposition:   ${result.cycleDisposition}`,
    `  watch status:        ${result.watchStatus ?? "(not watched)"}`,
    `  terminal:            ${result.terminal ? "yes" : "no"}`,
    `  next action:         ${result.nextAction}`,
  ];
  const watch = result.watch ?? {};
  const bodies = [
    ...(watch.newReviews ?? []).map((r) => ({ kind: "review", body: r.body })),
    ...(watch.newComments ?? []).map((c) => ({ kind: "threadComment", body: c.body })),
    ...(watch.newIssueComments ?? []).map((c) => ({ kind: "issueComment", body: c.body })),
  ].filter((entry) => typeof entry.body === "string" && entry.body.trim().length > 0);
  if (bodies.length > 0) {
    lines.push("  new Copilot comment bodies this round:");
    for (const entry of bodies) {
      const indented = entry.body.trim().split("\n").map((l) => `      ${l}`).join("\n");
      lines.push(`    [${entry.kind}]`);
      lines.push(indented);
    }
  } else {
    lines.push("  new Copilot comment bodies this round: (none)");
  }
  return lines.join("\n");
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
    runChild = defaultRunChild,
    runHandoffImpl = runHandoff,
    watchCopilotReviewImpl = watchCopilotReview,
  } = {},
) {
  const options = parseWatchCycleCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runWatchCycle(options, {
    env,
    ghCommand,
    runChild,
    runHandoffImpl,
    watchCopilotReviewImpl,
    detectSessionActivity: true,
  });
  if (options.concise && options.jq === undefined && !options.silent) {
    stdout.write(`${formatWatchCycleConcise(result)}\n`);
    return result.ok === false ? 1 : 0;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout });
}
if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  }).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
