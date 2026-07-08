/**
 * Public dev-loop façade routing contract.
 *
 * This evaluator models the first-slice public entrypoint contract from issue #86:
 * - one public entrypoint: `dev-loop`
 * - one canonical current-state shape
 * - deterministic routing to internal strategy families
 * - no legacy compatibility entrypoint projection in routed results
 *
 * The evaluator is intentionally pure and side-effect free. It does not inspect
 * GitHub or local state itself; callers may provide the authoritative current
 * state they have already detected, or omit it for explicit start intents where
 * the router can synthesize a minimal canonical state from the requested target.
 */

export const PUBLIC_DEV_LOOP_ENTRYPOINT = "dev-loop";

export const DEV_LOOP_PUBLIC_INTENT = Object.freeze({
  START_ON_ISSUE: "start_on_issue",
  CONTINUE_ON_PR: "continue_on_pr",
  START_ISSUE_LOCALLY: "start_issue_locally",
  START_ISSUE_LOCALLY_THEN_CONTINUE: "start_issue_locally_then_continue",
  CONTINUE_CURRENT: "continue_current",
  AUTO_CONTINUE_CURRENT: "auto_continue_current",
  INSPECT_STATE: "inspect_state",
  REVIEW_PR_UI: "review_pr_ui",
});

export const DEV_LOOP_TARGET_KIND = Object.freeze({
  ISSUE: "issue",
  PR: "pr",
  LOCAL_BRANCH: "local_branch",
  LOCAL_PHASE: "local_phase",
});

export const DEV_LOOP_ACTOR = Object.freeze({
  LOCAL: "local",
  COPILOT: "copilot",
  EXTERNAL_HUMAN: "external_human",
  REVIEWER: "reviewer",
  MAINTAINER: "maintainer",
  USER: "user",
});

export const DEV_LOOP_STATUS = Object.freeze({
  ACTIVE: "active",
  WAITING: "waiting",
  BLOCKED: "blocked",
  APPROVAL_READY: "approval_ready",
  MERGE_READY: "merge_ready",
  DONE: "done",
  RETROSPECTIVE_GATE_PENDING: "retrospective_gate_pending",
});

export const DEV_LOOP_AUTHORIZATION = Object.freeze({
  AUTHORIZED: "authorized",
  NEEDS_CONFIRMATION: "needs_confirmation",
  NOT_AUTHORIZED: "not_authorized",
});

export const DEV_LOOP_ROUTE_KIND = Object.freeze({
  ROUTE: "route",
  WAIT: "wait",
  STOP: "stop",
  INSPECT: "inspect",
  NEEDS_RECONCILE: "needs_reconcile",
});

export const DEV_LOOP_GATE = Object.freeze({
  STOP_BLOCKED_OR_NOT_AUTHORIZED: "stop_blocked_or_not_authorized",
  STOP_DONE_TERMINAL: "stop_done_terminal",
  FINAL_APPROVAL: "final_approval",
  WAITING_FOR_MERGE_AUTHORIZATION: "waiting_for_merge_authorization",
  WAIT_WATCH: "wait_watch",
  LOCAL_IMPLEMENTATION: "local_implementation",
  ISSUE_INTAKE: "issue_intake",
  EXTERNAL_PR_FOLLOWUP: "external_pr_followup",
  REVIEWER_FIXER: "reviewer_fixer",
  COPILOT_PR_FOLLOWUP: "copilot_pr_followup",
  UI_REVIEW: "ui_review",
  FAIL_CLOSED_RECONCILE: "fail_closed_reconcile",
});

export const INTERNAL_DEV_LOOP_STRATEGY = Object.freeze({
  LOCAL_IMPLEMENTATION: "local_implementation",
  ISSUE_INTAKE: "issue_intake",
  COPILOT_PR_FOLLOWUP: "copilot_pr_followup",
  EXTERNAL_PR_FOLLOWUP: "external_pr_followup",
  REVIEWER_FIXER: "reviewer_fixer",
  WAIT_WATCH: "wait_watch",
  FINAL_APPROVAL: "final_approval",
  UI_REVIEW: "ui_review",
  NONE: null,
});

