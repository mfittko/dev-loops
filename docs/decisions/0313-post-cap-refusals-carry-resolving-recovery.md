# 0313. The two post-cap refusals each carry a distinct, resolving recovery

## Status

Accepted — 2026-11-21 ([issue 3437](https://github.com/mfittko/dev-loops/issues/3437))

## Context

A cap round whose fixer handed back `ci_failed` left the operator in a cycle. The `check-pre-push-delta --reviewer-only` prior-record refusal named `gate extend-cap-round-chain`, and the `extend-cap-round-chain` refusal named a reviewer-only run that the first refusal then rejected. Neither refusal carried a `recovery` field, so `RECOVERY-COMMAND-REQUIRED` was not met. The `formatCliError` helpers dropped any `recovery` an error carried.

## Decision

- Each of the two post-cap refusals carries one `recovery` command that resolves the case it refuses, and the two commands differ.
- The `check-pre-push-delta --reviewer-only` prior-record refusal sets `recovery` to `gate extend-cap-round-chain --repo <repo> --pr <n>` when the cap round's act items are cleared, and to the replacement-PR operator form when the cleared record's candidate is off the PR head's history.
- The replacement-PR restart is an operator decision (ADR 0255), so every refusal that names it (`baseline_orphaned`, the non-covering sealed cap-round record and the reviewer-only prior-record refusal) sets `recovery` to `operator:` followed by the full procedure: push HEAD to a new branch, record the pre-PR review, run `pr create --head <new-branch> --allow-replacement-pr <n>` while the PR is open, then close the PR. One shared helper (`replacementPrOperatorRecovery`) renders it for `extend-cap-round-chain` and `check-pre-push-delta`.
- The `extend-cap-round-chain` `no_cap_round_chain` refusal sets `recovery` by case:
  - No cap round resolves (fewer closed `draft_gate` rounds than the cap, or an unreadable ledger): `loop gate-coordination --repo <repo> --pr <n>`. No chain exists to extend, and the next `draft_gate` round is not refused.
  - The cap-round head is not in this clone: `git fetch origin <cap-round-head-sha>` (`git fetch --unshallow` first when the clone is shallow).
  - A sealed record at the cap-round head does not cover the cap round's act set: the replacement-PR operator form. That record is never overwritten, so a reviewer-only run at that head refuses.
  - The cap-round head is the PR head: no commit follows it and `check-pre-push-delta` refuses a reviewer-only run whose baseline equals the head, so `recovery` is `operator: push one docs or tests commit to the PR branch, then rerun gate extend-cap-round-chain ...`.
  - No record at the cap-round head: a reviewer-only run at that head (`loop pre-push-delta --reviewer-only --baseline <cap-round head> ...`).
- The `chain_reaches_head` refusal sets the same head-moving `operator:` recovery, because a rerun at the unchanged head refuses again. One helper (`headMovingRecovery`) renders it for both cases.
- The `delta_range_mismatch` and `logic_commit_in_range` refusals set `recovery` to the reviewer-only run from the start of the logic range.
- `emit-fixer-work-order` asks `resolveCapRound`, the cap resolver that `gate-coordination` and `extend-cap-round-chain` use, whether a cap round is closed. With no closed cap round, no unreadable prior ledger, no blocked verdict posted at the head, a blocked-verdict probe that succeeds and one artifact root (the `--tmp-root` is the main-anchored root the cap resolver reads), a head without its own ledger is the round being posted and is not past the cap, so the emitter checks the act list alone instead of refusing `round_cap_reached`. Otherwise a missing cap-round ledger still refuses, so ledger-only blockers apply. The cap is unchanged.
- No `extend-cap-round-chain` refusal leaves `recovery` undefined. `repo_mismatch` with an unresolved origin slug returns `operator: run from a clone whose origin is <--repo>, then rerun`. `head_mismatch` returns one of three recoveries: `git -C <worktree> pull --ff-only origin <pr-head>` (addressed to the resolved worktree) only when the worktree is on the PR branch and its HEAD is an ancestor of the PR head or the PR head is absent locally, `operator: push the local commits to the PR branch ...` for an ahead or diverged worktree on the PR branch, and `operator: check out the PR branch ... and rerun with --worktree <that worktree>` on any other branch or a detached HEAD, because the pull would move the wrong ref.
- Both `formatCliError` implementations (`scripts/lib/format-cli-error.mjs` and `packages/core/src/github/review-threads.mjs`) copy a string `recovery` from the error onto the CLI payload.
- The `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND` paragraph in `skills/docs/gate-review-sub-loop-contract.md` states these cases.

## Consequences

No post-cap refusal sends the operator back to the command that refused it. The refusal audit in `docs/refusal-recovery-audit.md` no longer lists these refusals as gaps. A new post-cap refusal case needs its own resolving `recovery` and a test in `test/loop/extend-cap-round-chain.test.mjs`.
