# 0311. draft_gate fans out only on settled green current-head CI

## Status

Accepted — 2026-11-21 ([issue 3414](https://github.com/mfittko/dev-loops/issues/3414))

## Context

A draft_gate round fanned out reviewers while current-head CI was pending or red. The round then spent reviewer work on a head that had to change, and a verdict post refused for red CI dropped the act list the round had produced.

## Decision

- `draft_gate` fans out reviewers only when current-head CI is settled and green. Pending CI waits. Red CI routes to the CI-fix route.
- A verdict post that is refused for red CI hands back `fix_ci_failure` and keeps the act list in the hand-back.
- `emit-fixer-work-order` accepts `--ci-file` together with `--act-list-file`, so one fixer work order covers the CI failure and the act items.
- The combined `--ci-file` plus `--act-list-file` order is a full-phase `ci-failure` order. It has no `commit_only` phase, no pre-push delta review and no site-coverage check, so it carries no `siteCoverage` skeleton. The next full gate round is the check of the carried act items. The emitter refuses a carried act list unless each item is an act finding of the head's round ledger (`stale_act_list`).
- The combined order is a second exception to `GATE-EXEC-POST-BEFORE-FIX`: the verdict post was refused for red CI, so no verdict review exists on the PR, and the `stale_act_list` binding of each item to the head's round ledger replaces the posted-verdict trail. The code path is unchanged.
- `emit-fanout-dispatch.mjs` requires `--ci-file` for `--gate draft_gate` unless `gates.draft.requireCi` is false, and accepts only `ciStatus` `success` as green, as gate coordination does. An unreadable `--ci-file` is a usage error (exit 2), not unsettled CI.
- The contract docs `skills/docs/gate-review-sub-loop-contract.md` and `skills/docs/main-agent-contract.md` state this rule.

## Non-goals

- Changing reviewer angles, the judge or the merge gate.

## Consequences

No reviewer round runs on a head with red or unsettled CI. The fixer fixes CI and act items in one pass. Callers that read the refusal hand-back see `fix_ci_failure` with the act list.