export const DEV_LOOP_ARTIFACT_STATE = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
  NOT_APPLICABLE: "not_applicable",
});

export const DEV_LOOP_STATUS_REPORT_KIND = Object.freeze({
  RESOLVED: "resolved",
  NEEDS_RECONCILE: "needs_reconcile",
});

export const DEV_LOOP_CONTRACT_TRACE_CLASSIFICATION = Object.freeze({
  ROUTED_FOLLOWUP: "routed_followup",
  HEALTHY_WAIT: "healthy_wait",
  TERMINAL: "terminal",
  BLOCKED: "blocked",
  AUTHORIZATION_GATED: "authorization_gated",
  RECONCILE: "reconcile",
  INSPECT: "inspect",
});

export const DEV_LOOP_STARTUP_RESUME_BUNDLE_KIND = Object.freeze({
  RESOLVED: "resolved",
  NEEDS_RECONCILE: "needs_reconcile",
});

export const DEV_LOOP_EXECUTION_MODE = Object.freeze({
  BOUNDED_HANDOFF: "bounded_handoff",
  DURABLE_AUTO: "durable_auto",
});

export const DEV_LOOP_WAIT_SEMANTICS = Object.freeze({
  DEFAULT: "default",
  AUTO_HEALTHY_WAIT: "auto_healthy_wait",
});

export const DEV_LOOP_ISSUE_LINKAGE_RESOLUTION = Object.freeze({
  RESOLVED_LINKED_PR: "resolved_linked_pr",
  RESOLVED_NO_OPEN_PR: "resolved_no_open_pr",
  NOT_APPLICABLE: "not_applicable",
});

export const DEV_LOOP_ISSUE_READINESS = Object.freeze({
  READY: "ready",
  NEEDS_CLARIFICATION: "needs_clarification",
  NOT_APPLICABLE: "not_applicable",
});

export const DEV_LOOP_ISSUE_ASSIGNMENT_STATE = Object.freeze({
  UNASSIGNED: "unassigned",
  ASSIGNED_TO_COPILOT: "assigned_to_copilot",
  NOT_APPLICABLE: "not_applicable",
});

export const DEV_LOOP_ISSUE_ASSIGNMENT_SEAM = Object.freeze({
  NEEDS_REFINEMENT: "needs_refinement",
  READY_NEEDS_ASSIGNMENT_CONFIRMATION: "ready_needs_assignment_confirmation",
  READY_ASSIGN_NOW: "ready_assign_now",
  ASSIGNED_TO_COPILOT: "assigned_to_copilot",
  NOT_APPLICABLE: "not_applicable",
});

/**
 * Bounded first-slice target preference values for the `targetPreference` variation parameter.
 *
 * `prefer_local` steers routing toward local implementation when no authoritative
 * PR/linked-PR active-artifact truth has already decided the route.
 * It must not override authoritative state — if the canonical state already resolves
 * to an active PR or linked-PR path, `prefer_local` fails closed instead of silently coercing.
 */
export const DEV_LOOP_TARGET_PREFERENCE = Object.freeze({
  PREFER_GITHUB_FIRST: "prefer_github_first",
  PREFER_LOCAL: "prefer_local",
});

/**
 * First-slice bounded variation parameter contract for the public `dev-loop` entrypoint.
 *
 * Variation parameters may **steer** `dev-loop` behavior, but must not replace
 * authoritative routing. Precedence order (highest to lowest):
 *   1. authoritative current state — primary routing source of truth
 *   2. explicit user intent and API parameters — choose variation mode within the entrypoint
 *   3. settings/preferences — provide defaults only when (1) and (2) have not decided
 *
 * Ambiguous or conflicting parameter combinations fail closed instead of silently
 * overriding authoritative state.
 */
