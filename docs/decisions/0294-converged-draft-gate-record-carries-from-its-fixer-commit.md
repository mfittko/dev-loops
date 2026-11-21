# 0294. A converged draft_gate record carries across a patch-unchanged base merge from its fixer commit

## Status

Accepted, 2026-11-19 ([issue 2752](https://github.com/mfittko/dev-loops/issues/2752), slice 5).

Amends [0156](./0156-carry-gate-verdict-across-base-only-merge.md) and [0271](./0271-body-only-cap-round-exit.md). Records 0156 and 0271 stay unedited.

## Context

A converged `draft_gate` record (`GATE-EXEC-LOW-NIT-CONVERGENCE`) is a clean verdict at the reviewed head A. Its marker names the fixer commit F, and the evidence readers treat it as the marker for head F. On 2026-11-19 a cap-round fix commit F was followed by a clean base merge M outside the PR paths. `upsert-checkpoint-verdict.mjs --converged-json` refused F because F was no longer the PR head. The carry of ADR 0156 started from head A, so it could not reach M either. The lane re-gated a patch that had already converged.

## Decision

The recording seam of `upsert-checkpoint-verdict.mjs --converged-json` accepts a `fixerCommit` that is not the current PR head M when `convergedCarryAccepts` in `scripts/github/_carried-verdict.mjs` holds. It runs `computeBaseMergeCarry` for F to M with the full classifier, including the gate-tooling rule, and `validateBaseMergeCarryEvidence` for the heads F and M. Both stay unchanged. The base-freshness check of `GATE-EXEC-BASE-REFRESH` then runs at M. The converged marker records F unchanged. The delta freshness and body-only own-commit checks keep reading the range A to F.

`isCarryCandidate` and `carryGateMarker` take the origin head from `converged.fixerCommit` only for a `draft_gate` marker that has one (`originHeadOf`). Every other marker keeps its own head, including a `pre_approval_gate` marker with a `converged` field. The carried marker records the reviewed head A as `convergedFromHeadSha`. Gate coordination and `merge-pr.mjs` then carry the converged verdict from F to M through the existing carried-heads record and acceptance path.

Any other case keeps the `fixerCommit ... is not the current PR head` refusal: a changed PR blob, a gate-tooling base delta, a conflict-resolution merge, a non-ancestor F, a criss-cross merge base or a detection failure.

## Consequences

- A base merge after a converged fix no longer costs a full gate round when the PR patch is unchanged.
- The tooling rule still applies, so a converged carry never runs on stale gate tooling. This differs from the fixer-emit seam of ADR 0282, which ignores that rule.
- The marker format, the carried-heads record and the merge acceptance path are unchanged.
