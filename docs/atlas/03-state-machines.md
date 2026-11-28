---
title: State machines and lifecycles
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="03-state-machines"></a>

## State machines and lifecycles

dev-loops drives every routing decision from frozen enums and explicit transition tables in `packages/core/src/loop/`. Most modules export a `*_TRANSITIONS` object that the code enforces. Others, such as the public dev-loop status and the gate-coordination checkpoints, are precedence cascades: an ordered list of `if` branches maps one snapshot to one result. The diagrams below follow the code. Where a doc names a state that no code produces, the diagram marks it.

<a id="d28"></a>

### Machine sizes at a glance

Type: `xychart-beta`

The bars show the state count of each transition-table machine. The line shows its legal edge count. The tracker machine is dense because its `unknown` state may move to any of its 8 states, itself included. The reviewer machine is dense because every pre-gate state may move to `submitted_review` and to `blocked_needs_user_decision`. Counts come from `node count-states.mjs` (a scratchpad script that imports `copilot-loop-state.mjs`, `reviewer-loop-state.mjs`, `lifecycle-state.mjs`, `queue-state.mjs`, `fix-loop-state.mjs`, `refinement-grill-state.mjs`, `pr-lifecycle.mjs` and `tracker-first-loop-state.mjs` and sums the transition arrays; pr-lifecycle excludes the `[*]` marker rows).

```mermaid
xychart-beta
  title "States and legal edges per machine"
  x-axis ["copilot", "reviewer", "lifecycle", "queue", "fixloop", "grill", "prlifecycle", "tracker"]
  y-axis "Count" 0 --> 45
  bar [15, 14, 7, 8, 14, 8, 13, 8]
  line [15, 40, 13, 22, 27, 15, 18, 33]
```

<a id="d29"></a>

### Dev-loop status to gate selection

Type: `stateDiagram-v2`

`selectGateForState` maps the canonical `status`, `authorization`, `target.kind` and `ownership` to one of 13 gates. The order matters. Lifecycle stops (blocked, done, merge authorization, approval, waiting) win before any target or ownership check, so an explicit `--review` or `--ui-review` request can never bypass them. Anything that falls through ends at `fail_closed_reconcile`. Derived from `packages/core/src/loop/public-dev-loop-routing.mjs` and `packages/core/src/loop/public-dev-loop-routing-contract.mjs`.

```mermaid
stateDiagram-v2
  [*] --> c_blocked
  state c_blocked <<choice>>
  state c_done <<choice>>
  state c_merge <<choice>>
  state c_approval <<choice>>
  state c_wait <<choice>>
  state c_local <<choice>>
  state c_issue <<choice>>
  state c_review <<choice>>
  state c_ui <<choice>>
  state c_ext <<choice>>
  state c_rev <<choice>>
  state c_cop <<choice>>
  c_blocked --> stop_blocked_or_not_authorized: blocked or not_authorized
  c_blocked --> c_done: else
  c_done --> stop_done_terminal: done
  c_done --> c_merge: else
  c_merge --> waiting_for_merge_authorization: merge_ready and needs_confirmation
  c_merge --> c_approval: else
  c_approval --> final_approval: approval_ready or merge_ready
  c_approval --> c_wait: else
  c_wait --> wait_watch: waiting
  c_wait --> c_local: else
  c_local --> local_implementation: local_branch or local_phase
  c_local --> c_issue: else
  c_issue --> issue_intake: issue target
  c_issue --> c_review: else
  c_review --> review: PR and review requested
  c_review --> c_ui: else
  c_ui --> ui_review: PR and UI review requested
  c_ui --> c_ext: else
  c_ext --> external_pr_followup: owner external_human
  c_ext --> c_rev: else
  c_rev --> reviewer_fixer: owner or next actor reviewer
  c_rev --> c_cop: else
  c_cop --> copilot_pr_followup: owner copilot
  c_cop --> fail_closed_reconcile: else
```

<a id="d30"></a>

### Dev-loop status values and their route kinds

Type: `stateDiagram-v2`

