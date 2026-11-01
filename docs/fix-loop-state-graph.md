# Fix Loop State Graph

Canonical owner for the gate fix-loop state machine ([ADR 0166](decisions/0166-liveness-first-fixer-lifecycle-requirements.md), [issue 2787](https://github.com/mfittko/dev-loops/issues/2787)).

## Overview

One fix sequence for PR head H is one state machine. Every fail-closed state has a sanctioned exit, and the conformance harness (`scripts/docs/validate-state-machine-conformance.mjs`) proves that every state reaches a terminal state. Evidence binds to the live head whichever role made the commit: a developer commit, a CI fix, a base merge or an amend is the `head_moved` state with a defined exit.

A transition that a later slice of issue 2787 implements is registered as `known_gap` in the harness until that slice lands. Slice 6 re-arms the fail-closed boundary only when no `known_gap` is left.

Open-thread descendant delivery keeps the authenticated candidate X and fixing commit separate from live head H. The verifier looks up each authenticated thread root's original RIGHT-side range, maps it through linear history to X, then rejects any overlapping commit in X..H, including a touch later reverted. Unrelated edits in the same file and earlier-line offsets pass. LEFT-side, missing or uncertain coordinates, deleted/binary files and nonlinear history refuse with `thread_site_unverifiable`; overlap refuses with `thread_site_changed`. Both refusals name the thread for a full `pre_approval_gate` round through `--known-findings`, without a live-head-baseline Delta. This input does not bypass draft-boundary admission: unresolved gate-authored threads can still prevent the round from starting. Successful delivery verifies H's CI and live resolution. A gate verdict requires its own full review.

The C19 replays cover descendant delivery and known-findings intake with a satisfied draft boundary; they do not prove recovery admission with unresolved gate-authored threads. The `head_moved` and `no_commit` full-gate edges therefore remain `known_gap`, alongside CI-source intake, delta residue intake and completion re-entry. Recovery admission is deferred until PR #2990 merges, as recorded in [issue 2787's operator decision](https://github.com/mfittko/dev-loops/issues/2787#issuecomment-6513403927).

Implementation: `packages/core/src/loop/fix-loop-state.mjs` (`FIX_LOOP_STATE`, `FIX_LOOP_TRANSITIONS`, `normalizeFixLoopSnapshot`, `interpretFixLoopState`).

## State Definitions

| State | Meaning |
|---|---|
| `act_pending` | A posted verdict at H holds act items, unresolved threads or a red CI result |
| `commit_only_emitted` | Sequence marker written; the fixer works unpushed |
| `no_commit` | The fixer made no commit |
| `candidate_committed` | Candidate C committed on top of H |
| `delta_review` | Delta review of H..C |
| `full_emitted` | Push granted for C |
| `pushed` | Remote head equals C |
| `ci_red` | CI failed on C |
| `ci_green` | CI green on C |
| `delivery_incomplete` | Report missing, stale or superseded |
| `disposition_complete` | Tool-built report verified at C or carried to a descendant |
| `head_moved` | A commit not made by the active order landed (developer, CI fix, base merge, amend) |
| `full_gate_round` | The gate reviews the live head in full (terminal) |
| `stopped` | Operator stop (terminal) |

## Required transitions

Terminal states with no outgoing transitions: `full_gate_round`, `stopped`.

- `act_pending` -> `commit_only_emitted`
- `commit_only_emitted` -> `candidate_committed`
- `commit_only_emitted` -> `no_commit`
- `commit_only_emitted` -> `head_moved`
- `no_commit` -> `full_gate_round`
  - the sequence closes and the marker is removed
- `candidate_committed` -> `delta_review`
- `candidate_committed` -> `head_moved`
- `delta_review` -> `full_emitted`
  - the delta is clear or `bounded_out`
- `delta_review` -> `commit_only_emitted`
  - residue or a new finding re-enters a commit_only order
- `delta_review` -> `head_moved`
- `full_emitted` -> `pushed`
- `full_emitted` -> `head_moved`
- `pushed` -> `ci_green`
- `pushed` -> `ci_red`
- `pushed` -> `head_moved`
- `ci_red` -> `act_pending`
  - the CI failure is the source of the next order
- `ci_red` -> `head_moved`
- `ci_green` -> `disposition_complete`
- `ci_green` -> `delivery_incomplete`
- `ci_green` -> `head_moved`
- `delivery_incomplete` -> `disposition_complete`
  - completion re-entry at the live head
- `delivery_incomplete` -> `full_gate_round`
- `delivery_incomplete` -> `head_moved`
- `disposition_complete` -> `full_gate_round`
- `disposition_complete` -> `head_moved`
- `head_moved` -> `full_gate_round`
  - the sequence closes and the marker is removed
- `head_moved` -> `disposition_complete`
  - descendant carry of a complete checkpoint (`ahead` only)

## Snapshot Contract

`normalizeFixLoopSnapshot` canonicalizes booleans and enums:

- exits: `stopped`, `headMoved`, `sequenceClosed`, `dispositionCarried`, `fullGateStarted`
- sequence: `actPending`, `markerWritten`, `noCommit`, `candidateCommitted`
- delta: `deltaReviewStarted`, `deltaVerdict` (`clear`|`bounded_out`|`residue`|null)
- delivery: `pushGranted`, `pushed`, `ciStatus` (`pending`|`green`|`red`), `reportStatus` (`none`|`complete`|`stale`|`superseded`)

`interpretFixLoopState` returns `{ state, allowedTransitions, nextAction, reason }`. `reason` is `descendant_carry`, `delta_residue` or null. A `residue` delta verdict with a committed candidate and no push grant resolves to `commit_only_emitted`. At green CI, `reportStatus` `none` is `ci_green` because the report is not yet constructed. Only `stale` or `superseded` reach `delivery_incomplete`. The missing-after-stop case (E11) gets its snapshot field in slice 5. Precedence: `stopped`, then a started full gate round, then `headMoved`, then `noCommit`, then the pushed branch (CI and report), then `pushGranted`, then `candidateCommitted`, then the marker, then `actPending`. With no open sequence and no act items the head goes to `full_gate_round`, the fallback authority. A closed sequence after `head_moved` or `no_commit` resolves to `full_gate_round`.

Contradictory snapshots resolve by that order. These winners are pinned by tests:

- `fullGateStarted` wins over `headMoved`: the state is `full_gate_round`.
- `headMoved` with `dispositionCarried` gives `disposition_complete` (reason `descendant_carry`).
- `dispositionCarried` without `headMoved` is ignored.
- `noCommit` wins over `pushed`: the state is `no_commit`.
- `pushGranted` wins over `candidateCommitted` residue: the state is `full_emitted`.
