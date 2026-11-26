# 0330. A proven base-only merge passes the descendant thread-site check

## Status

Accepted — 2026-11-26 ([issue 3601](https://github.com/mfittko/dev-loops/issues/3601)).

Amends [0214](./0214-deliver-open-threads-at-unchanged-descendant-sites.md) for the nonlinear-history refusal. The rest of that record stays unedited.

## Context

ADR 0214 delivers open threads at a live head H that descends from the pushed candidate X. It refuses every nonlinear commit in X..H as `thread_site_unverifiable` and names `pre_approval_gate` as the exit. A merge of the base branch into the PR branch after a delta-verified fixer commit always trips that refusal. On a draft PR, `pre_approval_gate` is not legal and ADR 0088 blocks the ready flip while the threads stay open, so the fixer delivery strands. The only exit was `gate close-sequence`, an abandonment proof for delivered work.

## Decision

1. `assertDescendantThreadSites` skips the X to H walk for a thread when all three hold:
   - `fixerEmitCarryAccepts({ originHead: X, headSha: H, baseRef, repoRoot })` is true. It proves X is an ancestor of H, every PR path has the same mode and blob at both heads, the base delta touches no PR path, the merge base is unique and no first-parent merge has conflict-resolution hunks. It skips the gate-tooling rule, which does not move a thread site.
   - `git rev-list --no-merges --count X..H ^<merge-base(H, baseRef)>` is 0, so no PR-own commit sits in the range and a touch-and-revert still refuses.
   - The site file has the same blob at X and H.
2. The walk from the original commit to X runs as before. A call with no `baseRef`, and any predicate failure, keeps ADR 0214 behavior (fail closed).
3. The verifier reads `baseRefName` in its existing `gh pr view` call and passes `origin/<baseRefName>`. No new read, file, marker or state is added.
4. A remaining refusal names both exits: on a ready PR, `pre_approval_gate` with the thread in `--known-findings`; on a draft PR, `gate close-sequence` for the plan's reviewed baseline, then the next `draft_gate` round with the thread in `--known-findings`.

## Consequences

A base merge after a fixer push no longer strands the delivery. Gate coordination, `fixerEmitCarryAccepts`, the emitter and ADR 0088 are unchanged. The ADR 0214 `known_gap` for recovery with unresolved gate-authored threads remains.

Revert by removing the carry branch and restoring the single `pre_approval_gate` exit text.
