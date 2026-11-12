# 0271. A cap round whose act items are all PR-body items clears with a body-only converged post

## Status

Accepted, 2026-11-12 ([issue 3105](https://github.com/mfittko/dev-loops/issues/3105), slice 5e `cap-round-body-only`; evidence: PR 3179 and PR 3190 hit this state, and the targeted tests in `test/github/upsert-checkpoint-verdict-converged.test.mjs`, `packages/core/test/converged-draft-gate.test.mjs` and `packages/core/test/converged-draft-gate-coordination.test.mjs` pass).

Amends the remedy row "Head equal to the baseline, or no PR-own commit, with open act items" of [ADR 0255](./0255-code-range-delta-without-fixer-plan.md) (as amended by [ADR 0261](./0261-sealed-delta-record-never-deleted.md)). Every other decision of those records stays in force, and both records stay unedited.

## Context

A cap round whose open act items are all PR-body items has no exit. The fix is a PR-body edit, so it produces no commit and no clearing chain. `gate extend-cap-round-chain` refuses `no_cap_round_chain`. `loop pre-push-delta --reviewer-only` refuses a range with no PR-own commit. A same-head body-only rerun is refused `round_cap_reached` (round 5, cap 4, `GATE-EXEC-BODY-ONLY-RERUN`). The ADR 0255 remedy row asks for a commit that does not exist. PR 3179 and PR 3190 hit the state, and the only exit was the replacement-PR restart, which discarded four draft rounds (`GATE-EXEC-NO-DEAD-END`, parent `PURPOSE-STEER-NOT-TRAP`).

## Decision

1. `upsert-checkpoint-verdict.mjs --converged-json` accepts `{ fixerCommit, actList, bodyOnly: true }` with no `deltaResult`. It posts the converged record at the reviewed head through the existing converged path. `fixerCommit` equals the current PR head, so one path covers an unchanged head and a head moved by a base-only merge. The posted comment carries the existing `**Converged:**` line, so the coordination detector needs no change. The delta digest of that line is the sha256 of the body-only evidence (the two body digests and the act list), never a fabricated delta result.
2. The tooling checks only narrow facts (`PURPOSE-DETERMINISTIC-FIT`). Each failed check refuses with a typed reason that names the item or the fact:
   - `body_item_locatable`: an act item names a file (`resolveFindingFile`).
   - `body_unchanged`: the live PR body digest equals the `pr-body` read the cap round reviewed (ADR 0256, amended by ADR 0257).
   - `body_read_unrecorded`: no cap-round context records a `pr-body` read at the reviewed head. `write-gate-context.mjs` refuses a rerun at the cap head, so the refusal names the one exit an orchestrator can drive without the operator: fix the items with a commit and run `check-pre-push-delta.mjs --reviewer-only`. The same refusal covers an ambiguous read: two same-head contexts under different roots that record different digests, or one that cannot be read (truncated or unreadable). The message names every context path with its digest; remove the stale or broken file it names, or take the commit exit. No body-only exit exists when the recorded read is lost.
   - `own_commit_in_range`: the range from the reviewed head to `fixerCommit` holds a PR-own commit (the count `check-pre-push-delta.mjs` uses).
   - `blocked_item`: an act item is `high`, `question`, fail-open, of a missing or unknown severity or from a security angle (`security`, a prefixed one such as `renderer-security`, with or without a `-delta-at-<sha>` suffix), or the cap-round blocking set (`pastCapBlockers`: a deferred high or fail-open item, a missing disposition, a severity disagreement) is non-empty.
   - A `bodyOnly` input that also carries a `deltaResult` is refused.
3. The tooling does not check that the body edit resolves an item. `pre_approval_gate` reads the final body in full.
4. A same-head body-only rerun at the cap head stays refused `round_cap_reached`, because round counting belongs to issue 3080. The refusal texts of `write-gate-context.mjs` and `upsert-checkpoint-verdict.mjs`, and the `FIXER_REMEDY` text of `check-pre-push-delta.mjs`, name the body-only converged post.
5. The remedy row of ADR 0255 now reads: "Head equal to the baseline, or no PR-own commit, with open act items: a fix commit then the reviewer-only delta; when every open act item is a PR-body item, edit the PR body and post the body-only converged verdict (decision 1)."

## Consequences

A PR-body cap round clears with no commit and no replacement PR. The rule `GATE-EXEC-NO-DEAD-END` is registered in `skills/docs/gate-review-sub-loop-contract.md` and `skills/docs/required-rules.json`. A low-value body edit can pass the poster, and `pre_approval_gate` is the backstop.
