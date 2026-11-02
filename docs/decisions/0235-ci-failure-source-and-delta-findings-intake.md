# 0235. A CI failure and delta review findings can enter a fixer work order

## Status

Accepted — 2026-11-02. Amends [ADR 0166](0166-liveness-first-fixer-lifecycle-requirements.md) requirement 3 (findings outside the act list can enter a fixer order) and [ADR 0233](0233-fixer-work-order-from-review-body.md) (the review-body decision names three fixer sources; this record adds a fourth).

## Context

Issue [2787](https://github.com/mfittko/dev-loops/issues/2787) slice 4 closes two lockouts of the fix loop. A red CI result on a pushed candidate had no fixer source (events E6; PRs 2814, 2820, 2842). A new finding from the pre-push delta review on the thread route had no fixer source either, because the sealed delta record kept only `items[{ref,status}]` (event E9; PRs 2813, 2822; issue 3019 item 7). Both forced developer commits that the push authority then refused.

## Decision

- `emit-fixer-work-order.mjs` accepts `--ci-file <path>` as a fourth source, source name `ci-failure`. Exactly one of `--act-list-file`, `--threads-file`, `--review-id` and `--ci-file` is required. `--gate` and `--delta-result` stay valid only with `--act-list-file`.
- The file is the JSON of `wait-pr-checks.mjs`. The emitter refuses (exit 1, no write) a file that is not `ok`, has `status` or `ciStatus` other than `failure`, has a `headSha` other than `--head-sha`, or has no `failedChecks[].name` (a name must hold a non-blank character), more than 50 `failedChecks` entries, or a name over 200 characters. Each refusal names the next action.
- A CI failure has no delta route. The emitter takes it only with `--phase full`, reads no delta record and skips `assertDeltaClearsFullPhase`. A CI-only fix carries no review finding. `--phase commit_only` refuses and names `--phase full`.
- The order has no verifier step. It tells the fixer to fix only what the failing checks report, commit and push, confirm the remote head, wait for green CI and write the handoff `{ "headSha": "<full pushed SHA>" }` to the outputRef as the last step. The fixer posts no reply and resolves no thread. On red CI it hands back `ci_failed` with the failing check names.
- `joinRef` of a `ci-failure` plan is the outputRef itself. The gate detector skips the fixer-disposition verifier check for such a plan, because a CI fix has no thread to verify. Delivery evidence is the settled green CI plus the full gate round on the new head (ADR 0166 requirement 5). The re-arm slice (issue 2787 slice 6) must handle the `ci-failure` source.
- The delta-before-push review that the F7 comment of issue 2787 asks for is not adopted. It would be a separate decision.
- `check-pre-push-delta --result` persists the findings a commit_only fixer must act on into the sealed delta record as `findings[]`: every medium-or-higher `newFindings` entry without `residueOf`, and every open residue. The field is present only when the list is non-empty.
- The thread-route emitter with `--phase commit_only` reads `findings[]` from the delta record it already pins. It validates the shape (an array of at most 20 entries, strings only, each at most 2000 characters) and refuses otherwise. It carries the findings in the work order as `deltaFindings` and renders them as act items. The full phase still refuses a non-clearing record through `assertDeltaClearsFullPhase`. The next delta reviews the cumulative range, as on the ACT route. The ACT route is unchanged.

## Consequences

A red CI result and a delta finding on the thread route each reach a fixer through the existing pull protocol. The transitions `ci_red->act_pending` and `delta_review->commit_only_emitted` leave the known-gap list of the fix-loop state machine. ADR 0106 needs no amendment.
