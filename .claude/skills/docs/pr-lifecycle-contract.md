# PR lifecycle contract

This document defines the deterministic **family-local PR lifecycle contract** for the GitHub/Copilot workflow family in `dev-loops`.

The canonical contract lives in the shipped `skills/docs/` surface because installed skill/runtime consumers reliably own the skills subtree.

It consolidates the lifecycle boundary currently split across:
- [Copilot Loop State Graph](../../docs/copilot-loop-state-graph.md)
- [Reviewer Loop State Graph](../../docs/reviewer-loop-state-graph.md)
- [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md)

## Purpose

This contract freezes the end-to-end lifecycle semantics for one PR as it moves through:

```text
draft-stage local gate -> draft remediation -> ready-for-review
-> explicit Copilot request/wait -> Copilot remediation / reply-resolve / re-review
-> final local pre-approval gate -> human approval / merge waits
```

This document owns the **family-local lifecycle semantics** only.
It does not redefine helper transport mechanics, reviewer-loop internals, conductor routing, or merge policy.

## Relationship to adjacent contracts

| Surface | Relationship |
|---|---|
| [Copilot Loop State Graph](../../docs/copilot-loop-state-graph.md) | Copilot-family inner-loop state machine consumed by this lifecycle |
| [Reviewer Loop State Graph](../../docs/reviewer-loop-state-graph.md) | Reviewer-side review production / submission boundary consumed by this lifecycle |
| [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md) | Visible evidence contract for `draft_gate` and `pre_approval_gate` |
| [Conductor Routing Contract](../../docs/conductor-routing-contract.md) | Downstream consumer of family-local lifecycle outcomes |
| issue #29 | Reviewer-loop boundary semantics |
| issue #34 | Copilot request / re-request / watch helper mechanics |
| issue #43 | Review-angle policy for the final local pre-approval gate (now config-driven via `gates.preApproval.angles` and `resolveGateAngles`) |
| issue #61 | Conductor routing and loop-family handoff above this family-local lifecycle |
| issue #32 | Ownership/idempotency truth for active runs |

## Core rules

