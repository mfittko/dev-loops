# 0279. The per-merge approval pins the head or the patch-id

## Status

Proposed (provisional, pending operator checkpoint) — 2026-11-16 ([issue 3048](https://github.com/mfittko/dev-loops/issues/3048)).

Amends [0258](0258-operator-owned-line-registry.md): the pin of the per-merge approval. Accepted records remain unchanged.

## Context

The operator approval marker `approve merge <headSha>` pins one head SHA. A base-only head change, for example a merge of `origin/<base>` into the branch, voids the approval although the PR diff is unchanged. The operator must then post a new line for the same change.

## Decision

The approval pins the head SHA or the PR patch-id plus base containment. A comment marker `approve merge <headSha>` keeps working. The marker may carry a suffix, `approve merge <sha> patch-id <patchId>`. When no head match exists, a marker by the named non-bot approver whose `<patchId>` equals the current patch-id also satisfies the approval, with `matchKind` `patch_id`. The `<sha>` of that marker is any 40-hex SHA.

The current patch-id is the first token of `git patch-id --stable` over `git diff -U0 origin/<base>...<head>`. `merge-pr.mjs` computes it only when `origin/<base>` is an ancestor of the head. Any error leaves it null, and only a head match counts. An `APPROVED` review stays head-only. `_policy-change-approval.mjs` stays head-only.

The operator alone writes the marker (`OPERATOR-OWNED-LINE`, `GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE`). The registry and the sanctioned writers are unchanged. `merge-pr.mjs` reports `approvalMatch` (`head`, `patch_id` or `null`) next to `approvalVia`.

This record is provisional until the operator checkpoint accepts the authority change.

## Consequences

- A base merge no longer voids a patch-id approval.
- A patch-id approval does not cover a change to the PR's own diff, because that changes the patch-id.
- The `-U0` diff ignores context lines, so a base change that shifts only context keeps the patch-id. The base-containment check bounds the base the approval was read against.
