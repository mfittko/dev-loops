# 0149. Construct fixer completion from authenticated coverage and provenance

## Status

Accepted — 2026-10-15 ([issue 2774 rationale](https://github.com/mfittko/dev-loops/issues/2774#issuecomment-6182725997))

## Context

The verifier can validate a delivered report but cannot construct it from a genuine prior
worker's filled coverage. Paths and read hashes alone cannot confer semantic authority, and
commit containment alone cannot identify the fixing commit. The published issue accepts this
bounded consumer seam. Merged decisions end at 0148; inspected in-flight PRs reserve only
0140 and 0145, and the implementation worktree has no 0149. Accepted 0147/0148 stay unchanged.

## Decision

Add optional ACT/full construction to the existing verifier, using its shared delivery and
live-root checks. Bind parsed completion input and exact bytes separately in semantic authority.
Authenticate the actual distinct prior commit-only pull and after-pull filled handback, deriving
its output from the canonical plan directory. Keep original Delta baseline A separate from full
authority/live candidate B, proving both baseline and fixing-commit containment. Require exact
raw coverage identity in the origin handback, optional source, Delta result and clearing decision.
Retain every authenticated root/member and aggregate statuses before emitting one ordinary
disposition per root. Write only the current execution's report after all checks; normal verification
still owns checkpoint/replies/resolution. Normal and check modes authenticate the same optional source.

## Consequences

Coverage records, reasons and tests remain truthful and unchanged. Partial optional authority
fails closed; absent optional inputs retain legacy behavior. No schema, serializer or dispatch
protocol changes. Producer emission remains issue 2765; its later operational smoke precedes
issue 2766 recovery. Historical pull fixtures prove the consumer boundary, not that future smoke.
