# 0147. Authenticate bounded-out residual input forms at full completion

## Status

Accepted — 2026-10-14 ([issue 2773](https://github.com/mfittko/dev-loops/issues/2773))

## Context

The operator accepted this bounded coverage policy in issue 2773's implementation dispatch.
Strict input-form coverage ran before full completion consulted Delta status, so a genuine
bounded-out push could not retain a truthful skipped form for an unresolved item alongside
tackled binding findings. The issue locks the narrow consumer policy; this record adds no
producer or payload requirement and leaves accepted ADR 0146 unchanged.

The 2026-10-14 numbering check fetched origin and inspected `origin/main` at
`09ef0fb40dd890804ab4221ddb793521943a7c55` (highest record 0146), all 111 git-listed
worktrees' `docs/decisions/` names and all-ref decision history. A1 reserves 0145, also
present in two archived worktrees; no 0147 existed. This record uses the next free number.

## Decision

Only full ACT completion may relax fixed/test evidence for a residual input form, and only
after validating receipt-bound execution, target/head/containment, ACT/Delta materialized
bytes and semantic authority, reviewed baseline, membership and exact decision/result
ref-status agreement. The clearing decision must be invocation-three `bounded_out` with
`push_to_gate` and name the actual pushed candidate; the result candidate may be stale at
that bound. Local read hashes alone cannot grant this exception.

Each `not_resolved` / `cannot_verify` form still needs an explicit `input_form` entry marked
`skipped` with a concrete, non-placeholder reason. Query sites and declared forms stay
accounted for. Resolved items remain tackled with fixed forms and test evidence; residuals
remain deferred with open bound threads, no Fixed reply and no resolution. Full verification's
`complete: true` retains its tackled-disposition meaning and supplies no clean gate verdict.

Default `siteCoverageGaps`, commit-only handback and pre-push Delta coverage stay strict.
Legacy deliveries without both semantic authorities remain valid under strict coverage.
The owning procedure is [GATE-EXEC-FIXER-DISPOSITION-BOUNDARY](../../skills/docs/gate-review-sub-loop-contract.md#finding-threads-and-disposition).

## Consequences

Authentic bounded-out completion can preserve unresolved evidence without claiming a fix.
Unauthenticated residual exception attempts refuse before checkpoint/reply mutation; `--check` remains
read-only. No new attestation producer, optional report seed, schema or recovery path lands
with this consumer. The normal lifecycle gates still judge the pushed candidate.
