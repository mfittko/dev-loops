# 0313. The two post-cap refusals each carry a distinct, resolving recovery

## Status

Accepted — 2026-11-21 ([issue 3437](https://github.com/mfittko/dev-loops/issues/3437))

## Context

A cap round whose fixer handed back `ci_failed` left the operator in a cycle. The `check-pre-push-delta --reviewer-only` prior-record refusal named `gate extend-cap-round-chain`, and the `extend-cap-round-chain` refusal named a reviewer-only run that the first refusal then rejected. Neither refusal carried a `recovery` field, so `RECOVERY-COMMAND-REQUIRED` was not met. The `formatCliError` helpers dropped any `recovery` an error carried.

## Decision

- Each of the two post-cap refusals carries one `recovery` command that resolves the case it refuses, and the two commands differ.
- The `check-pre-push-delta --reviewer-only` prior-record refusal sets `recovery` to `gate extend-cap-round-chain --repo <repo> --pr <n>` when the cap round's act items are cleared, and to the replacement-PR command when the cleared record's candidate is off the PR head's history.
- The `extend-cap-round-chain` `no_cap_round_chain` refusal sets `recovery` by case:
  - No cap round resolves (fewer closed `draft_gate` rounds than the cap, or an unreadable ledger): `loop gate-coordination --repo <repo> --pr <n>`. No chain exists to extend, and the next `draft_gate` round is not refused.
  - A sealed record at the cap-round head does not cover the cap round's act set: the replacement-PR command (`pr create --head <new-branch> --allow-replacement-pr <n>`). That record is never overwritten, so a reviewer-only run at that head refuses.
  - No record at the cap-round head: a reviewer-only run at that head (`loop pre-push-delta --reviewer-only --baseline <cap-round head> ...`).
- The `delta_range_mismatch` and `logic_commit_in_range` refusals set `recovery` to the reviewer-only run from the start of the logic range.
- Both `formatCliError` implementations (`scripts/lib/format-cli-error.mjs` and `packages/core/src/github/review-threads.mjs`) copy a string `recovery` from the error onto the CLI payload.
- The `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND` paragraph in `skills/docs/gate-review-sub-loop-contract.md` states these cases.

## Consequences

No post-cap refusal sends the operator back to the command that refused it. The refusal audit in `docs/refusal-recovery-audit.md` no longer lists these refusals as gaps. A new post-cap refusal case needs its own resolving `recovery` and a test in `test/loop/extend-cap-round-chain.test.mjs`.
