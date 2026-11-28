# 0339. A low cluster floors at reject from draft round 2

## Status

Accepted — 2026-11-28 ([issue 3649](https://github.com/mfittko/dev-loops/issues/3649)).

Amends [ADR 0188](./0188-low-nit-never-block.md) for the `draft_gate` low case only: a `low` cluster no longer stays `act` below the round cap and no longer floors at `defer` at or past the cap. It floors at `reject` from round 2 on, the same as a `nit` cluster. Amends [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) for the same case: the past-cap low floor is `reject`, not `defer`. The records that introduced those rules stay unedited.

## Context

ADR 0188 floored a `nit` cluster at `reject` from draft round 2 on and fixed a `low` in every round until the cap. ADR 0196 floored a `low` at `defer` at `pre_approval_gate`. ADRs 0251 and 0252 made the cap a soft cap, and ADRs 0189 and 0191 fixed how the round is counted and made a past-cap medium disposition final. A `defer` needs a follow-up issue, so in practice lanes fixed every low.

A consumer repo measured the cost on 2026-11-27. An 11-line PR ran 4 draft rounds, and rounds 2 to 4 held only lows. Each round cost a fix, a sealed delta review, a push and about 25 minutes of CI, about 3 hours in total. A deferred low becomes a follow-up issue that grows the backlog.

## Decision

- From `draft_gate` round 2 on, `applyJudgeDispositions` rewrites an `act` or a `defer` on a cluster of only `low` and `nit` members that holds a `low` to `reject`, in every round, the cap round and the rounds past it included. The reason is `low_floor (GATE-EXEC-LOW-ROUND-FLOOR)`. Round 1 keeps the judged disposition. A judged `reject` keeps its own reason.
- Three exceptions keep the judged disposition of a low cluster at every round. The judge sets the optional disposition field `lowException` to `unmet_ac` (the low names an unmet acceptance-criteria row of the linked spec), `regression` (the low names a regression) or `security` (the judge marks the low a security item). Any other value fails the verdict closed.
- `failOpen: true` on a low act keeps its promotion to `medium` and stays `act` (ADR 0188).
- `GATE-EXEC-LOW-FIX-UNTIL-CAP` is removed. Its `pre_approval_gate` behavior (a low defers, an all-`nit` cluster rejects, the fixer emitter refuses a low or nit only act list) is unchanged and lives under `GATE-EXEC-LOW-ROUND-FLOOR`. The reason and refusal code `low_fix_until_cap` is renamed `low_floor`.
- `pre_approval_gate` severity handling and the reviewers' severity assignment are unchanged. No repo setting controls the floor.

Rejected: an opt-in setting such as `gates.draft.lowFloor` (a config key, its validation and a second code path) and a floor at `defer` (each defer becomes a follow-up issue).

## Consequences

A low-only draft round from round 2 on composes with no act item for the fixer, so it converges without a fix, delta review, push and CI cycle. A real low the judge does not mark with an exception is rejected and not tracked. The judge carries the burden of marking a low that names an unmet AC row, a regression or a security item.