- Exactly **one current lifecycle state** must apply at a time.
- The lifecycle must fail closed when required evidence is missing, stale, ambiguous, or unparsable.
- Every gate-crossing decision is for the **current PR head SHA**.
- Draft existence alone is **not** draft-gate readiness.
- A PR must clear the draft-stage gate for the current head before Copilot review may be requested.
- Ready -> draft resets the lifecycle back into draft-stage gating.
- A merge-blocking marker in the PR **title** (`WIP`/`[WIP]`/`DRAFT`/`DO NOT MERGE`/`🚧`, case-insensitive) blocks the draft -> ready transition and, for non-draft PRs, blocks entry to the pre-approval gate and final approval (`title_marker_blocked`). Markers are permitted only while the PR remains draft. See [Merge preconditions](merge-preconditions.md#title-markers).
- Human approval / merge are explicit external waits, not hidden remediation states.

## Two required local gates

Each gate runs an independent review chain with its own disposition ledger, review angles,
and exit conditions. The chains are not interchangeable; see [Checkpoint Review Chain Contract](../../docs/gate-review-sub-loop-contract.md).

### 1. `draft_gate`

Applies while the PR is draft.

Purpose:
- decide whether the current draft head is materially reviewable
- decide whether the PR stays draft for more remediation or may leave draft
- when `gates.draft.requireCi=true` (default), require green current-head CI before the draft gate may be entered; when `false`, this draft-only CI prerequisite may be skipped

Boundary note:
- `draft_gate` governs only the draft -> ready-for-review boundary for the reviewed head
- a clean verdict requires no findings at any severity in the gate's `blockCleanOnFindingSeverities` (resolved from config via `resolveGateConfig(config, "draft").blockCleanOnFindingSeverities`)
- every gate pass writes a durable disposition ledger via `write-gate-findings-log.mjs` under `tmp/gate-findings/`
- visible comment schema/evidence rules stay in [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md)
- `gates.draft.requireCi=false` does **not** relax `pre_approval_gate`; final approval and merge readiness still require green current-head CI

### 2. `pre_approval_gate`

Applies after Copilot convergence and before final approval / merge claims.

This gate uses review angles resolved from config (`resolveGateAngles(config, "preApproval")`). Originally defined by #43; now config-driven.

Boundary note:
- `pre_approval_gate` governs only final approval readiness for the reviewed head
- a clean verdict requires no findings at any severity in the gate's `blockCleanOnFindingSeverities` (resolved from config via `resolveGateConfig(config, "preApproval").blockCleanOnFindingSeverities`)
- every gate pass writes a durable disposition ledger via `write-gate-findings-log.mjs` under `tmp/gate-findings/`
- non-draft PRs do not need visible `draft_gate` evidence to enter the post-draft review / `pre_approval_gate` lifecycle; only the draft -> ready transition depends on `draft_gate`
- visible comment schema/evidence rules stay in [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md)

## Lifecycle states

The family-local lifecycle should be modeled in this vocabulary. These state identifiers are part of the stable contract surface for this lifecycle, even if adjacent helper implementations evolve around them:

| State | Meaning |
|---|---|
| `draft_local_review_gate` | draft PR is at the local draft-stage gate boundary |
| `draft_local_remediation` | draft-stage findings require more local remediation while the PR remains draft |
| `ready_state_needs_copilot_request` | draft gate is clear for the current head; Copilot request is the next legal step |
| `waiting_for_copilot_review` | Copilot request/re-review is observably in progress for the current head |
| `copilot_feedback_remediation` | unresolved Copilot feedback exists; fixes are the next active step |
| `copilot_reply_resolve_pending` | fixes were applied, but GitHub thread reply/resolve work still remains |
| `merge_conflict_resolution` | current PR head conflicts with base or local reconcile is in progress; resolve conflicts before any further gate progression |
| `final_local_preapproval_gate` | current-head post-Copilot convergence is ready for the final local gate |
| `final_gate_remediation` | Pre-approval gate findings require more remediation after the final gate |
| `waiting_for_human_pr_approval` | local gates are satisfied; waiting for explicit human approval |
| `waiting_for_merge` | approval exists; waiting for merge / merge-triggering external action |
| `terminal_slice_complete` | merged/closed and no further owned step remains |
| `stopped_needs_user_decision` | blocked/ambiguous state requiring explicit human decision |

## Required transitions

At minimum, the lifecycle must enforce these transitions:

- `draft_local_review_gate` -> `draft_local_remediation`
  - blocking `draft_gate` findings
- `draft_local_review_gate` -> `ready_state_needs_copilot_request`
  - clean current-head `draft_gate` evidence exists
- `draft_local_review_gate` -> `stopped_needs_user_decision`
  - human decision required
- `draft_local_remediation` -> `draft_local_review_gate`
  - fixes pushed on the draft head
- `ready_state_needs_copilot_request` -> `waiting_for_copilot_review`
  - explicit request/confirm succeeded
- `ready_state_needs_copilot_request` -> `stopped_needs_user_decision`
  - request unavailable or blocked
- `waiting_for_copilot_review` -> `copilot_feedback_remediation`
  - unresolved Copilot feedback exists
- `copilot_feedback_remediation` -> `copilot_reply_resolve_pending`
  - fixes applied but reply/resolve still remains
- `copilot_reply_resolve_pending` -> `ready_state_needs_copilot_request`
  - reply/resolve complete and another Copilot pass is required
- any open non-terminal lifecycle slice -> `merge_conflict_resolution`
  - current-head merge state is conflicted (`DIRTY` / `CONFLICTING`) or local conflict reconciliation is already in progress
- `merge_conflict_resolution` -> normal lifecycle re-entry state
  - only after local conflict resolution produces a new head, validation is rerun for the touched conflict slice, and gate state is re-detected for that new head
- `waiting_for_copilot_review` -> `final_local_preapproval_gate`
  - the current-head request/re-review cycle has settled cleanly with no unresolved feedback and no further Copilot pass is needed
- `final_local_preapproval_gate` -> `final_gate_remediation`
  - pre-approval gate findings require changes
- `final_local_preapproval_gate` -> `waiting_for_human_pr_approval`
  - clean current-head `pre_approval_gate` evidence exists
- `waiting_for_human_pr_approval` -> `waiting_for_merge`
  - approval arrives
- `waiting_for_human_pr_approval` -> `draft_local_review_gate`
  - PR reset to draft
- `waiting_for_merge` -> `terminal_slice_complete`
  - merged/closed and the PR lifecycle is complete

### Required negative boundaries

- no Copilot request before clean current-head `draft_gate` evidence
- no direct skip from fix-applied to Copilot re-request while reply/resolve remains incomplete
- no reuse of ready-side or gate evidence after ready -> draft
- a conflicted PR must not be treated as `waiting_for_human_pr_approval`, `waiting_for_merge`, or merge-ready, even if older gate comments and CI were previously green
- no implicit fallthrough from approval/merge waits into remediation without a triggering event

## Remediation ownership boundary

The lifecycle must keep the next action class explicit:
- draft-stage local findings route to `draft_local_remediation`
- unresolved Copilot feedback routes to `copilot_feedback_remediation`
- fixes applied but unresolved GitHub reply/resolve work remains route to `copilot_reply_resolve_pending`
- pre-approval gate findings route to `final_gate_remediation`
- merge conflicts route to `merge_conflict_resolution` and must be reconciled locally on the PR branch before lifecycle re-entry
- human approval / merge remain explicit external waits

Reviewer-loop reminder:
- reviewer-loop semantics end at a review result / submission boundary
- this lifecycle defines what happens after that boundary without absorbing reviewer-loop planning/submission behavior

## Required evidence classes

The lifecycle distinguishes two evidence classes:

1. **observable GitHub state**
   - PR draft/non-draft/merged/closed state
   - current head SHA
   - reviews, review threads, requested reviewers
   - any current-head validation/check freshness only where an adjacent gate/helper already makes a boundary CI-dependent

2. **visible gate evidence on the PR**
   - current-head `draft_gate` evidence when draft-gate clearance is required
   - current-head `pre_approval_gate` evidence when final approval readiness is required

3. **durable disposition ledger**
   - every gate pass logs findings and dispositions under `tmp/gate-findings/<repo-slug>/pr-<N>/`
   - the ledger is the durable record of what each gate found and what was decided
   - the visible PR comment is a summary; the disposition ledger is the complete record

### Precedence rules

- current observable PR/head state beats stale local memory
- required visible gate evidence beats local-only gate records for crossing a gate boundary
- incomplete or conflicting evidence yields fail-closed blocked/reconcile behavior, not optimistic progression

## Fail-closed rules

The lifecycle must stop or reconcile rather than advance when:
- current head SHA cannot be determined
- required current-head `draft_gate` evidence is missing
- required current-head `pre_approval_gate` evidence is missing
- gate evidence exists but gate name, verdict, or reviewed SHA is missing or unparsable
- evidence exists only for an older head SHA
- review-thread capture failed or is incomplete, so unresolved feedback cannot safely be treated as zero
- Copilot request status is failed, unavailable without in-progress evidence, or otherwise ambiguous for the current head
- a required current-head wait cannot be confirmed settled
- the current head reports conflicted merge state (`DIRTY` / `CONFLICTING`) or local git conflict markers are present; enter `merge_conflict_resolution` instead of progressing
- a boundary that is already CI/validation-dependent cannot confirm current-head freshness because the relevant status is pending, none, unknown, or stale
- a required visible gate comment could not be confirmed posted

In those cases the workflow must not:
- leave draft
- request or re-request Copilot review
- declare final approval readiness
- silently fall through to a more permissive state