The status enum has no transition table. Each status maps to a route kind through the gate above. `not_authorized` stops every status first. `blocked`, `done` and a `merge_ready` state that still needs confirmation stop. `waiting` is the only status that yields a wait route. `approval_ready` and `merge_ready` without a pending confirmation route to final approval, but the router turns that into `needs_reconcile` when no clean current-head `pre_approval_gate` evidence is visible. `active` routes by target and ownership, and fall through to `needs_reconcile` when nothing matches. Derived from `packages/core/src/loop/public-dev-loop-routing-contract.mjs` (`DEV_LOOP_STATUS`, `DEV_LOOP_ROUTE_KIND`) and `selectGateForState` plus the gate-to-result branches in `packages/core/src/loop/public-dev-loop-routing.mjs`.

```mermaid
stateDiagram-v2
  state "status values" as S {
    active
    waiting
    blocked
    approval_ready
    merge_ready
    done
  }
  active --> route: target and owner gates
  active --> needs_reconcile: no gate matches
  waiting --> wait: wait_watch
  blocked --> stop: stop_blocked_or_not_authorized
  approval_ready --> route_final: final_approval
  merge_ready --> route_final: no pending confirmation
  merge_ready --> stop: needs_confirmation
  route_final --> needs_reconcile: no clean pre_approval evidence
  done --> stop: stop_done_terminal
```

<a id="d31"></a>

### Gate-coordination evaluator precedence

Type: `stateDiagram-v2`

`evaluatePrGateCoordinationCore` checks PR facts in a fixed order before it looks at the Copilot lifecycle state. Merged or closed PRs report done first. Merge conflicts, UI end-to-end scoping and designer-review scoping all outrank the draft gate. A draft PR never reaches the post-draft branches. A draft PR with failing required CI, or a refused draft round that is not ready, reports blocked. A clean `pre_approval_gate` still yields to a merge-blocking title marker and to missing `draft_gate` evidence. An unmapped lifecycle state falls through to `report_blocked`. Derived from `packages/core/src/loop/pr-gate-coordination.mjs` and `scripts/loop/detect-pr-gate-coordination-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> merged_or_closed
  merged_or_closed --> report_done: yes
  merged_or_closed --> blocked_state: no
  blocked_state --> report_blocked: blocked or review unavailable
  blocked_state --> mergeable_unknown: no
  mergeable_unknown --> wait_for_ci: UNKNOWN
  mergeable_unknown --> conflicts: known
  conflicts --> resolve_merge_conflicts: conflicting or behind
  conflicts --> ui_e2e: clean
  ui_e2e --> run_ui_e2e_suite: required and unsatisfied
  ui_e2e --> designer: ok
  designer --> record_designer_review: required and unsatisfied
  designer --> is_draft: ok
  is_draft --> draft_branch: draft
  is_draft --> post_draft: ready
  state draft_branch {
    [*] --> refinement
    refinement --> d_blocked: artifact missing
    refinement --> d_threads: present
    d_threads --> d_reply: clean marker, threads open
    d_threads --> d_ci: ok
    d_ci --> d_blocked: CI required, failing
    d_ci --> d_wait_ci: CI required, pending
    d_ci --> d_feedback: act list open
    d_ci --> d_refused: ok
    d_refused --> d_blocked: round refused, not ready
    d_refused --> d_gate: ok
    d_gate --> mark_ready: clean draft_gate
    d_gate --> run_draft_gate: no clean evidence
  }
  state post_draft {
    [*] --> by_lifecycle
    by_lifecycle --> request_review: pr_ready_no_feedback
    by_lifecycle --> wait: waiting states
    by_lifecycle --> feedback: unresolved feedback
    by_lifecycle --> reply_resolve: already fixed
    by_lifecycle --> converge: rerequest, cap, low signal, internal_only, copilot_unavailable
    converge --> run_pre_approval_gate: no clean evidence
    converge --> title_marker_blocked: clean, title marker
    converge --> reconcile_draft_gate: clean, no draft_gate evidence
    converge --> await_final_human_approval: clean pre_approval_gate
  }
  post_draft --> report_blocked: unmapped state
```

<a id="d32"></a>

### Gate checkpoint to nextAction flow

Type: `sankey-beta`

