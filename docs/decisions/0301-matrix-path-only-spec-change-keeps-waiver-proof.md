# 0301. A matrix-path-only spec change keeps the ADR tripwire waiver proof valid

## Status

Accepted, 2026-11-21 ([issue 3349](https://github.com/mfittko/dev-loops/issues/3349)).

Amends the standing-waiver digest rule in the [decision record contract](../../skills/docs/decision-record-contract.md) (`ADR-TRIPWIRE-STANDING-WAIVER`) and `GATE-EXEC-ROUND-CAP-WAIVER-PROOF`. No earlier record needs an edit.

## Context

`pr waive-adr-tripwire` requires two things. Every triggering contract doc appears, backticked, in a row of the linked issue's AC / DoD matrix. The recorded `specDigest` of the gate proof equals the digest of the issue's current body. After a cap round the matrix can miss a doc, and adding the doc changes the digest. Leaving the doc out fails the first check, and adding it fails the second. A new draft round needs a new commit, which the cap forbids. Only a hand-written `adr-tripwire:allow` line by the operator remained (PR 3320 and PR 3368).

## Decision

1. The waiver keeps the exact digest comparison. When the recorded digest differs from the current one, it reads the issue body edit history (GraphQL `userContentEdits`) and finds the prior body whose spec digest equals the recorded digest.
2. It accepts the proof only when the prior and current bodies both have a valid matrix with equal row counts, equal non-goals and equal spec text, and when each matrix cell holds the prior cell words in order plus one contiguous run of words that adds at least one backticked `skills/docs/*-contract.md` path the tripwire reported, placed at the start or end of the cell or directly after an existing backticked path, where the connectors `in`, `and` and `see` and the punctuation `( ) , ; . :` are accepted only directly next to an added path in that run, with every prior path still present. The check is the pure function `isMatrixPathOnlySpecChange`.
3. A missing prior body, a history fetch failure or any other difference refuses `spec_digest_mismatch`. The check fails closed.
4. The pre-PR stale-surface scan reports a hit, site `issue-body/issue-matrix:<path>`, for each `skills/docs/*-contract.md` file changed in `base...HEAD` that no matrix row names. The gap is fixed before the first gate round.

## Consequences

- A matrix edit that only names a contract doc no longer forces an operator marker.
- Criterion wording, new rows, row removal and non-goal changes still need a new gate round.
- The waiver line format and the non-contract-doc triggers are unchanged.
