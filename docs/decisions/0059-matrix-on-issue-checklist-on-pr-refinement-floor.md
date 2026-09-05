# 0059. The tracker-backed refinement floor is the AC→DoD matrix, not duplicate issue checklists

## Status

Accepted — 2026-09-05 (issue #1951)

## Context

Issue #1877 established "matrix on the issue, checklist on the PR" but shipped a refinement floor that required a refined tracker-backed issue body to carry THREE overlapping artifacts: an Acceptance criteria checklist, a Definition of done checklist, and an explicit Non-goals section. `detectIssueRefinementArtifact` enforced the presence of the two checklists (findings `missing_ac_checklist` / `missing_dod_checklist`). The AC→DoD mapping table itself was treated as prose and never parsed. The result was a visually repetitive refined issue (an AC checklist, a DoD checklist, AND a mapping table) that blurred the authority boundary the slogan intended: the issue should own the authoritative semantic AC→DoD mapping, and the PR should own the interactive execution checklist.

The ADR tripwire ([0052](./0052-adr-tripwire-fail-closed.md)) fires on this change because it touches the shared gate config and the decision-shaped refinement contracts.

## Decision

Make the authoritative semantic **AC→DoD mapping matrix** (a two-column table mapping each acceptance-criterion outcome to its required completion evidence) plus an explicit Non-goals section the tracker-backed refinement floor. Interactive issue-side AC / DoD checklists are NO LONGER required merely to satisfy detection.

- `detectIssueRefinementArtifact` (via the new `detectAcDodMatrix`) validates the mapping table's PRESENCE and SHAPE fail-closed: `missing_ac_dod_matrix` (a checklist-only or matrix-missing issue) and `malformed_ac_dod_matrix` (an empty or identifier-only/tautological table such as `AC1 → D1`) replace the obsolete `missing_ac_checklist` / `missing_dod_checklist` findings. Validation is structural/shape only — the mapping's semantic truthfulness stays a reviewer duty (the renamed `pr-checklist` angle).
- `derivePrChecklistsFromIssueMatrix` deterministically projects the issue matrix into self-contained list-form PR AC/DoD checkboxes — never a matrix/table on the PR, never checkboxes inside table cells.
- The review angle `pr-checklist-matrix` is renamed to `pr-checklist` across config, the `gate-fanin` synthetic-angle constant, the `consolidate-fanin --pr-checklist clean` flag, the prompt, docs, and generated assets, with no compatibility alias (#1951 AC7).
- The epic/refinement verifier (`refinement-completeness-checker.mjs`) shares `detectAcDodMatrix` and drops its own issue-side AC/DoD-checklist requirements so a matrix-only body (which `loop-grill` now synthesizes) is not false-blocked; its floor is a valid matrix + Non-goals + scope boundary.

The PR-side deterministic unchecked-box block (`extractPrBodyUncheckedChecklistItems`) and the PR-body validator (`validateTrackerBackedPrBodySpec`) are unchanged: acceptance verification reads the PR's list-form checklists and no longer depends on ticking duplicate issue-side boxes.

## Consequences

The refined issue carries one authoritative artifact (the matrix), removing the duplicate-checklist noise and sharpening the issue-vs-PR authority boundary. Detection is now shape-aware: a checklist-only issue, or an identifier-only matrix, fails closed and is re-grilled (`loop-grill` synthesizes the matrix) rather than being silently accepted or grandfathered — no compatibility alias for the old floor is retained (migration is fail-closed by design). The completeness-not-truthfulness boundary is preserved: the predicate checks the mapping's presence and shape; reviewers and the judge check that the mapping and the PR's checked boxes are truthful. This revises the #1877 contract recorded in `ARTIFACT-TRACKER-ISSUE-REFINEMENT-FLOOR` (artifact-authority-contract) rather than adding a parallel one.