Each band counts the result sites in the evaluator that pair a `gateBoundary` checkpoint with a literal `nextAction`. `report_blocked` has 15 sites: 10 literal `return buildResult(...)` sites plus 5 calls to `buildTitleMarkerBlockedResult`, which shows how many paths fail closed. The 5 calls to `buildDraftGateNeededForMergeResult` produce `draft_gate_needed` with `reconcile_draft_gate`. The `pre_approval_gate_needed` band is the single rewrite site in the script wrapper. It converts a pre-approval or final-approval boundary when no contract-complete `pre_approval_gate` marker exists. Ternary sites (draft gate versus mark ready, the two wait actions, the round-cap action list) are not literal and are left out. The literal counts come from an `awk` scan of `packages/core/src/loop/pr-gate-coordination.mjs` lines 1290 to 2718 piped to `sort | uniq -c`. The helper counts come from `grep -c "return buildTitleMarkerBlockedResult("` and `grep -c "return buildDraftGateNeededForMergeResult("` on the same file. The wrapper site is in `scripts/loop/detect-pr-gate-coordination-state.mjs`.

```mermaid
sankey-beta
blocked,report_blocked,15
conflict_resolution,resolve_merge_conflicts,1
conflict_resolution,wait_for_ci,1
designer_review_scoping,record_designer_review,1
done,report_done,1
draft_gate_needed,reconcile_draft_gate,5
draft_review,address_review_feedback,1
draft_review,wait_for_ci,1
feedback_resolution,address_review_feedback,1
feedback_resolution,reply_resolve_review_threads,3
final_approval_ready,await_final_human_approval,5
post_draft_external_review,request_copilot_review,1
post_draft_external_review,rerequest_copilot_review,1
post_draft_external_review,wait_for_ci,3
pre_approval_gate_needed,run_pre_approval_gate,1
pre_approval_gate_window,run_pre_approval_gate,5
ui_e2e_scoping,run_ui_e2e_suite,1
```

<a id="d33"></a>

### Copilot PR loop transitions

Type: `stateDiagram-v2`

This is the inner PR loop that the gate evaluator consumes as `lifecycleState`. The table allows only one exit from draft and one from ready-no-feedback. Six states have no outgoing edge: `review_request_unavailable`, `blocked_needs_user_decision`, `low_signal_converged`, `round_cap_reached`, `round_cap_clean_fallback` and `copilot_unavailable`. The gate evaluator routes the last four onward to `pre_approval_gate`; this table holds no edge for them. `no_pr` also has no edge. Derived from `TRANSITIONS` in `packages/core/src/loop/copilot-loop-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> no_pr
  [*] --> pr_draft
  pr_draft --> pr_ready_no_feedback
  pr_ready_no_feedback --> waiting_for_copilot_review
  waiting_for_copilot_review --> unresolved_feedback_present
  waiting_for_copilot_review --> ready_to_rerequest_review
  waiting_for_copilot_review --> waiting_for_ci
  unresolved_feedback_present --> unresolved_feedback_present
  unresolved_feedback_present --> already_fixed_needs_reply_resolve
  already_fixed_needs_reply_resolve --> ready_to_rerequest_review
  ready_to_rerequest_review --> waiting_for_copilot_review
  ready_to_rerequest_review --> review_request_unavailable
  ready_to_rerequest_review --> done
  waiting_for_ci --> pr_ready_no_feedback
  waiting_for_ci --> ready_to_rerequest_review
  waiting_for_ci --> blocked_needs_user_decision
  internal_tooling_direct_gate --> done
  done --> [*]
  review_request_unavailable --> [*]
  blocked_needs_user_decision --> [*]
  low_signal_converged --> [*]
  round_cap_reached --> [*]
  round_cap_clean_fallback --> [*]
  copilot_unavailable --> [*]
```

<a id="d34"></a>

### Outer lifecycle phases

Type: `stateDiagram-v2`

