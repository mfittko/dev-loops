# 0156. Carry a gate verdict across a base-only merge when the PR blobs are unchanged

## Status

Proposed

Amends [0096](./0096-integrate-base-before-every-gate-round.md), [0008](./0008-fail-closed-gate-comment-evidence.md) and [0030](./0030-angle-carry-forward-fail-closed.md).

## Context

ADR 0096 integrates the base branch before every gate round. `GATE-EXEC-REGATE-MANDATORY` then requires a full gate round on every new head, including a head that only merged the base. With several parallel workstreams, every merge to the base restarts gate rounds on every open PR. In a consumer repo, one PR ran nine `draft_gate` rounds in about three hours, and a three-PR stack multiplied each base move across all branches ([issue 2752](https://github.com/mfittko/dev-loops/issues/2752)). ADR 0008 ties gate passage to head-SHA-keyed comment evidence, and ADR 0030 limits carry-forward to named angles. Neither record lets a whole verdict carry across a head that did not change the PR's own patch. Records 0096, 0008 and 0030 stay unedited.

## Decision

A head advance A to B that integrated the base without touching any PR path keeps the verdict posted at A when all of these hold, as decided by the pure classifier `classifyBaseMergeCarry`:

- Every PR path (the raw tree entries of merge-base..head) has the same mode and blob object id at A and B. The comparison reads `git diff-tree -r --raw --no-renames` entries only, so attributes, textconv, diff drivers and diff rendering never apply, and gitlink oids cover submodules.
- The PR diff paths and the base delta paths do not intersect.
- The base delta touches no gate tooling or config (the set `isGateToolingPath` defines: `.devloops` config, gate contracts, scripts, agents and agent mirrors, CLI, schemas, harness extension and command prompts, core source, CI workflows, dependency manifests and lockfiles).
- No merge on the PR branch line (first-parent) carries conflict-resolution hunks.

Other outcomes: `full_regate` applies when a PR blob changed, the base delta overlaps the PR paths (including a same-file line shift), gate tooling changed, or the merge resolved conflicts. Partial carry for overlapping paths is a later slice. `fallback_full` applies when any input cannot be computed. A durable evidence record keyed by the new head stores the source head, the new head, the sorted `path`, `mode`, `oid` lists of the PR entries at both heads, the PR diff paths, the base delta paths, the conflict-resolution flag, the path intersection, the gate tooling paths, the decision and the reason. Carry requires nonempty string evidence values. `validateBaseMergeCarryEvidence` checks the record shape, recomputes the decision and every derived field, and can bind the record to the expected heads, so an internally inconsistent record fails closed. It never re-derives blob facts or paths from git, so a consumer re-runs `computeBaseMergeCarry` for the bound heads and compares before trusting the recorded facts. CI must still be green at B.

`GATE-EXEC-REGATE-MANDATORY` gains a pointer to this carry. `MERGE-PRECOND-REQUIRED` item 4 gains its pointer in slice 2, with the `merge-pr` wiring. A scope change with new authored logic changes a PR blob and still invalidates the posted gate.

Rejected: carrying on a clean textual merge alone (a clean merge can still change behavior when both sides edit one file); rebasing the PR branch (it rewrites reviewed history).

## Consequences

A base-only merge no longer restarts a gate round when the PR is unaffected. The classifier and evidence record ship first. Coordination and `merge-pr.mjs` consume them in follow-up slices. Delta review of conflict-resolution hunks is a later slice, and until then such merges re-gate fully.
