# Fix Loop State Graph

Canonical owner for the gate fix-loop state machine ([ADR 0166](decisions/0166-liveness-first-fixer-lifecycle-requirements.md), [issue 2787](https://github.com/mfittko/dev-loops/issues/2787)).

## Overview

One fix sequence for PR head H is one state machine. Every fail-closed state has a sanctioned exit, and the conformance harness (`scripts/docs/validate-state-machine-conformance.mjs`) proves that every state reaches a terminal state. Evidence follows the head, not the role that made the commit: a developer commit, a CI fix, a base merge or an amend is the `head_moved` state with a defined exit.

A transition that a later slice of issue 2787 implements is registered as `known_gap` in the harness until that slice lands. Slice 6 re-arms the fail-closed boundary only when no `known_gap` is left.

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
- `ci_red` -> `act_pending`
  - the CI failure is the source of the next order
- `ci_green` -> `disposition_complete`
- `ci_green` -> `delivery_incomplete`
- `delivery_incomplete` -> `disposition_complete`
  - completion re-entry at the live head
- `delivery_incomplete` -> `full_gate_round`
- `disposition_complete` -> `full_gate_round`
- `head_moved` -> `full_gate_round`
  - the sequence closes and the marker is removed
- `head_moved` -> `disposition_complete`
  - descendant carry of a complete checkpoint (`ahead` only)

## Snapshot Contract

`normalizeFixLoopSnapshot` canonicalizes booleans and enums:

- heads: `headSha`, `candidateSha`
- exits: `stopped`, `headMoved`, `sequenceClosed`, `dispositionCarried`, `fullGateStarted`
- sequence: `actPending`, `markerWritten`, `noCommit`, `candidateCommitted`
- delta: `deltaReviewStarted`, `deltaVerdict` (`clear`|`bounded_out`|`residue`|null)
- delivery: `pushGranted`, `pushed`, `ciStatus` (`pending`|`green`|`red`), `reportStatus` (`none`|`complete`|`stale`|`superseded`)

`interpretFixLoopState` returns `{ state, allowedTransitions, nextAction, reason }`. Precedence: `stopped`, then a started full gate round, then `headMoved`, then `noCommit`, then the pushed branch (CI and report), then `pushGranted`, then `candidateCommitted`, then the marker, then `actPending`. With no open sequence and no act items the head goes to `full_gate_round`, the fallback authority. A closed sequence after `head_moved` or `no_commit` resolves to `full_gate_round`.