The outer lifecycle has 7 states: 6 working phases and the terminal `merge`. Every phase after implementation can send work back to `implementation`, so a failed gate always reopens code work. `draft_gate` can skip ahead to `feedback_resolution`. `LIFECYCLE_GRAPH.entryStates` lists all 7 states, `merge` included, so a run may resume at any of them. Derived from `LIFECYCLE_TRANSITIONS` and `LIFECYCLE_GRAPH` in `packages/core/src/loop/lifecycle-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> issue_intake
  issue_intake --> refinement
  issue_intake --> implementation
  refinement --> issue_intake
  refinement --> implementation
  implementation --> draft_gate
  implementation --> feedback_resolution
  draft_gate --> implementation
  draft_gate --> feedback_resolution
  feedback_resolution --> implementation
  feedback_resolution --> pre_approval_gate
  pre_approval_gate --> implementation
  pre_approval_gate --> feedback_resolution
  pre_approval_gate --> merge
  merge --> [*]
```

<a id="d35"></a>

### PR lifecycle contract graph

Type: `stateDiagram-v2`

The PR lifecycle table has 13 states and 18 real edges. Terminal states are derived from the edge list, not hand-listed. A human can send an approved PR back to `draft_local_review_gate`, which restarts the whole gate sequence. Only two states are absorbing: `terminal_slice_complete` and `stopped_needs_user_decision`. Derived from `PR_LIFECYCLE_TRANSITIONS` in `packages/core/src/loop/pr-lifecycle.mjs`.

```mermaid
stateDiagram-v2
  [*] --> draft_local_review_gate
  draft_local_review_gate --> draft_local_remediation
  draft_local_remediation --> draft_local_review_gate
  draft_local_review_gate --> ready_state_needs_copilot_request
  draft_local_review_gate --> stopped_needs_user_decision
  ready_state_needs_copilot_request --> waiting_for_copilot_review
  ready_state_needs_copilot_request --> stopped_needs_user_decision
  waiting_for_copilot_review --> copilot_feedback_remediation
  copilot_feedback_remediation --> copilot_reply_resolve_pending
  copilot_reply_resolve_pending --> ready_state_needs_copilot_request
  waiting_for_copilot_review --> merge_conflict_resolution
  merge_conflict_resolution --> waiting_for_copilot_review
  waiting_for_copilot_review --> final_local_preapproval_gate
  final_local_preapproval_gate --> final_gate_remediation
  final_gate_remediation --> final_local_preapproval_gate
  final_local_preapproval_gate --> waiting_for_human_pr_approval
  waiting_for_human_pr_approval --> waiting_for_merge
  waiting_for_human_pr_approval --> draft_local_review_gate
  waiting_for_merge --> terminal_slice_complete
  terminal_slice_complete --> [*]
  stopped_needs_user_decision --> [*]
```

<a id="d36"></a>

### Reviewer loop state graph

Type: `stateDiagram-v2`

The reviewer loop runs a linear pipeline from request to a posted draft review, then waits for the operator to submit. A head change invalidates a pending draft. A head change after submission marks `re_review_needed`. Two fan-in edges are drawn as notes to keep the graph readable. A recorded `submitted` outcome jumps any state from `waiting_for_review_request` to `waiting_for_user_submit` to `submitted_review`. A `failed` outcome sends every state except the two legacy states to `blocked_needs_user_decision`. The legacy states `waiting_for_author_followup` and `waiting_for_re_request` keep table rows, but `interpretReviewerLoopState` never produces them. Derived from `REVIEWER_TRANSITIONS` in `packages/core/src/loop/reviewer-loop-state.mjs` and `skills/docs/reviewer-loop-state-graph.md`.

```mermaid
stateDiagram-v2
  [*] --> waiting_for_review_request
  waiting_for_review_request --> review_requested
  review_requested --> determine_review_plan
  determine_review_plan --> reviews_running
  reviews_running --> merge_results
  merge_results --> draft_review_ready
  draft_review_ready --> draft_review_posted
  draft_review_posted --> waiting_for_user_submit
  draft_review_posted --> review_invalidated
  draft_review_posted --> submitted_review
  waiting_for_user_submit --> submitted_review
  waiting_for_user_submit --> review_invalidated
  review_invalidated --> review_requested
  submitted_review --> re_review_needed
  submitted_review --> review_requested
  submitted_review --> waiting_for_review_request
  re_review_needed --> review_requested
  re_review_needed --> submitted_review
  re_review_needed --> waiting_for_review_request
  waiting_for_author_followup --> submitted_review
  waiting_for_author_followup --> review_requested
  waiting_for_author_followup --> waiting_for_review_request
  waiting_for_re_request --> review_requested
  waiting_for_re_request --> submitted_review
  blocked_needs_user_decision --> [*]
  note right of reviews_running
    submitted outcome jumps any
    pre-posted state to submitted_review
  end note
  note left of review_invalidated
    failed outcome sends any non-legacy
    state to blocked_needs_user_decision
  end note
```

