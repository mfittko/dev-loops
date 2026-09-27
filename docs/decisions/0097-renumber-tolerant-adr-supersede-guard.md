# 0097. The decision-record guard tolerates a pure renumber

## Status

Accepted — 2026-09-27 ([issue #2451](https://github.com/mfittko/dev-loops/issues/2451))

Refines [ADR-SUPERSEDE-NOT-REWRITE](../../skills/docs/decision-record-contract.md), whose refusal set was wider than its intent.

## Context

`scripts/docs/validate-decision-records.mjs` rule 3 (`ADR-SUPERSEDE-NOT-REWRITE`) refuses any post-acceptance rewrite of a record whose base Status is `Accepted` or `Superseded`. It reads changed paths through `diffNameOnly`, which passes `--no-renames` deliberately so a `git mv` surfaces as a delete+add pair instead of collapsing to the destination path and evading the guard.

That anchoring is right for a rewrite and wrong for a renumber. Two records can reach the default branch with the same four-digit number when two PRs are authored concurrently, and `ADR-PATH-NUMBERING` then fails on the base branch itself. The only repair is to give one record a new number, which is a delete+add pair — so the guard refuses the only legal repair. The precedents that renumbered a colliding record (`0063 -> 0064`, `0077 -> 0078`) worked only because the renumbered record was branch-new and therefore absent from the base ref; once the colliding record is on the default branch, that escape is gone. On 2026-09-27 this blocked `main` (`94d81740`): `0095-single-wave-gate-fanout.md` and `0095-targeted-validation-and-full-run-authority.md` both landed as 0095, `test:docs` failed `ADR-PATH-NUMBERING`, and the aggregate `verify` job failed for every branch.

## Decision

Rule 3 recognizes a pure renumber as legal, and nothing else changes.

The validator keeps its delete/add read (`diffNameOnly`, `--no-renames`) as the guard's core: a bare delete is still refused, and a newly added record still cannot excuse a separate deletion. It additionally reads a rename-detecting `git diff --name-status --find-renames` scoped to `docs/decisions`. A base-present, Accepted-or-Superseded record that is absent at HEAD is treated as a legal renumber only when all three hold:

- the rename destination is a direct record-shaped file under `docs/decisions` (a nested destination such as `docs/decisions/archive/0047-something.md` is refused, because the index scans only direct children and the record would otherwise vanish from the catalog with no guard firing);
- the destination's H1 number matches its new filename (`recordTitleNumber`); and
- the destination's body outside `## Status`, with the H1's four-digit number normalized (`normalizeRecordNumber`), equals the base body's.

Anything else is refused as a post-acceptance rewrite, naming the old and new paths. A rename with an edited body, a stale H1 number, a nested destination, and a plain delete each stay refused.

The comparison stays inside the existing rule-3 scope boundary: only content outside `## Status` is compared, the H1 number is the only line treated as identity rather than content, and judging the correctness of a record's Status content remains a declared non-goal.

## Consequences

A duplicate record number on the default branch is repairable in a branch by renaming one record to the next free number, which is the repair `ADR-PATH-NUMBERING` implies. The guard's bite is preserved on every other path: a rename that also edits the body fails, a rename that leaves a stale H1 number fails, a rename out of the direct `docs/decisions` directory fails, and a bare delete fails. `test/docs/validate-decision-records.test.mjs` pins each: a renumber passes; an editing rename, a stale-H1 rename and a nested-destination rename each fail with `ADR-SUPERSEDE-NOT-REWRITE`; and the rename-detecting read is mutation-anchored on `--find-renames` while the delete/add read stays anchored on `--no-renames`.
