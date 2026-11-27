# 0336. A gate fix pass pushes in the full phase and no delta review or push authority remains

## Status

Accepted — 2026-11-22 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937), operator decision of 2026-11-22).

Amends [ADR 0323](./0323-pre-push-hook-has-no-push-authority.md): the delta chain code that ADR 0323 left for issue 2937 to delete is deleted, so the delta review no longer runs. Retires [ADR 0168](./0168-draft-gate-low-nit-convergence.md) and [ADR 0253](./0253-low-nit-convergence-at-the-cap-round.md) (the low/nit convergence), [ADR 0180](./0180-post-delivery-residual-evidence-reconciliation.md) (the residual evidence snapshot), and, with the slice that deletes their code, [ADR 0143](./0143-gate-fix-push-authority.md) with its amendments [ADR 0213](./0213-complete-fixer-checkpoint-carry-and-pre-push-closure.md) and [ADR 0219](./0219-sanctioned-close-of-an-abandoned-gate-fix-sequence.md) and their amenders [ADR 0229](./0229-close-sequence-admission-is-atomic-and-liveness-is-activity-based.md) and [ADR 0286](./0286-delta-sequence-ends-at-an-agent-step-and-pr-body-items-leave-the-act-set.md). Accepted records stay unchanged beyond their Status sections.

## Context

Every act-list and thread fix pass ran a `commit_only` phase, a delta reviewer, a sealed delta record and a delta decision before the full phase could push. The next gate round reviews the pushed head anyway. The v1.0.12 retro counted three parks that came from delta refusals: a delta that bounded out after three invocations, a delta range that could not bind after a base merge, and a delta that spent all three invocations on missing coverage fields. Seventeen issues describe dead ends of the same mechanism. ADR 0323 already removed the hook that enforced push authority, so the delta no longer protected anything it was built to protect.

The operator decided on 2026-11-22 to delete the delta as push authority.

## Decision

- A gate fix pass uses the existing full fixer phase. The fixer commits, pushes, confirms the remote head, waits for CI and writes a one-line handoff. A full emission takes no delta result, reads no delta record and writes no sequence marker.
- The next gate round at the pushed head judges the fix. The round re-checks each review thread that the fix pass resolved: the reviewer raises a thread again when its fix is missing at that head.
- No replacement tool, check or record is added. The accepted loss is that a bad fix costs one gate round and one CI run.
- The low/nit convergence is deleted with its ADR 0168 and ADR 0253 records. An all-low/nit cap round goes to the fixer and then to the scoped final round. The body-only converged post stays as the exit of a body-only act list.
- The residual evidence snapshot of ADR 0180 is deleted. A fix that a later gate round judges closes its thread through the verdict path.
- The rule `PRE-PUSH-DELTA-TRIGGER` is deleted. The delta code that is left (the checker CLI, push authority, `gate close-sequence`, the `commit_only` phase, the seal and the review core) is deleted leaf first in the following slices of issue 2937. Each of those slices edits only the Status sections of this record and of the retired records whose code it deletes.
- No state on disk needs a migration. After the delta reads are gone no code reads a marker or a record under `tmp/gate-delta/`.

Rejected: keeping the delta as an advisory step (it keeps every record, seal and refusal for no authority), a new "fixes to re-check" section in the reviewer input (a full round already reviews the whole PR diff), and a replacement push check (the operator ruled it out).

## Consequences

A fix commit reaches the PR head before any review of that fix. The next gate round, the CI run and the merge gate bound that exposure. A fix pass can no longer deadlock on a delta refusal, and a fixer needs no sequence state. The deletion removes about 5400 weighted lines over five slices, almost all of them code and tests. Later slices record their progress in the Status section of this record and flip each retired record to Superseded when they delete its code.
