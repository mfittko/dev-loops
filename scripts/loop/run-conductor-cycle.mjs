#!/usr/bin/env node
import { runChild, requireOptionValue } from "../_cli-primitives.mjs";
import {
  buildParseError,
  formatCliError,
  isDirectCliRun,
  parseJsonText,
} from "../_core-helpers.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { detectPrGateCoordinationState } from "./detect-pr-gate-coordination-state.mjs";
import { autoDetectSnapshot } from "./detect-copilot-loop-state.mjs";
import { PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";
import {
  SUBAGENT_ACTIONS as SHARED_SUBAGENT_ACTIONS,
  buildHandoffContractForConductorAction,
} from "./_handoff-contract.mjs";
const USAGE = `Usage: run-conductor-cycle.mjs --repo <owner/name>
Poll all open PRs, detect state, and output an ordered action queue.`.trim();
const OPEN_PR_LIST_LIMIT = 1000;
export const CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION = Object.freeze({
  [PR_CHECKPOINT_ACTION.ADDRESS_REVIEW_FEEDBACK]: "fix_threads",
  [PR_CHECKPOINT_ACTION.REPLY_RESOLVE_REVIEW_THREADS]: "fix_threads",
  [PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE]: "draft_gate",
  [PR_CHECKPOINT_ACTION.RECONCILE_DRAFT_GATE]: "draft_gate",
  [PR_CHECKPOINT_ACTION.RUN_PRE_APPROVAL_GATE]: "run_pre_approval",
  [PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW]: "request_review",
  [PR_CHECKPOINT_ACTION.REQUEST_COPILOT_REVIEW]: "request_review",
  [PR_CHECKPOINT_ACTION.REREQUEST_COPILOT_REVIEW]: "rerequest_review",
  [PR_CHECKPOINT_ACTION.WAIT_FOR_COPILOT_REVIEW]: "watch",
  [PR_CHECKPOINT_ACTION.WAIT_FOR_CI]: "watch",
  [PR_CHECKPOINT_ACTION.DECLARE_MERGE_READY]: "merge",
  [PR_CHECKPOINT_ACTION.AWAIT_FINAL_HUMAN_APPROVAL]: "await_approval",
  [PR_CHECKPOINT_ACTION.RESOLVE_MERGE_CONFLICTS]: "resolve_conflicts",
  [PR_CHECKPOINT_ACTION.REPORT_BLOCKED]: "blocked",
  [PR_CHECKPOINT_ACTION.REPORT_DONE]: "done",
});
export const ACTION_PRIORITY = Object.freeze({
  merge: 100,
  fix_threads: 90,
  run_pre_approval: 80,
  draft_gate: 70,
  request_review: 60,
  rerequest_review: 50,
  watch: 30,
  await_approval: 20,
  resolve_conflicts: 10,
  blocked: 10,
  done: 0,
  error: -1,
});
export const SUBAGENT_ACTIONS = SHARED_SUBAGENT_ACTIONS;
export const AUTONOMY_GATE_ACTION_MAP = Object.freeze({
  merge: ["merge"],
  "pre-approval": ["run_pre_approval"],
  "draft-pr": ["draft_gate", "request_review", "rerequest_review"],
  refinement: [],
});
export function actionRequiresApproval(action, autonomyStopAt = ["merge"]) {
  const stopSet = new Set(
    autonomyStopAt.flatMap((gate) => AUTONOMY_GATE_ACTION_MAP[gate] ?? [])
  );
  return stopSet.has(action);
}
const parseError = buildParseError(USAGE);
export function parseCliArgs(argv) {
  const args = [...argv];
  const options = {
    help: false,
    repo: undefined,
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
    throw parseError(`Unknown argument: ${token}`);
  }
  if (options.repo === undefined) {
    throw parseError("run-conductor-cycle requires --repo <owner/name>");
  }
  try {
    parseRepoSlug(options.repo);
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  return options;
}
export async function listOpenPrs({ repo }, { env, ghCommand }) {
  const result = await runChild(
    ghCommand,
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(OPEN_PR_LIST_LIMIT),
      "--json",
      "number,title,url,isDraft,headRefName,author",
    ],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh command failed: ${detail}`);
  }
  const payload = parseJsonText(result.stdout);
  if (!Array.isArray(payload)) {
    throw new Error("Invalid gh pr list payload: expected an array");
  }
  return payload
    .map((pr) => ({
      number: Number.isInteger(pr?.number) ? pr.number : null,
      title: typeof pr?.title === "string" ? pr.title : "",
      url: typeof pr?.url === "string" ? pr.url : null,
      isDraft: Boolean(pr?.isDraft),
      headRefName: typeof pr?.headRefName === "string" ? pr.headRefName : null,
      authorLogin: typeof pr?.author?.login === "string" ? pr.author.login : null,
    }))
    .filter((pr) => pr.number !== null)
    .sort((left, right) => left.number - right.number);
}
export async function detectPrState(
  pr,
  {
    repo,
    env,
    ghCommand,
    repoRoot,
    detectGateImpl = detectPrGateCoordinationState,
    detectSnapshotImpl = autoDetectSnapshot,
    autonomyStopAt = ["merge"],
  },
) {
  try {
    const gateState = await detectGateImpl(
      { repo, pr: pr.number },
      { env, ghCommand, repoRoot },
    );
    let snapshot = null;
    try {
      snapshot = await detectSnapshotImpl(
        { repo, pr: pr.number },
        { env, ghCommand },
      );
    } catch {
    }
    const action = CHECKPOINT_ACTION_TO_CONDUCTOR_ACTION[gateState.nextAction] ?? "error";
    const priority = ACTION_PRIORITY[action] ?? -1;
    const requiresApproval = actionRequiresApproval(action, autonomyStopAt);
    const handoffContract = buildHandoffContractForConductorAction({
      action,
      gateBoundary: gateState.gateBoundary,
      requiresApproval,
    });
    return {
      pr: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      headRefName: pr.headRefName,
      action,
      priority,
      state: gateState.lifecycleState,
      lifecycleState: gateState.lifecycleState,
      loopDisposition: gateState.loopDisposition,
      gateBoundary: gateState.gateBoundary,
      reason: gateState.reason ?? null,
      snapshot: snapshot ?? null,
      gateState: {
        allowedNextActions: gateState.allowedNextActions,
        forbiddenActions: gateState.forbiddenActions,
        draftGate: gateState.draftGate ?? null,
        preApprovalGate: gateState.preApprovalGate ?? null,
        mergeStateStatus: gateState.mergeStateStatus ?? null,
        conflictFiles: gateState.conflictFiles ?? [],
        currentHeadSha: gateState.currentHeadSha ?? null,
        ciStatus: snapshot?.ciStatus ?? null,
      },
      requiresSubagent: SUBAGENT_ACTIONS.has(action),
      requiresApproval,
      handoffContract,
    };
  } catch (error) {
    return {
      pr: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      headRefName: pr.headRefName,
      action: "error",
      priority: ACTION_PRIORITY.error,
      state: null,
      lifecycleState: null,
      loopDisposition: null,
      gateBoundary: null,
      reason: null,
      snapshot: null,
      gateState: null,
      requiresSubagent: false,
      requiresApproval: false,
      handoffContract: buildHandoffContractForConductorAction({ action: "error" }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export function buildActionQueue(detectionResults) {
  return [...detectionResults].sort((left, right) => {
    const priorityDiff = right.priority - left.priority;
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.pr - right.pr;
  });
}
export function buildSummary(actions) {
  const summary = {
    needsSubagent: 0,
    readyToMerge: 0,
    waiting: 0,
    blocked: 0,
    done: 0,
    errors: 0,
  };
  for (const action of actions) {
    switch (action.action) {
      case "error":
        summary.errors += 1;
        break;
      case "merge":
        summary.readyToMerge += 1;
        break;
      case "watch":
        summary.waiting += 1;
        break;
      case "done":
        summary.done += 1;
        break;
      case "blocked":
      case "resolve_conflicts":
      case "await_approval":
        summary.blocked += 1;
        break;
      default:
        break;
    }
    if (action.requiresSubagent) {
      summary.needsSubagent += 1;
    }
  }
  return summary;
}
export async function runConductorCycle(
  { repo, autonomyStopAt, gateConfig },
  {
    env = process.env,
    ghCommand = "gh",
    repoRoot = process.cwd(),
    listPrsImpl = listOpenPrs,
    detectPrStateImpl = detectPrState,
  } = {},
) {
  const prs = await listPrsImpl({ repo }, { env, ghCommand });
  const stopAt = autonomyStopAt ?? ["merge"];
  const detectionResults = [];
  for (const pr of prs) {
    const result = await detectPrStateImpl(pr, {
      repo,
      env,
      ghCommand,
      repoRoot,
      autonomyStopAt: stopAt,
    });
    detectionResults.push(result);
  }
  const actions = buildActionQueue(detectionResults);
  const summary = buildSummary(actions);
  return {
    ok: true,
    repo,
    checkedAt: new Date().toISOString(),
    prCount: prs.length,
    actions,
    summary,
    ...(gateConfig ? { gateConfig } : {}),
    autonomyStopAt: stopAt,
  };
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    ghCommand = "gh",
    cwd = process.cwd(),
  } = {},
) {
  const options = parseCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  const result = await runConductorCycle(options, {
    env,
    ghCommand,
    repoRoot: cwd,
  });
  stdout.write(`${JSON.stringify(result)}\n`);
}
if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
