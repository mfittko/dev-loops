# 0325. A coordinator continues at a routine boundary and hands back at a stop

## Status

Accepted — 2026-11-26 ([issue 3097](https://github.com/mfittko/dev-loops/issues/3097)).

Supersedes in part [0274](0274-coordinator-round-boundary-handback.md): the decision that a coordinator hands back at every gate-round end and fix-pass end. Accepted records remain unchanged.

## Context

ADR 0274 ended every run at a gate-round end and a fix-pass end, to bound the context a long run carries. The v1.0.12 retro counted 387 coordinator dispatches and resumes for 122 gate rounds, about 3.2 per round. Most boundaries were routine: the next action was the next gate round, the fix pass, the ready flip or the `pre_approval_gate` round. Each fresh coordinator re-ran `loop startup`, the `loop gate-coordination` pre-flight and the runner claim.

## Decision

`COORDINATOR-ROUND-BOUNDARY-HANDBACK` keeps its ID and changes to continue at a routine boundary and hand back at a stop. `loop gate-coordination` is the next-step driver; no command is added. `scripts/loop/_coordinator-handback.mjs` exports `ROUTINE_NEXT_ACTIONS` (`run_draft_gate`, `address_review_feedback`, `mark_ready_for_review`, `run_pre_approval_gate`, `wait_for_ci`) and `ROUTINE_BOUNDARY_CAP` (3). The hand-back packet gets the optional integer `routineBoundaries`, counted in the coordinator's context and never persisted. `validateCoordinatorHandback` refuses a round-boundary packet with a routine `nextAction` below the cap (`routine_boundary`). The context bound of ADR 0274 becomes the cap. Every gate round still runs in a fresh gate-coordinator child and every fix pass in a fresh fixer child. The `loop gate-coordination` reason texts name `dev-loops pr ready-for-review`, never raw `gh pr ready`.

## Consequences

- A run crosses up to three routine boundaries before it hands back. A stop action, the `ci_red` verdict refusal and every other run-ending case still hand back.
- The count is self-attested. A crash or a replacement starts at 0 and re-derives gate state from the detectors.
- No persisted state is added.
