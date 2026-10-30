# 0216. Cap-round chain end, named refusal conditions, no-commit sequence close and single-child join

## Status

Accepted — 2026-10-30 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462), operator scope decision for Slice A).

Builds on ADR 0197, ADR 0208 and ADR 0213. Accepted records remain unchanged.

## Context

PR 2992 reached four blockers. A base merge after the cap-round fixer commit read as round cap+1. The cap-round refusal named one catch-all remedy for four different conditions. A `commit_only` fixer without a commit left a stale sequence marker that the push refusal told the operator to delete by hand. A coordinator ended its turn while a single child ran.

## Decision

1. Chain-end base-only rule. `resolveCapRoundFixed` accepts a head M when the chain's last sealed clearing record names candidate B and M is a base-only merge since B (`isBaseOnlyMergeSince` against `origin/<baseRefName>`). `emit-fixer-work-order.mjs` applies the ADR 0197 base-only rule against the chain's last candidate B as well as the cap-round head, so M is the cap round. A merge that changes the PR-own patch, or a missing `baseRefName`, fails closed. The ADR 0197 rule and the sealed delta record format are otherwise unchanged.
2. Named refusal conditions. The cap-round refusal of `pr-gate-coordination.mjs` names the one failed condition and its remedy: `no_clearing_record`, `unsealed_record`, `items_do_not_cover`, `chain_does_not_reach_head` or `cap_round_unresolved`. `cap_round_unresolved` means the cap round could not be resolved (an unreadable findings ledger or config, no cap round with a verdict, or a resolver throw); `resolveCapRoundFixed` reports it on its null return and the detector reports it from its rejection handler. The refusal falls back to `cap_round_unresolved` when no condition is reported. `resolveCapRoundFixed` reports the condition through its `onFailure` callback.
3. No-commit sequence close. The remedy for the `PRE-PUSH-DELTA-PUSH-AUTHORITY` refusal is the existing authenticated no-commit closure of `check-pre-push-delta.mjs` (input-only, `--fixer-plan`, `--site-coverage`, outcome `no_commit`). The refusal names that command with the marker's baseline head, in both the act-list and the threads-file route form (the marker records no route), and no longer names marker deletion. A marker that names no branch (unreadable or malformed) cannot be authenticated by that close, so its refusal names no close command and no deletion; it says the marker names no branch and that the `PRE-PUSH-DELTA-PUSH-AUTHORITY` rule owns its recovery. No new subcommand is added.
4. Single-child join. On Claude Code a coordinator joins one child with `gate wait-for-units --artifact <path>`, a single-unit mode that returns `all_done` only for a final hand-back (the artifact parses as JSON and carries the terminal field its schema requires, for example `outcome` on a DeltaPrePushReviewResult, or, with no terminal field, stays unchanged for 10 seconds; the child writes no marker) and `timeout` with the remedy otherwise. Under this rule an interim parseable write without the terminal field leaves the join pending. The hand-back path must not exist at dispatch: each fixer emission and each delta review invocation gets its own path, and the coordinator never reuses a hand-back path, because the join cannot tell a stale file from the current child's. The rule `COORDINATOR-SINGLE-CHILD-JOIN` forbids ending the turn before the join returns. Pi keeps the blocking dispatch (`async: false`), `runs.all` or `bg_wait`.

## Consequences

A base merge after a cleared cap-round fix reaches `mark_ready_for_review`. Each cap-round refusal carries one actionable remedy. A stale sequence marker closes through a sanctioned command. A single child gets a deterministic join on Claude Code.
