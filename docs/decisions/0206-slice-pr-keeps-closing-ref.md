# 0206. A slice PR keeps its closing reference and a Non-goals reopen line

## Status

Accepted — 2026-10-28

## Context

Issue [2883](https://github.com/mfittko/dev-loops/issues/2883) describes `pr create` refusing `Refs`, hardcoded `tracker_issue` authority, and blocked gate units. A slice PR with a `Refs` reference only has no spec authority today, so a judge remedy that changes `Closes` to `Refs` would leave the next review round without the slice linkage.

## Decision

- Interim rule until Refs-only `pr_body` authority ships in a later slice of the tracking issue: a slice PR keeps its closing reference (`Closes #N`) and carries a Non-goals line that reopens the issue after the merge. The rule is `SPEC-SLICE-PR-KEEPS-CLOSING-REF` in `skills/docs/artifact-authority-contract.md`. The `Refs` plus verbatim slice body shape (dod:3) stays open for that later slice.
- `judge-pass.mjs` coerces an `act` disposition whose `judgeFix` removes the PR's only closing reference to the issue its Non-goals reopen line names to `reject`, and names the rule ID in `judgeReason`. A removal that names another issue number, or a PR body with a second closing reference, stays `act`. It arms the coercion from the `sliceLinkageIssues` that the pinned judge work order carries, and from nothing else.
- `emit-judge-work-order.mjs` requires `--pr-body-file` and refuses an emission without it. It carries `sliceLinkage` and `sliceLinkageIssues` when the PR body holds exactly one closing reference whose number a reopen line in the body or spec Non-goals names.
- The spec context states the slice-linkage sentence when the extracted spec Non-goals hold a reopen line, or, with `--issue`, when the optional `--pr-body-file` Non-goals hold one.
- Slices 2 and later of the tracking issue remain open. They cover Refs-only authority through `pr_body`, and they retire the interim scope of this rule.

## Consequences

A judge cannot weaken a slice PR into a `Refs`-only PR. A genuine linkage change goes through the operator.