<a id="d37"></a>

### Ownership classification and Next Up claim

Type: `stateDiagram-v2`

`classifyOwnership` checks for a Copilot assignee first, so a Copilot-owned item never needs the viewer login. `assigned_to_me` requires the viewer to be the sole human assignee. A co-assigned viewer counts as `assigned_to_other`. Next Up pickup skips `assigned_to_other` items and picks Copilot-owned and own items directly. It claims an unassigned item, re-reads the assignees, and resolves a contest with a case-insensitive lexicographic tiebreak. The loser unassigns itself. The winner removes the other login. Derived from `packages/core/src/github/ownership-helpers.mjs` and `resolveNextUpHead` plus `attemptClaimAndArbitrate` in `scripts/projects/resolve-active-board-item.mjs`.

```mermaid
stateDiagram-v2
  state classify <<choice>>
  [*] --> classify
  classify --> assigned_to_copilot: any Copilot login
  classify --> unassigned: no logins
  classify --> assigned_to_me: viewer is sole human
  classify --> assigned_to_other: any other human
  assigned_to_copilot --> picked
  assigned_to_me --> picked
  assigned_to_other --> skipped
  unassigned --> claimed: add assignee me
  state reread <<choice>>
  claimed --> reread
  reread --> picked: not assigned_to_other
  reread --> not_visible: own claim missing
  reread --> contested: viewer and other present
  not_visible --> skipped: self unclaim
  contested --> won: smallest login
  contested --> lost: other login smaller
  won --> picked: remove other login
  lost --> skipped: self unassign
  picked --> [*]
  skipped --> [*]
```

<a id="d38"></a>

### Retrospective checkpoint resolution

Type: `stateDiagram-v2`

The durable checkpoint artifact resolves to one of 4 states. A missing file or a recorded `none` resolves to `none`. A malformed file, a stale record after a newer merge, or a `complete` record without fresh-context provenance all fail closed to `missing`. The routing gate passes `missing` through unchanged, and `merge-pr` enforces it at merge time through its `retrospective_checkpoint` precondition. Only an unrecognized checkpoint state produces `needs_reconcile`. A proposed route that is already stop, inspect or needs\_reconcile passes through untouched. Derived from `resolveCheckpointStateFromArtifact` and `evaluateRetrospectiveGate` in `packages/core/src/loop/retrospective-checkpoint.mjs`, `scripts/github/merge-pr.mjs` and `skills/docs/retrospective-checkpoint-contract.md`.

```mermaid
stateDiagram-v2
  state artifact <<choice>>
  [*] --> artifact
  artifact --> none: no file or state none
  artifact --> missing: malformed or unknown state
  artifact --> missing: state required or missing
  artifact --> skipped: state skipped, no newer merge
  artifact --> missing: skipped or complete, newer merge
  artifact --> missing: complete, no fresh provenance
  artifact --> complete: complete, fresh provenance
  none --> route_unchanged
  complete --> route_unchanged
  skipped --> route_unchanged
  missing --> route_unchanged: merge-pr blocks merge
  route_unchanged --> [*]
```

<a id="d39"></a>

### Board columns

Type: `stateDiagram-v2`

