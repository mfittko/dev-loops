# 0241. Completion-only re-entry and the commit-only supersede guard

## Status

Accepted — 2026-11-03 ([PR 3044](https://github.com/mfittko/dev-loops/pull/3044)). Amends [ADR 0155](0155-advisory-fixer-disposition-boundary.md) (the incomplete-delivery warning stays advisory until slice 6 re-arms it). Builds on [ADR 0166](0166-liveness-first-fixer-lifecycle-requirements.md) and [ADR 0233](0233-fixer-work-order-from-review-body.md); their bodies stay unedited.

## Context

Issue [2787](https://github.com/mfittko/dev-loops/issues/2787) registers the fix-loop transitions in `docs/fix-loop-state-graph.md`. Before slice 5, the `delivery_incomplete` to `disposition_complete` edge was a `known_gap`. A full plan whose fixer pushed the candidate but wrote no report had no sanctioned way back to delivery. A coordinator could only emit a new `--phase commit_only` order at the same head, which superseded the incomplete plan and dropped its delivery evidence. A judge pass that rewrote the act list with `--out` also broke the fixer byte checks, because the emitter compared paths and read the shared act-list file. PR [3044](https://github.com/mfittko/dev-loops/pull/3044) carries slice 5 and changes `skills/docs/gate-review-sub-loop-contract.md`.

## Decision

- `emit-fixer-work-order.mjs --completion-only` is the exit from `delivery_incomplete` to `disposition_complete`. It requires phase `full` and exactly one source, with no `--delta-result`, `--allowed-path` or `--operator-focus-file`; the plan pins them.
- Completion-only re-enters a plan only when the fixer report is missing or predates the pull. The emitter reads this from `verifyPulledResult` as `result_missing` or `result_predates_pull`.
- The plan candidate must be the live head or, for an act-list source, an ancestor of it (`ahead` only). A threads source re-enters only at its candidate: the thread verifier needs a clearing delta record whose candidate is the pushed head, so a descendant head refuses and names a full gate round. The order carries `operation: complete`, an empty `allowedPaths` and no push marker. It grants delivery only.
- Completion-only refuses without writing when the candidate drifted, the gate sequence is closed or the review round is retired. A second re-entry keeps a genuine report that the first re-entry produced.
- `--phase commit_only` refuses while a pulled incomplete full plan is active at the same candidate head and an exit is admissible (the report is missing or predates the pull, the gate sequence is open and the review round is not retired). An unpulled plan and a plan whose pinned required read drifted are superseded; an unpulled completion order refuses `--phase commit_only` and `--completion-only` and the refusal names pulling it, and a completion order is active at its own head, including a descendant head. The exit is `--completion-only` when the PR head is the candidate, or pulling the existing full order when the candidate is unpushed. A genuine report, a complete fixer-disposition checkpoint at the candidate or a new commit admits the commit-only emission. The refusal therefore never names an exit that also refuses.
- The emitter pins its own copy of the act list in the execution directory. `emit-fixer-work-order.mjs` and `check-pre-push-delta.mjs` compare sha256 digests where they compared paths before. A later `judge-pass --out` overwrite no longer breaks the byte checks.
- The incomplete-delivery warning of ADR 0155 stays advisory. Slice 6 of issue 2787 re-arms it.

## Consequences

The completion re-entry edge is verified, and a commit-only order no longer silently supersedes an incomplete full plan. Two edges stay `known_gap`: `head_moved` to `full_gate_round` and `no_commit` to `full_gate_round`. Both wait for C19 recovery admission through `write-gate-context`. A completion re-entry for a thread source at a descendant head refuses and names a full gate round, because `verify-fixer-disposition.mjs` cannot construct there. The completion order also belongs to the sequence of the plan it completes: the emitter rechecks that sequence's closure under the sequence locks before it makes the order current, and the pull admission refuses the order once that sequence is closed.