export const DEV_LOOP_VARIATION_PARAMETER_CONTRACT = Object.freeze({
  /** Allowed first-slice variation parameter names. */
  allowedParameters: Object.freeze(["mode", "watch", "intent", "targetPreference"]),
  /** Allowed values for the `mode` parameter. */
  allowedModeValues: Object.freeze([DEV_LOOP_EXECUTION_MODE.BOUNDED_HANDOFF, DEV_LOOP_EXECUTION_MODE.DURABLE_AUTO]),
  /** Allowed values for the `targetPreference` parameter. */
  allowedTargetPreferenceValues: Object.freeze(Object.values(DEV_LOOP_TARGET_PREFERENCE)),
  /**
   * Disallowed variation categories for this slice.
   * These must not become public variation knobs.
   */
  disallowedCategories: Object.freeze([
    "arbitrary_ownership_override",
    "arbitrary_strategy_override",
    "arbitrary_gate_override",
    "issue_pr_linkage_bypass",
    "expert_mode_flags",
  ]),
  /**
   * Precedence order for variation inputs (index 0 = highest authority).
   */
  precedenceOrder: Object.freeze([
    "authoritative_current_state",
    "explicit_intent_and_parameters",
    "settings_and_preferences",
  ]),
});

export const PUBLIC_DEV_LOOP_GATE_CONTRACT = Object.freeze([
  Object.freeze({
    gate: DEV_LOOP_GATE.STOP_BLOCKED_OR_NOT_AUTHORIZED,
    routeKind: DEV_LOOP_ROUTE_KIND.STOP,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    summary: "blocked or not-authorized canonical state stops for a human decision",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.STOP_DONE_TERMINAL,
    routeKind: DEV_LOOP_ROUTE_KIND.STOP,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    summary: "done canonical state stops as terminal work",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.FINAL_APPROVAL,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.FINAL_APPROVAL,
    summary: "approval-ready canonical state routes to final approval; merge-ready routes here only when merge authorization is explicit; requires explicit current-head pre_approval_gate evidence — clean-looking signals are not substitutes",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.WAITING_FOR_MERGE_AUTHORIZATION,
    routeKind: DEV_LOOP_ROUTE_KIND.STOP,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    summary: "merge-ready canonical state without explicit merge authorization stops and waits for merge authorization",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.WAIT_WATCH,
    routeKind: DEV_LOOP_ROUTE_KIND.WAIT,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.WAIT_WATCH,
    summary: "waiting canonical state routes to the shared wait/watch strategy",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.LOCAL_IMPLEMENTATION,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.LOCAL_IMPLEMENTATION,
    summary: "local branch or phase canonical state stays on local implementation",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.ISSUE_INTAKE,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.ISSUE_INTAKE,
    summary: "issue canonical state without a linked PR routes to issue intake",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.EXTERNAL_PR_FOLLOWUP,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.EXTERNAL_PR_FOLLOWUP,
    summary: "external-human PR ownership routes to external PR follow-up",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.REVIEWER_FIXER,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.REVIEWER_FIXER,
    summary: "reviewer-owned or reviewer-next PR state routes to reviewer/fixer",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.COPILOT_PR_FOLLOWUP,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.COPILOT_PR_FOLLOWUP,
    summary: "Copilot-owned PR state routes to Copilot PR follow-up; an already-linked open PR stays the canonical artifact for that issue until reconciled",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.UI_REVIEW,
    routeKind: DEV_LOOP_ROUTE_KIND.ROUTE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW,
    summary: "an explicit UI-review request on a PR target routes to the ui_review running-app review strategy",
  }),
  Object.freeze({
    gate: DEV_LOOP_GATE.FAIL_CLOSED_RECONCILE,
    routeKind: DEV_LOOP_ROUTE_KIND.NEEDS_RECONCILE,
    selectedStrategy: INTERNAL_DEV_LOOP_STRATEGY.NONE,
    summary: "ambiguous, conflicting, or unsupported canonical state fails closed to reconcile",
  }),
]);

