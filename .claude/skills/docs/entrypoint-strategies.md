# Entrypoint strategies

This document replaces the seven individual `entrypoint-briefing-*.md` files with a single per-strategy-section reference. Each section preserves the state vocabulary and key operational content for that strategy.

## Copilot PR follow-up

State vocabulary: `waiting_for_initial_copilot_implementation`, `waiting_for_copilot_review`, `review_feedback_received`, `linked_pr_ready_for_followup`, `blocked_needs_user_decision`

Next-action sentence: "Load PR state from `detect-copilot-loop-state.mjs`, resolve gate coordination, then execute the appropriate follow-up action (fix, review, wait, or escalate)."

Helpers to run first:
1. `dev-loops loop loop-state --repo <owner/name> --pr <N>` — resolve loop state
2. `dev-loops loop gate-coordination --repo <owner/name> --pr <N>` — resolve gate state
3. `dev-loops gate upsert-verdict` — post/update gate comments

Required reading:
- [Public Dev Loop Contract](public-dev-loop-contract.md)
- [Copilot Loop Operations](copilot-loop-operations.md)
- [Confirmation rules](confirmation-rules.md)
- [Stop conditions](stop-conditions.md)
- [Validation policy](validation-policy.md)

## External PR follow-up

State vocabulary: Same as Copilot PR follow-up but with external-human ownership.

Next-action sentence: "Load PR state, check for external review cycles, then route to reviewer/fixer or maintenance workflow."

Helpers to run first: Same as [Copilot PR follow-up](#copilot-pr-follow-up).

Required reading: Same as [Copilot PR follow-up](#copilot-pr-follow-up).

## Final approval

State vocabulary: `approval_ready`, `merge_ready`, `waiting_for_merge_authorization`

Next-action sentence: "Verify pre_approval_gate evidence, confirm CI green + resolved threads, then request explicit merge authorization."

Helpers to run first:
1. `dev-loops gate detect-evidence --repo <owner/name> --pr <N>` — verify gate evidence
2. `dev-loops gate upsert-verdict` — post pre_approval_gate

Required reading:
- [Public Dev Loop Contract](public-dev-loop-contract.md)
- [Final Approval SKILL](../final-approval/SKILL.md)
- [Merge preconditions](merge-preconditions.md)
- [Confirmation rules](confirmation-rules.md)

## Issue intake

State vocabulary: `waiting_for_initial_copilot_implementation`, `needs_refinement`, `ready_needs_assignment_confirmation`, `ready_assign_now`, `assigned_to_copilot`

Next-action sentence: "Resolve issue readiness, handle assignment seam, then bootstrap PR creation or wait for Copilot implementation."

Helpers to run first:
1. `dev-loops loop linked-issue-pr --repo <owner/name> --issue <N>` — resolve issue↔PR linkage
2. `dev-loops loop startup` — resolve routing

Required reading:
- [Public Dev Loop Contract](public-dev-loop-contract.md)
- [Issue Intake Procedure](issue-intake-procedure.md)
- [Confirmation rules](confirmation-rules.md)
- [Stop conditions](stop-conditions.md)

## Local implementation

State vocabulary: `local_branch`, `local_phase`, `in_progress`, `review`, `merge_ready`

Next-action sentence: "Fan-out refinement (unless light-mode), implement phase, validate, then create PR or continue to next phase."

Helpers to run first:
1. `dev-loops loop startup` — resolve routing
2. `node scripts/loop/pre-commit-branch-guard.mjs --expected-branch <name> [--require-worktree] [--block-main-checkout]` — verify isolation (no CLI route; use script path)

Required reading:
- [Public Dev Loop Contract](public-dev-loop-contract.md)
- [Local Implementation SKILL](../local-implementation/SKILL.md)
- [Anti-patterns](anti-patterns.md)
- [Structural quality](structural-quality.md)
- [Validation policy](validation-policy.md)

## Tracker-first

**Strategy:** `tracker_first` (reserved for future `dev-loop` routing when tracker context detected)

**Purpose:** Tracker-first workflow for story/epic tracker items that follow a PR-based GitHub execution path.

**Routing status:** Routing integration in `resolve-dev-loop-startup.mjs` is deferred (no `tracker_first` route exists yet). This briefing documents the intended contract surface; the state machine and detector are implemented and tested.

**Key artifacts:**
- Tracker issue (canonical spec)
- [Tracker-First Loop State](tracker-first-loop-state.md) — state machine doc
- `detect-tracker-first-loop-state.mjs` — loop state detector
- `detect-tracker-pr-state.mjs` — PR-level state detector

**Routing:** `dev-loop` will resolve to tracker-first when a tracker context is detected (issue has tracker labels, is a tracker-backed issue). Fail-closed: unknown tracker state → `needs_triage`.

**State vocabulary:** `drafting`, `needs_triage`, `in_progress`, `in_review`, `merge_ready`, `blocked`, `completed`, `unknown`

**Interface contract:** Same as Copilot loop: `{ ok, state, snapshot, allowedTransitions, nextAction }`

## Wait / watch

State vocabulary: `waiting`, `waiting_for_initial_copilot_implementation`, `waiting_for_copilot_review`

Next-action sentence: "Enter healthy-watch mode with configured timeout; escalate only on genuine blocked/authorization/reconcile states."

Helpers to run first:
1. `dev-loops loop watch-initial --repo <owner/name> --issue <N>` — bootstrap watcher
2. `dev-loops loop watch-cycle --repo <owner/name> --pr <N>` — cycle watcher

Required reading:
- [Public Dev Loop Contract](public-dev-loop-contract.md)
- [Copilot Loop Operations](copilot-loop-operations.md)
- [Stop conditions](stop-conditions.md)
