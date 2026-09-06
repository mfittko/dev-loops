# 0063. Derive specDigest from the authoritative AC/DoD matrix, not the checklist projection

## Status

Accepted — 2026-09-07 (issue #2016)

## Context

[ADR-0060](./0060-immutable-spec-authority.md) established `specDigest` as the immutable identity of what the work is REQUIRED and FORBIDDEN to do, and [ADR-0061](./0061-engage-spec-authority-in-live-conductor.md) engaged it on every live gate round. <!-- secret-scan:allow relative ADR filename cross-reference links, not credentials --> `computeSpecDigest` hashes the output of `extractSpecFromBody`, which scraped the list-form Acceptance criteria / Definition of done checklists from the canonical tracker issue body.

[ADR-0059](./0059-matrix-on-issue-checklist-on-pr-refinement-floor.md) made the issue's AC→DoD mapping MATRIX the authoritative refinement artifact and the list-form checklists a DERIVED presentation projection of it (`derivePrChecklistsFromIssueMatrix`). That left a defect: a semantics-preserving edit to the checklist projection — adding, removing, or re-heading a parser-compatible alias while the matrix was unchanged — changed the scraped text and therefore `specDigest`, which invalidated all prior clean review evidence and forced a full reviewer fan-out/fan-in for no behavioral reason.

This change touches `skills/docs/spec-authority-contract.md`, so the ADR tripwire ([0052](./0052-adr-tripwire-fail-closed.md)) fires; this record satisfies it.

## Decision

`extractSpecFromBody` sources acceptance-criteria and definition-of-done text from the authoritative AC→DoD matrix (`detectAcDodMatrix`, reused byte-identical from `issue-refinement-artifact.mjs` — no second matrix parser) whenever the issue body carries one that parses as valid (`found && valid && rows.length > 0`). Acceptance criteria become the matrix rows' `criterion` cells; definition of done become the rows' `evidence` cells. The redundant list-form checklist is no longer part of the hashed input in that case, so a checklist-alias edit that projects the same matrix no longer changes `specDigest`.

Any change to the matrix itself — a criterion's text, a completion-evidence cell, or the row set (add/remove) — changes `matrix.rows` and therefore still changes the digest, re-invalidating the affected prior evidence through the existing `resolveCriterionInvalidation` per-criterion path. No genuine acceptance-criterion, evidence, or Non-goal change is exempted from review.

Non-goals are unchanged: the matrix carries none, so they stay sourced from the `## Non-goals` section exactly as before, and a Non-goal edit still changes the digest.

Fail-closed fallback: when `detectAcDodMatrix` reports `found: false` (no matrix) or `valid: false` (empty/malformed/identifier-only table), `extractSpecFromBody` falls back to the pre-existing checklist-based read rather than digesting a narrowed or empty surface. Carry-forward of the semantic identity is applied only where equivalence is positively proven by a valid matrix parse, never assumed by default.

Rejected alternative: a general free-text semantic-diff or NLP equivalence engine. Equivalence is limited to the enumerated provable edit classes (matrix-vs-checklist projection, whitespace/heading/marker normalization already handled by `normalizeCriterionText`).

## Consequences

- A semantics-preserving presentation edit to the spec-of-record retains the semantic spec identity and the prior clean review evidence; the reported reproduction (checklist-alias-only edit against an unchanged matrix) no longer triggers a full reviewer fan-out.
- The existing spec-authority guarantees are preserved: `SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED`, the judge-pass digest-mismatch guards, and the criterion-scoped invalidation path all continue to operate on the matrix-derived identity.
- An older issue body that carries no matrix, or a malformed one, is unaffected: it fail-closes to the prior checklist-based digest, so no body silently narrows what gets digested.
- The semantic spec identity, the provably-preserving edit classes, and the fail-closed default are documented in `skills/docs/spec-authority-contract.md`.
