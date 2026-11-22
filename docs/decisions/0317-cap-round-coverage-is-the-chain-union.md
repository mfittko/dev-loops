# 0317. Cap-round coverage is the union of the clearing chain's records

## Status

Accepted — 2026-11-22 ([issue 3443](https://github.com/mfittko/dev-loops/issues/3443)). Amends ADR 0208, ADR 0224 and ADR 0313 (the `no_cap_round_chain` recovery for a non-covering sealed record).

## Context

A cap round with three act items had one item escalated under `GATE-EXEC-RECURRENCE-ESCALATION`. The operator chose to fix it in the PR. The commit_only fixer record covered the two other act refs. A thread-route fixer and a delta review then fixed the escalated item against a later baseline and sealed a second `locally_clear` record. `capRoundCovers` read only the first record of the chain, so the proof refused `items_do_not_cover` and the only exit was a replacement PR.

## Decision

- `capRoundCovers` accepts a non-clean cap round when the union of the `items` refs of every sealed clearing record on the chain that starts at the first record names every act ref. One helper (`capRoundCoverage`) computes the union and returns the uncovered refs and the records read.
- Each link's baseline is the previous link's candidate head, so every baseline is an ancestor of the head the chain reaches. The proof still requires the chain to reach the head.
- The union spans only the links the proof traverses. The walk stops after the link whose candidate is the PR head, so a sealed link past the head covers nothing. Under `anyHead` a link after the first counts only when its candidate is an ancestor of the head. A link after the first counts only its items with status `resolved`, because a `bounded_out` record can carry unresolved items.
- The `extend-cap-round-chain` `no_cap_round_chain` refusal for a non-covering sealed record names the uncovered act refs and the records that exist. Its `recovery` is the replacement-PR operator form in every case. A further record at the chain end derives an empty act list (ADR 0255) and covers no act ref, so the replacement PR is the recovery for a genuinely uncovered ref.
- The coverage detail names the start with the fewest uncovered refs, and renders a missing SHA as `?`.
- A thread-route delta item carries the threadId as its `ref`. When the thread root is authored by the authenticated gate login (never marker text alone; with no known login nothing maps), `threadsToActList` reads the ledger fingerprint of every gate finding marker of the thread, so a merged comment names each member, and the record writer stores them as `actFingerprints` on the item. The union maps each fingerprint to the act ref of the cluster that holds that finding, so a thread-route fix of an escalated item names its cap-round act ref, including a `#n` suffixed ref or a cluster representative whose fingerprint differs from the member's.
- `extend-cap-round-chain` passes the same history bound as `resolveCapRoundFixed` under `anyHead` (a later link counts only when its candidate is on the head's history), so the tool and the proof cannot disagree.
- Amends ADR 0313 for `head_mismatch`, which returns three recoveries, not the two named in ADR 0313: the fast-forward pull (worktree on the PR branch, HEAD an ancestor of the PR head or the PR head absent locally), the operator form for an ahead or diverged HEAD on the PR branch (push the local commits to the PR branch, or reset the worktree), and the operator form for another branch or a detached HEAD (check out the PR branch in a worktree and rerun with `--worktree`).
- Existing delta records are never overwritten. The round cap and the escalation rule are unchanged.

## Consequences

A thread-route fix of an escalated cap-round item no longer needs a replacement PR. A cap round with a genuinely uncovered act ref still refuses and names it.
