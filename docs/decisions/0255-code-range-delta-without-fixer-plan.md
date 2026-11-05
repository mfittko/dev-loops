# 0255. A reviewer-only pre-push delta clears a code range without a fixer plan

## Status

Accepted, 2026-11-05 ([issue 3122](https://github.com/mfittko/dev-loops/issues/3122), [issue 3105](https://github.com/mfittko/dev-loops/issues/3105)).

Amends the remedy of [ADR 0254](./0254-cap-chain-delta-extension.md). Every other decision of that record stays in force, and the record stays unedited.

## Context

ADR 0254 names a `locally_clear` pre-push delta for the start of the logic range as the remedy for a code commit past the cap round. The act-list delta needs a fixer plan and a coverage record bound to that baseline. Only a fixer emission creates them, and the emitter refuses a head other than the PR head. After a `head_moved` closure removes the sequence marker and supersedes the plan, no command re-creates the binding. Every base refresh moves the head, so the remedy worked only for a PR that never refreshed its base (issue 3122, PR 3087). The thread-route delta needs an unresolved review thread, which a PR may not have.

## Decision

1. `check-pre-push-delta.mjs --reviewer-only` opens a zero-item delta sequence over `--baseline..--pr-head`. The worktree HEAD must equal the PR head and the baseline must be an ancestor of it. The route refuses `--act-list`, `--threads-file`, `--fixer-plan`, `--site-coverage`, `--handback` and `--findings-log`. It writes no sequence marker, keeps the invocation bound of 3 and keeps the stale-surface check.
2. The reviewer reads the whole range and reports every finding. The result run seals `gate-delta/<baseline>.json` through the existing writer, in the existing record format, with `items: []`. The record is `locally_clear` only when the result has no medium-or-higher finding. A result with an open finding seals `needs_fix`, which `extend-cap-round-chain` does not accept.
3. A merge in the range that `origin/<base>` does not hold must pass `isBaseOnlyMergeSince` from its first parent. Such merges are excluded from the reviewer patch, the changed-files list and the stale-surface scan, so a base refresh adds no lines for the reviewer. Any other merge makes the route refuse `non_base_only_merge`, naming the merge. Only the replacement-PR restart remains for that PR.
4. `gate extend-cap-round-chain` is unchanged. It reads the sealed record as the covering delta and seals `extension: "delta_covered"`, as ADR 0254 decision 1 describes, over a range that includes a base-only merge.
5. The remedy of ADR 0254 decision 2 is: run the pre-push delta for the start of the logic range (the act-list delta for a fixer pass, the thread-route delta or the reviewer-only delta otherwise) until `locally_clear`, then rerun the command. The rule `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND` in `skills/docs/gate-review-sub-loop-contract.md` records the behavior.

## Consequences

A PR whose head moved after a closed sequence reaches a covering record with one reviewer run and no plan. The route trusts the reviewer's report of the range, the same as the thread route does for its threads. The act-list route and its coverage binding are unchanged for an open sequence. The remedy sentences inside the `extend-cap-round-chain` refusal texts still name the act-list and thread-route deltas; the contract names the reviewer-only route.
