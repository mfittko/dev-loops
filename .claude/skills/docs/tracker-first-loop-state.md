# Tracker-First Story-to-PR Contract

This document defines the adapter-agnostic MVP contract for the tracker-first
story-to-PR workflow in `pi-dev-loops`.

**MVP invariant: one tracker work item → one GitHub PR.**

This document serves dual purpose:
1. **Story-to-PR contract** — canonical for the PR-level tracker state machine
2. **Loop state machine doc** — canonical for the tracker-first loop state machine (#449)

Implementation for each:

| Component | File |
|---|---|
| PR-level state machine (story-to-PR) | `packages/core/src/loop/tracker-pr-state.mjs` |
| PR-level CLI detector | `scripts/loop/detect-tracker-pr-state.mjs` |
| Loop state machine (tracker-first) | `packages/core/src/loop/tracker-first-loop-state.mjs` |
| Loop state CLI detector | `scripts/loop/detect-tracker-first-loop-state.mjs` |
| Loop state contract doc | this file |
| Entrypoint briefing | `skills/docs/entrypoint-strategies.md#tracker-first` |

## 1. Artifact Subset and MVP Invariant

| Artifact | Role in this slice |
|---|---|
| One tracker work item (story, task, or bug) | Planning artifact; source of truth for work identity and planning state |
| One GitHub PR | Execution artifact; source of truth for lifecycle, review, CI, and merge facts |
| PR review / CI / merge facts | Observable from GitHub; feed reverse-sync decisions |
| Epic / PRD reference | Optional linked metadata only; no roll-up or automation in this slice |
| ADR / RFC reference | Optional linked metadata only; no decision-sync in this slice |

**Invariant:** For any single tracker work item in scope, there is at most
one active GitHub PR at a time. Multi-PR workflows and roll-up automation
are out of scope for this slice.

## 2. Source-of-Truth Ownership

| Domain | Owner | Examples |
|---|---|---|
| Work-item identity and planning hierarchy | Tracker | Item ID, title, description, priority, assignee, epic link |
| Tracker-native workflow state | Tracker | In-progress, blocked, done/completed, and any tracker-specific sub-states |
| PR lifecycle facts | GitHub | Draft / ready-for-review, open / merged / closed, branch, head SHA |
| PR review and CI facts | GitHub | Reviewer assignments, review states, check-run results, merge status |
| Decision content | ADR / RFC artifacts (when linked) | Architecture decisions and RFCs referenced from PR body |
| PR projection and reverse-sync logic | `pi-dev-loops` | Title/body/label generation rules, state mapping, sync triggers |

`pi-dev-loops` **does not** become the canonical owner of any business fields.
It provides projection and sync logic only.

## 3. PR Projection Contract

The following rules define how a tracker work item projects into GitHub PR
metadata. All rules are deterministic and idempotent: applying them to the
same inputs always produces the same output, and re-applying them to an
already-correct PR leaves it unchanged.

### 3.1 Required PR Metadata

| Field | Rule |
|---|---|
| PR title | `[{TRACKER_ID}] {tracker item title}` — bracketed tracker identifier followed by the item title verbatim |
| PR body — Tracker section | Required. Must include the tracker item ID and a direct link to the item. |
| PR body — Summary section | Required. Brief description of the change implemented in this PR. |
| PR body — Acceptance Criteria section | Required. Copied or linked from the tracker item's acceptance criteria. |
| Labels | Required: `tracker:{TRACKER_ID}`. Optional reference labels: `epic:{EPIC_ID}`, `prd:{PRD_ID}` when references are present. |
| Draft state | PR must start as a draft. It must not be marked ready-for-review until development work is complete. |

### 3.2 Optional Reference Metadata

Optional parent / decision references may appear in the PR body as links only.
They are read-only metadata in this slice and do not trigger any automation:

| Reference type | Placement | Effect |
|---|---|---|
| Epic | PR body — References section | Link only; no roll-up automation |
| PRD | PR body — References section | Link only; no roll-up automation |
| ADR | PR body — References section | Link only; no decision sync |
| RFC | PR body — References section | Link only; no decision sync |

### 3.3 Deterministic Update Rules

1. **On PR create**: Generate title, body, and labels from tracker item fields.
   Apply draft state.
2. **On tracker item field change**: Re-apply projection rules to PR title,
   body, and labels. Leave any sections not covered by projection rules
   (e.g. reviewer-added review comments) intact.
3. **Idempotent regeneration**: If the PR already has the correct title, body
   sections, and labels, no mutation is performed. Projection is a no-op
   when the current state already matches the target.

### 3.4 PR Body Template

```
## Summary
{brief description of the change}

## Acceptance Criteria
{copied or linked from tracker item}

## Tracker
- Item: [{TRACKER_ID}]({TRACKER_ITEM_URL})

## References
<!-- optional; add epic/PRD/ADR/RFC links here as plain links only -->
```

## 4. Reverse-Sync Contract

The following table defines the canonical reverse-sync contract. Adapter
implementations map canonical action names to tracker-native field updates.

### 4.1 Canonical State Table

| Lifecycle state | `reverseSyncAction` | Tracker effect |
|---|---|---|
| `ready_no_pr` — tracker item exists, no PR exists yet | `none` | No automatic mutation. Tracker-native readiness remains tracker-owned and is outside this snapshot-only helper. |
| `draft_pr_open` — draft PR created or open | `set_in_progress` | Tracker moves to in-progress (or nearest equivalent) |
| `pr_reviewable` — PR marked ready for review | `set_reviewable` | Tracker moves to reviewable / in-review (or nearest equivalent) |
| `pr_merged` — PR merged | `set_done` | Tracker moves to done/completed terminal state |
| `pr_closed_unmerged` — PR closed without merge | `none` | No automatic terminal transition; human decision required |
| `no_tracker_item` | `none` | No tracker item to update |
| `blocked_needs_user_decision` | `none` | Stop and report; no automatic tracker update |

### 4.2 Event Triggers

| PR lifecycle event | Maps to canonical state | Sync trigger |
|---|---|---|
| No PR created yet | `ready_no_pr` | No trigger |
| Draft PR creation succeeds | `draft_pr_open` | Apply `set_in_progress` to tracker |
| PR converted from draft to ready-for-review | `pr_reviewable` | Apply `set_reviewable` to tracker |
| PR merged | `pr_merged` | Apply `set_done` to tracker |
| PR closed without merge | `pr_closed_unmerged` | No automatic sync; report to user |

### 4.3 Adapter Mapping Guidance

Each tracker adapter maps the four canonical action names to its native API:

| Canonical action | Adapter responsibility |
|---|---|
| `set_in_progress` | Move item to the adapter's in-progress equivalent (e.g. "In Progress" column, status field, or state transition) |
| `set_reviewable` | Move item to the adapter's in-review / reviewable equivalent |
| `set_done` | Move item to the adapter's done/completed terminal state |
| `none` | No tracker mutation |

## 5. State Machine

The full lifecycle path for this MVP slice is:

```text
selected/ready (tracker-owned precondition; not encoded directly in this snapshot)
  -> tracker item exists, no PR   [ready_no_pr]
  -> draft PR created             [draft_pr_open]   -> tracker: set_in_progress
  -> PR marked ready for review   [pr_reviewable]   -> tracker: set_reviewable
  -> PR merged                    [pr_merged]       -> tracker: set_done
```

Alternate paths:

```text
PR closed without merge   [pr_closed_unmerged]          -> tracker: no automatic action
No tracker item, no PR    [no_tracker_item]             -> blocked; report and stop
Contradictory snapshot    [blocked_needs_user_decision] -> stop and report
```

### 5.1 State Definitions

| State | Meaning |
|---|---|
| `no_tracker_item` | No tracker work item was found; lifecycle cannot proceed |
| `ready_no_pr` | Tracker item exists and no PR has been created yet. This helper does not infer tracker-native readiness beyond that no-PR fact. |
| `draft_pr_open` | Draft PR exists; tracker should reflect in-progress |
| `pr_reviewable` | PR is open and not draft; tracker should reflect reviewable / in-review |
| `pr_merged` | PR has been merged; tracker should be moved to done/completed |
| `pr_closed_unmerged` | PR was closed without merge; no automatic tracker transition |
| `blocked_needs_user_decision` | Unexpected or contradictory state; requires explicit user decision |

### 5.2 Transition Graph

```
no_tracker_item
  (no transitions — obtain a valid tracker item first)

ready_no_pr
  -> draft_pr_open         (create a draft PR with required tracker metadata)

draft_pr_open
  -> pr_reviewable         (mark the PR as ready for review)

pr_reviewable
  -> pr_merged             (PR is merged)
  -> pr_closed_unmerged    (PR is closed without merge)
  -> draft_pr_open         (convert back to draft if rework is needed)

pr_merged
  (no transitions — terminal success state)

pr_closed_unmerged
  -> ready_no_pr           (reopen work; create a new PR)
  -> blocked_needs_user_decision  (escalate if context is unclear)

blocked_needs_user_decision
  (no transitions — stop and report; await explicit user authorization)
```

### 5.3 Snapshot Schema

| Field | Type | Description |
|---|---|---|
| `trackerItemExists` | `boolean` | Whether a tracker work item was found |
| `trackerItemId` | `string \| null` | Opaque tracker item identifier (e.g. `"PROJ-123"`) |
| `prExists` | `boolean` | Whether a GitHub PR exists for this tracker item |
| `prNumber` | `number \| null` | PR number if known. Canonical no-PR snapshots should set this to `null`; `prNumber` with `prExists=false` is treated as contradictory and blocked. |
| `prDraft` | `boolean` | Whether the PR is in draft state |
| `prMerged` | `boolean` | Whether the PR has been merged |
| `prClosed` | `boolean` | Whether the PR is closed on GitHub. Merged PRs are also closed, so `pr_closed_unmerged` is derived from `prClosed && !prMerged`. |

Unlike the Copilot/reviewer loop snapshots, this tracker contract uses `prClosed` for the raw GitHub closed state. Merged PRs therefore set both `prMerged=true` and `prClosed=true`, while `pr_closed_unmerged` remains the derived terminal state for `prClosed && !prMerged`.

This snapshot intentionally omits tracker-native workflow fields such as selected/ready, blocked, or done. Higher-level callers must combine tracker-owned readiness/state separately when deciding whether opening a PR is appropriate.

## 6. Scope Boundaries

This contract is intentionally narrower than the parent epics:

| Boundary | In scope (this slice) | Out of scope (deferred) |
|---|---|---|
| Tracker adapters | Adapter-agnostic contract only | Jira adapter, Shortcut adapter, any specific adapter |
| Artifact model | One tracker item + one PR | Multi-PR, roll-up, cross-artifact sync |
| Epic / PRD | Metadata reference links only | Automated roll-up or field sync |
| ADR / RFC | Metadata reference links only | Decision synchronization |
| Reverse sync | Four canonical states above | Tracker comment mirroring, full bidirectional field sync |
| Parent epics | Consistent with #17 and #19 | Does not re-own the umbrella artifact model |

## 7. Related

- Parent workflow-family epic: [mfittko/pi-dev-loops#17](https://github.com/mfittko/pi-dev-loops/issues/17)
- Umbrella artifact model epic: [mfittko/pi-dev-loops#19](https://github.com/mfittko/pi-dev-loops/issues/19)
- This contract (first implementable slice): [mfittko/pi-dev-loops#21](https://github.com/mfittko/pi-dev-loops/issues/21)
- Copilot loop state graph: [Copilot Loop State Graph](../../docs/copilot-loop-state-graph.md)
- Reviewer loop state graph: [Reviewer Loop State Graph](../../docs/reviewer-loop-state-graph.md)

---

## State machine integration

This document is also the canonical state-graph doc for the tracker-first loop state machine.

### Loop state machine (distinct from PR-level machine above)

Implementation:
- `packages/core/src/loop/tracker-first-loop-state.mjs` — pure logic layer (`interpretTrackerLoopState`)
- `scripts/loop/detect-tracker-first-loop-state.mjs` — CLI wrapper (same interface as `detect-copilot-loop-state.mjs`)

**Loop state vocabulary:** `drafting`, `needs_triage`, `in_progress`, `in_review`, `merge_ready`, `blocked`, `completed`, `unknown`

**Loop interface contract:** `{ ok, state, snapshot, allowedTransitions, nextAction }`

**Loop snapshot fields:**
| Field | Type | Description |
|---|---|---|
| `trackerState` | `string` | Canonical loop state |
| `rawTrackerState` | `string` | Raw input state string |
| `prLinked` | `boolean` | Whether a linked PR was found |
| `prContext` | `object \| null` | Linked PR context (number, state, headRefName) |

**Loop nextAction mapping:**
| State | nextAction |
|---|---|
| `drafting` | `triage_or_block` |
| `needs_triage` | `start_work` |
| `in_progress` | `review` |
| `in_review` | `merge_or_fix` |
| `merge_ready` | `merge` |
| `blocked` | `resolve_blocker` |
| `completed` | `done` |
| `unknown` | `reconcile` |

**Fail-closed contract:** Unrecognized/empty/garbage tracker state → `needs_triage`. Only explicit `"unknown"` → canonical `unknown` state.

**PR-level state machine** (sections 1-5 above) uses a separate vocabulary (`ready_no_pr`, `draft_pr_open`, `pr_reviewable`, `pr_merged`, `pr_closed_unmerged`, `no_tracker_item`, `blocked_needs_user_decision`) with its own snapshot schema and reverse-sync actions.
