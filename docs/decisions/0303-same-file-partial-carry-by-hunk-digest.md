# 0303. Same-file partial carry by -U0 hunk digest

## Status

Accepted

Amends [0156](./0156-carry-gate-verdict-across-base-only-merge.md). Record 0156 stays unedited.

## Context

ADR 0156 carries a whole gate verdict across a base-only merge only when every PR blob is unchanged. It records a base edit in a file the PR also changed as `full_regate`, and it leaves the delta review of conflict-resolution hunks to a later slice. A base merge that only shifts line numbers in a PR file, or that resolves a conflict in one file, therefore still restarts a full gate round ([issue 3284](https://github.com/mfittko/dev-loops/issues/3284)). Its "Other outcomes" paragraph and its Consequences section describe that state.

## Decision

`computeBaseMergeCarry` adds two decisions beside `carry_verdict`, `full_regate` and `fallback_full`.

- `partial_carry`: a PR blob changed, the base delta touched that file, and the digest of the PR's own hunks is equal at both heads. `rerunPaths` lists those files.
- `resolution_delta`: a merge on the PR branch line carries conflict-resolution hunks. `rerunPaths` lists the resolution files, every changed file with an unequal digest, every shifted file and every base-overlapped path with an unchanged blob. A changed file with no digest is a `full_regate`.

The digest is a sha256 of the mode lines and the `+`/`-` hunk bodies of `git diff -U0 --no-renames --diff-algorithm=myers <merge-base>..<head> -- <path>`, with the header, index and `@@` lines dropped. The diff runs in a throwaway bare git dir that has no attribute files, so no config or attribute can change it. A file with no sound digest (binary content, no `diff --git` line in the output, for example a non-ASCII path that the git pathspec does not match) has a null digest and forces `full_regate`.

`resolve-angle-carry-forward.mjs` recomputes the evidence, validates it with `validateBaseMergeCarryEvidence`, and builds the plan from `rerunPaths` with the delta complete. Only angles whose surface meets `rerunPaths` re-run. The always-run angles and the rename rule still apply. The plan output lists `resolutionDeltaPaths` for `resolution_delta`, and `emit-fanout-dispatch.mjs` adds a `Resolution scope` line with those files to each re-run reviewer's angle suffix. The `carry_verdict` path and its evidence are unchanged: the new keys appear in the evidence only when nonempty, so an existing `carry_verdict` record keeps its `evidenceDigest`.

`git patch-id` was rejected as the digest. It hashes context lines and honors diff configuration, so a base edit next to a PR hunk changes it. The `-U0` digest has two limits. It is location-blind: a PR hunk that moved to a different place with identical body lines gives an equal digest. Hunk boundaries are dropped: two hunks that merge into one still give the same body bytes. Both limits only matter inside a file whose angles re-run anyway, because `rerunPaths` re-runs every angle that reviews the file.

## Consequences

- A same-file line shift or a resolved conflict re-runs only the angles that review the touched files.
- A binary file and a non-ASCII path stay a full re-gate on every merge. A moved or changed PR hunk stays a full re-gate on a merge without conflict-resolution hunks; on a merge with them it joins `rerunPaths`.
- A base-overlapped PR path with an unchanged blob joins `rerunPaths` in both decisions.
- `merge-pr` and the `gate-evidence` check do not accept either new decision as a whole-verdict carry.