The board has 4 logical columns: `next_up`, `in_progress`, `ready_for_review` and `done`. Backlog is not a logical column. It is the default non-success column (`nonSuccessStatus`), and the queue driver moves an item there when its run throws. Display names come from config, and `ready_for_review` resolves to "In Progress" unless the board configures it. Reconcile moves an item to `in_progress` when any linked PR is open and to `done` when the PR merges or the issue closes. Otherwise it leaves Backlog and Next Up untouched. The state-to-column map is stateless, so a PR demoted to draft maps back to `in_progress`. Pickup reads only Next Up and never falls back to Backlog. Derived from `deriveReconcileColumn` and `nonSuccessBoardColumn` in `packages/core/src/loop/queue-board-sync.mjs`, `packages/core/src/loop/queue-driver.mjs` and `scripts/projects/resolve-active-board-item.mjs`.

```mermaid
stateDiagram-v2
  [*] --> Backlog
  Backlog --> next_up: operator prioritizes
  next_up --> in_progress: claim or PR open
  in_progress --> ready_for_review: pre_approval_gate
  ready_for_review --> in_progress: draft again
  in_progress --> done: PR merged or issue closed
  ready_for_review --> done: PR merged
  in_progress --> Backlog: queue run fails
  done --> [*]
  note right of Backlog
    never a pickup source
  end note
```

<a id="d40"></a>

### Loop states per board column

Type: `pie`

`DEFAULT_STATE_LOGICAL_MAP` assigns 29 loop-state names to columns. 19 of them land in In Progress, including blocked and round-cap states, and any unmapped state also falls back to In Progress. Counts come from `node count-columns.mjs` (a scratchpad script that tallies `DEFAULT_STATE_LOGICAL_MAP` values in `packages/core/src/loop/queue-board-sync.mjs`).

```mermaid
pie showData
  title Loop states mapped per column
  "in_progress" : 19
  "next_up" : 4
  "done" : 4
  "ready_for_review" : 2
```

<a id="d41"></a>

### Pre-push delta review results

Type: `stateDiagram-v2`

A delta sequence allows at most 3 reviewer invocations (`DELTA_MAX_INVOCATIONS`). A fresh, valid `locally_clear` result grants the push. Below the bound, any other result is `needs_fix`. A fresh result loops through the fixer, and a stale result re-reviews the moved head. At the bound the sequence ends `bounded_out` and pushes into the normal gate path with no success claim. Per-item statuses are `resolved`, `not_resolved` and `cannot_verify`. Any status other than `resolved`, or a new finding of medium or higher severity, forbids `locally_clear`. Derived from `decideDeltaNextStep` and `deriveDeltaOutcome` in `packages/core/src/loop/pre-push-delta-review.mjs`.

```mermaid
stateDiagram-v2
  [*] --> invocation
  state verdict <<choice>>
  invocation --> verdict
  verdict --> locally_clear: valid, fresh, all resolved
  verdict --> bounded_out: not clear, invocation 3
  verdict --> needs_fix: not clear, invocation under 3
  needs_fix --> fix_and_rereview: fresh
  needs_fix --> rereview_current_head: stale
  fix_and_rereview --> invocation
  rereview_current_head --> invocation
  locally_clear --> push
  bounded_out --> push_to_gate
  push --> [*]
  push_to_gate --> [*]
```

<a id="d42"></a>

### Gate fixer loop

Type: `stateDiagram-v2`

The fix loop wraps the delta review. A `commit_only` fixer commits without pushing, the delta review checks the candidate, and only then does a `full` order push it. `head_moved` is reachable from every in-flight state and always ends in a full gate round. `stopped` has no inbound edge in the table. `interpretFixLoopState` enters it directly when the snapshot carries the operator stop flag, ahead of every other check. Derived from `FIX_LOOP_TRANSITIONS` and `interpretFixLoopState` in `packages/core/src/loop/fix-loop-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> act_pending
  act_pending --> commit_only_emitted
  commit_only_emitted --> candidate_committed
  commit_only_emitted --> no_commit
  no_commit --> full_gate_round
  candidate_committed --> delta_review
  delta_review --> full_emitted: clear or bounded_out
  delta_review --> commit_only_emitted: residue
  full_emitted --> pushed
  pushed --> ci_green
  pushed --> ci_red
  ci_red --> act_pending
  ci_green --> disposition_complete
  ci_green --> delivery_incomplete
  delivery_incomplete --> disposition_complete
  delivery_incomplete --> full_gate_round
  disposition_complete --> full_gate_round
  head_moved --> full_gate_round
  head_moved --> disposition_complete
  [*] --> stopped: operator stop flag
  full_gate_round --> [*]
  stopped --> [*]
  note right of head_moved
    reachable from every state from
    commit_only_emitted to disposition_complete
  end note
```

