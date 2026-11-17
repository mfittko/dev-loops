# 0282. The fixer emit carries a posted verdict across a patch-unchanged base merge and ignores the gate-tooling rule

## Status

Accepted, 2026-11-16 ([issue 2752](https://github.com/mfittko/dev-loops/issues/2752), slice 4).

Amends [0156](./0156-carry-gate-verdict-across-base-only-merge.md). Cites [0197](./0197-closure-round-survives-a-base-only-merge.md), as amended by [0225](./0225-delta-input-authenticates-cap-round-log-across-fixer-chain.md), for the base-only cap-round handling this seam sits beside. Records 0156, 0197 and 0225 stay unedited.

## Context

`GATE-EXEC-POST-BEFORE-FIX` makes `emit-fixer-work-order` refuse an act-list order with `verdict_not_posted` until the gate's verdict review is posted at the PR head. On PR 3223 a `draft_gate` verdict was posted at one head. A merge of the base then gave a new head with an unchanged PR patch. The emit refused at the new head, and at the old head because it was no longer the PR head. The five judged act items had no route to a fixer, and the lane spent a third gate round re-reviewing the same patch.

ADR 0156 carries a verdict across a base-only merge for gate coordination and merge acceptance. It also requires that the base delta touches no gate tooling. Its reason is the refresh rule of ADR 0096: a round must run on current gate tooling. A base delta that touches `scripts/` is the common case, so the full classifier would refuse the PR 3223 shape in most real merges.

## Decision

`emit-fixer-work-order` gains a carry seam for the `verdict_not_posted` check. When no contract-complete verdict is posted at the head, the seam takes the head of the latest closed earlier findings ledger of the gate as the origin head. It accepts the verdict posted at the origin head when `fixerEmitCarryAccepts` in `scripts/github/_carried-verdict.mjs` holds:

- The origin head is an ancestor of the PR head.
- Every PR path has the same mode and blob object id at both heads, as `computeBaseMergeCarry` computes it.
- No merge on the PR branch line carries conflict-resolution hunks.
- The merge base is unique.

The seam ignores the gate-tooling rule through one option, `classifyBaseMergeCarry(input, { ignoreGateTooling: true })`, which `computeBaseMergeCarry` and `validateBaseMergeCarryEvidence` pass through. The option skips only the tooling decision. The seam keeps the path intersection rule, which is stricter than a blob check alone. Any detection failure, a non-ancestor origin head, a criss-cross merge base, a changed PR blob, conflict hunks, a missing origin verdict or a missing base ref name keeps the `verdict_not_posted` refusal.

The tooling rule has two reasons not to apply here:

- The act items were already judged at the origin head. The fix changes nothing about what was judged.
- The round after the fix runs on current tooling, so the tooling rule keeps its purpose where it matters.

The seam returns no origin head when the PR head has a findings ledger of its own (live, retained, blocked or unreadable): that head ran a round whose verdict is not posted. When the seam accepts, the act list's round and the round cap are counted at the origin head, because the head's own count would be one round late. A round after the cap round stays refused.

The seam accepts the origin head's posted verdict and its ledger as the authority for the act list. At the round cap, a head with no ledger of its own reads the origin head's ledger for the cap-round blocker check, and only when the seam accepts the origin head. The fix pass starts from the current head. The seam posts, edits and records nothing.

A fixer-emit acceptance never satisfies gate coordination or merge acceptance. The carried-heads record gets no entry, and `carryGateMarker` and `merge-pr.mjs` keep the full classifier. Evidence computed with the option carries its own reason text, so `validateBaseMergeCarryEvidence` under the default rule rejects it even when the base delta holds no tooling path.

## Consequences

- A base merge between a verdict and its fix no longer costs a full gate round when the PR patch is unchanged.
- The tooling rule for gate-round carry and merge acceptance is unchanged.
- The seam carries no PR blob change. Same-file partial carry stays with slice 3 of issue 2752.
