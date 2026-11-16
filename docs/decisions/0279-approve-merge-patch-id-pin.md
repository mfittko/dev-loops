# 0279. The per-merge approval pins the head or the patch-id

## Status

Proposed (provisional, pending operator checkpoint) — 2026-11-16 ([issue 3048](https://github.com/mfittko/dev-loops/issues/3048)).

Amends [0258](0258-operator-owned-line-registry.md): the pin of the per-merge approval. Accepted records remain unchanged.

## Context

The operator approval marker `approve merge <headSha>` pins one head SHA. A base-only head change, for example a merge of `origin/<base>` into the branch, voids the approval although the PR diff is unchanged. The operator must then post a new line for the same change.

## Decision

The approval pins the head SHA or the PR patch-id plus base containment. A comment marker `approve merge <headSha>` keeps working. The marker may carry a suffix, `approve merge <sha> patch-id <patchId>`. When no head match exists, a marker by the named non-bot approver whose `<patchId>` equals the current patch-id also satisfies the approval, with `matchKind` `patch_id`. The `<sha>` of that marker is any 40-hex SHA.

The current patch-id is the first token of `git patch-id --verbatim` over `git -c core.quotePath=true diff -U3 --no-color --no-ext-diff --no-textconv --binary --no-renames --diff-algorithm=myers --src-prefix=a/ --dst-prefix=b/ origin/<base>...<head>`. The diff stays a byte Buffer, so no byte is lost to a text decode. The pinned options make the id a function of the commits only, not of the local git configuration. The only supported source of the id is the `approveMergeLine` that `merge-pr --check` prints. `--verbatim` does not strip whitespace, so whitespace-only and binary changes change the patch-id. `merge-pr.mjs` computes it only when `origin/<base>` is an ancestor of the head. Any error leaves it null, and only a head match counts. An `APPROVED` review stays head-only. `_policy-change-approval.mjs` stays head-only.

The operator alone writes the marker (`OPERATOR-OWNED-LINE`, `GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE`). The registry and the sanctioned writers are unchanged. `merge-pr.mjs` reports `approvalMatch` (`head`, `patch_id` or `null`) next to `approvalVia`.

This record is provisional until the operator checkpoint accepts the authority change.

## Consequences

- A base merge no longer voids a patch-id approval.
- A patch-id approval does not cover a change to the added or removed lines of the PR's own diff or to their three surrounding context lines, because that changes the patch-id. `git patch-id` drops hunk line numbers, so the three context lines bind the position of a change.- The id stays valid across a clean base-only refresh (a base merge that changes no line the PR diff touches or uses as context).
- A patch-id marker stays valid across heads, so revoking it takes a new commit that changes the diff or deleting the comment.
- A base change that edits a context line of the PR diff changes the patch-id, so the operator posts a new line. The base-containment check bounds the base the approval was read against.