<a id="d43"></a>

### Queue entry status

Type: `stateDiagram-v2`

The local queue entry has 8 statuses. `blocked` can resume at `queued` or `running`. `failed` can only re-queue. `done` is the only terminal. When a run throws, the driver marks the entry `failed` only for a failure kind in `RECOVERABLE_FAILURES` (`acceptance_report_parse_failure`, `round_cap_reached`, `timeout`) with retries left. Every other failure marks it `blocked`. Only those recoverable `failed` entries are picked up again. Derived from `VALID_TRANSITIONS` and `RECOVERABLE_FAILURES` in `packages/core/src/loop/queue-state.mjs` and the failure branch in `packages/core/src/loop/queue-driver.mjs`.

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  queued --> blocked
  running --> waiting_review
  running --> blocked
  running --> failed
  running --> done
  waiting_review --> running
  waiting_review --> gates_passing
  waiting_review --> blocked
  waiting_review --> failed
  waiting_review --> done
  gates_passing --> merging
  gates_passing --> blocked
  gates_passing --> failed
  gates_passing --> done
  merging --> done
  merging --> failed
  merging --> blocked
  blocked --> queued
  blocked --> running
  blocked --> failed
  failed --> queued: recoverable only
  done --> [*]
```

<a id="d44"></a>

### Refinement grill loop

Type: `stateDiagram-v2`

The grill iterates to a fixed point: detect gaps, collect answers, synthesize, then re-grill. Three terminals exist. `grill_clean` is the fixed point, `needs_human_handoff` covers a gap with no citable answer, and `blocked_needs_user_decision` covers an I/O or parse failure. Derived from `GRILL_TRANSITIONS` in `packages/core/src/loop/refinement-grill-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> load_target
  load_target --> detect_gaps
  detect_gaps --> await_answers
  detect_gaps --> grill_clean: zero gaps, provenance, issue simplicity review
  detect_gaps --> needs_human_handoff
  await_answers --> synthesize
  await_answers --> needs_human_handoff
  synthesize --> re_grill
  re_grill --> detect_gaps: new gap
  re_grill --> grill_clean
  re_grill --> needs_human_handoff
  load_target --> blocked_needs_user_decision
  detect_gaps --> blocked_needs_user_decision
  await_answers --> blocked_needs_user_decision
  synthesize --> blocked_needs_user_decision
  re_grill --> blocked_needs_user_decision
  grill_clean --> [*]
  needs_human_handoff --> [*]
  blocked_needs_user_decision --> [*]
```

<a id="d45"></a>

### Tracker-first issue states

Type: `stateDiagram-v2`

The tracker-first machine maps a raw tracker state to 8 canonical states. Every state may move to `unknown`, and `unknown` may move to any state, itself included. That is why the bar chart shows 33 edges for 8 states. `completed` can only leave through `unknown`. An unrecognized raw state fails closed to `needs_triage`. Derived from `TRACKER_TRANSITIONS` and `interpretTrackerLoopState` in `packages/core/src/loop/tracker-first-loop-state.mjs`.

```mermaid
stateDiagram-v2
  [*] --> needs_triage: unrecognized raw state
  drafting --> needs_triage
  drafting --> blocked
  needs_triage --> in_progress
  needs_triage --> blocked
  needs_triage --> drafting
  in_progress --> in_review
  in_progress --> blocked
  in_progress --> needs_triage
  in_review --> merge_ready
  in_review --> in_progress
  in_review --> blocked
  merge_ready --> completed
  merge_ready --> in_review
  merge_ready --> blocked
  blocked --> needs_triage
  blocked --> in_progress
  blocked --> in_review
  blocked --> drafting
  completed --> unknown
  note right of unknown
    every state may move to unknown
    unknown may move to all 8 states
  end note
```

