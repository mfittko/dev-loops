# 0097. The decision-record guard tolerates a pure renumber

## Status

Accepted — 2026-09-27 ([issue #2451](https://github.com/mfittko/dev-loops/issues/2451))

Refines [ADR-SUPERSEDE-NOT-REWRITE](../../skills/docs/decision-record-contract.md), whose refusal set was wider than its intent.

## Context

`scripts/docs/validate-decision-records.mjs` rule 3 (`ADR-SUPERSEDE-NOT-REWRITE`) refuses any post-acceptance rewrite of a record whose base Status is `Accepted` or `Superseded`. It reads changed paths through `diffNameOnly`, which passes `--no-renames` deliberately so a `git mv` surfaces as a delete+add pair instead of collapsing to the destination path and evading the guard.

That anchoring is right for a rewrite and wrong for a renumber. Two records can reach the default branch with the same four-digit number when two PRs are authored concurrently, and `ADR-PATH-NUMBERING` then fails on the base branch itself. The only repair is to give one record a new number, which is a delete+add pair — so the guard refuses the only legal repair. The precedents that renumbered a colliding record (`0063 -> 0064`, `0077 -> 0078`) worked only because the renumbered record was branch-new and therefore absent from the base ref; once the colliding record is on the default branch, that escape is gone. On 2026-09-27 this blocked `main` (`94d81740`): `0095-single-wave-gate-fanout.md` and `0095-targeted-validation-and-full-run-authority.md` both landed as 0095, `test:docs` failed `ADR-PATH-NUMBERING`, and the aggregate `verify` job failed for every branch.

## Decision

Rule 3 recognizes only a duplicate-on-base number repair, not an arbitrary rename.

The validator keeps its delete/add read (`diffNameOnly`, `--no-renames`) as the guard's core. It identifies replacements deterministically among changed, newly added paths, not through Git's heuristic rename detection. A base-present Accepted-or-Superseded record absent at HEAD is admitted only when exactly one candidate satisfies all of these:

- another direct record in the base catalog carries the source's four-digit number;
- the candidate is a direct record-shaped file under `docs/decisions` with the identical slug;
- its four-digit number differs from the source's and is unused by every other HEAD record (the repair uses the next free number);
- its H1 number matches its filename (`recordTitleNumber`); and
- its body outside `## Status`, with the H1's four-digit number normalized (`normalizeRecordNumber`), equals the base body's.

Otherwise the ordinary deletion refusal applies. A non-duplicate move, slug change, unchanged number, edited body, stale H1, nested destination, ambiguous match, or plain delete is refused.

The comparison stays inside the existing rule-3 scope boundary: only content outside `## Status` is compared, the H1 number is the only line treated as identity rather than content, and judging the correctness of a record's Status content remains a declared non-goal.

## Consequences

A duplicate number already on the default branch is repairable at a free destination number while preserving the slug and decision text. Non-duplicate and slug-changing moves remain protected; Git similarity scores cannot reject a lawful repair with a large Status edit. Tests pin both admissible repairs and refusal cases with fake-git fixtures, anchor `--no-renames`, and exercise a low-similarity renumber in real Git.
