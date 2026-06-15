import { PR_CHECKPOINT } from "@dev-loops/core/loop/pr-gate-coordination";
const HANDOFF_OWNERSHIP = Object.freeze({
  SUBAGENT: "subagent",
  PARENT: "parent",
  HUMAN: "human",
  TERMINAL: "terminal",
});
const HANDOFF_STOP_BOUNDARY = Object.freeze({
  SUBAGENT_EXIT: "subagent_exit",
  WATCH_BOUNDARY: "watch_boundary",
  APPROVAL_BOUNDARY: "approval_boundary",
  MERGE_BOUNDARY: "merge_boundary",
  CONFLICT_BOUNDARY: "conflict_boundary",
  TERMINAL: "terminal_boundary",
});
const HANDOFF_RESUME_POLICY = Object.freeze({
  RESUME_AFTER_SUBAGENT_EXIT: "resume_after_subagent_exit",
  RESUME_AFTER_STATE_REFRESH: "resume_after_state_refresh",
  RESUME_AFTER_HUMAN_APPROVAL: "resume_after_human_approval",
  RESUME_AFTER_MERGE_AUTHORIZATION: "resume_after_merge_authorization",
  MANUAL_ATTENTION: "manual_attention",
  NONE: "none",
});
const GATE_BOUNDARY_STOP_VALUES = new Set(Object.values(PR_CHECKPOINT));
const SUBAGENT_ACTIONS = new Set([
  "fix_threads",
  "draft_gate",
  "request_review",
  "rerequest_review",
  "run_pre_approval",
]);
function normalizeContractValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}
function buildContract({ ownership, stopBoundary, resumePolicy }) {
  return {
    ownership,
    stopBoundary,
    resumePolicy,
  };
}
export function buildHandoffContractForConductorAction({ action, gateBoundary, requiresApproval = false } = {}) {
  const normalizedAction = normalizeContractValue(action);
  if (SUBAGENT_ACTIONS.has(normalizedAction)) {
    if (requiresApproval) {
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.APPROVAL_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_HUMAN_APPROVAL,
      });
    }
    return buildContract({
      ownership: HANDOFF_OWNERSHIP.SUBAGENT,
      stopBoundary: HANDOFF_STOP_BOUNDARY.SUBAGENT_EXIT,
      resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_SUBAGENT_EXIT,
    });
  }
  switch (normalizedAction) {
    case "watch":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.PARENT,
        stopBoundary: HANDOFF_STOP_BOUNDARY.WATCH_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_STATE_REFRESH,
      });
    case "merge":
      return buildContract({
        ownership: requiresApproval ? HANDOFF_OWNERSHIP.HUMAN : HANDOFF_OWNERSHIP.PARENT,
        stopBoundary: HANDOFF_STOP_BOUNDARY.MERGE_BOUNDARY,
        resumePolicy: requiresApproval
          ? HANDOFF_RESUME_POLICY.RESUME_AFTER_MERGE_AUTHORIZATION
          : HANDOFF_RESUME_POLICY.NONE,
      });
    case "await_approval":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.APPROVAL_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_HUMAN_APPROVAL,
      });
    case "resolve_conflicts":
    case "blocked":
    case "error":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.CONFLICT_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.MANUAL_ATTENTION,
      });
    case "done":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.TERMINAL,
        stopBoundary: HANDOFF_STOP_BOUNDARY.TERMINAL,
        resumePolicy: HANDOFF_RESUME_POLICY.NONE,
      });
    default:
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.CONFLICT_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.MANUAL_ATTENTION,
      });
  }
}
export function buildHandoffContractForResumeAction(resumeAction) {
  const normalizedAction = normalizeContractValue(resumeAction);
  switch (normalizedAction) {
    case "needs_feedback_fix":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.SUBAGENT,
        stopBoundary: HANDOFF_STOP_BOUNDARY.SUBAGENT_EXIT,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_SUBAGENT_EXIT,
      });
    case "needs_reply_resolve":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.SUBAGENT,
        stopBoundary: HANDOFF_STOP_BOUNDARY.SUBAGENT_EXIT,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_SUBAGENT_EXIT,
      });
    case "needs_rerequest_or_watch":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.PARENT,
        stopBoundary: HANDOFF_STOP_BOUNDARY.WATCH_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_STATE_REFRESH,
      });
    case "await_final_approval":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.APPROVAL_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_HUMAN_APPROVAL,
      });
    case "await_merge_authorization":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.MERGE_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_MERGE_AUTHORIZATION,
      });
    case "await_ready_for_review_authorization":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.APPROVAL_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.RESUME_AFTER_HUMAN_APPROVAL,
      });
    case "done_or_merged":
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.TERMINAL,
        stopBoundary: HANDOFF_STOP_BOUNDARY.TERMINAL,
        resumePolicy: HANDOFF_RESUME_POLICY.NONE,
      });
    case "needs_manual_attention":
    default:
      return buildContract({
        ownership: HANDOFF_OWNERSHIP.HUMAN,
        stopBoundary: HANDOFF_STOP_BOUNDARY.CONFLICT_BOUNDARY,
        resumePolicy: HANDOFF_RESUME_POLICY.MANUAL_ATTENTION,
      });
  }
}
function parseContractLine(text, label) {
  const pattern = new RegExp(String.raw`(?:^|\n)\s*[-*]?\s*${label}:\s*(.+)$`, "imu");
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}
export function parseRecordedHandoffContract(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { contract: null, reason: null };
  }
  const ownership = normalizeContractValue(parseContractLine(text, "Handoff ownership"));
  const stopBoundary = normalizeContractValue(parseContractLine(text, "Stop boundary"));
  const resumePolicy = normalizeContractValue(parseContractLine(text, "Resume policy"));
  const foundCount = [ownership, stopBoundary, resumePolicy].filter((value) => value !== null).length;
  if (foundCount === 0) {
    return { contract: null, reason: null };
  }
  if (foundCount !== 3) {
    return {
      contract: null,
      reason: "incomplete_handoff_contract",
      details: {
        ownership,
        stopBoundary,
        resumePolicy,
      },
    };
  }
  const validOwnership = Object.values(HANDOFF_OWNERSHIP).includes(ownership);
  const validStopBoundary = Object.values(HANDOFF_STOP_BOUNDARY).includes(stopBoundary)
    || GATE_BOUNDARY_STOP_VALUES.has(stopBoundary);
  const validResumePolicy = Object.values(HANDOFF_RESUME_POLICY).includes(resumePolicy);
  if (!validOwnership || !validStopBoundary || !validResumePolicy) {
    return {
      contract: null,
      reason: "invalid_handoff_contract",
      details: {
        ownership,
        stopBoundary,
        resumePolicy,
      },
    };
  }
  return {
    contract: buildContract({
      ownership,
      stopBoundary,
      resumePolicy,
    }),
    reason: null,
  };
}
export function compareHandoffContracts(recorded, expected) {
  if (!recorded || !expected) {
    return null;
  }
  const mismatches = [];
  for (const key of ["ownership", "stopBoundary", "resumePolicy"]) {
    if (recorded[key] !== expected[key]) {
      mismatches.push(key);
    }
  }
  if (mismatches.length === 0) {
    return null;
  }
  return {
    mismatches,
    recorded,
    expected,
  };
}
export {
  HANDOFF_OWNERSHIP,
  HANDOFF_STOP_BOUNDARY,
  HANDOFF_RESUME_POLICY,
  SUBAGENT_ACTIONS
};
