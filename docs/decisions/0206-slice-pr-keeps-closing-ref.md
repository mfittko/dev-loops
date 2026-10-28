# 0206. A slice PR keeps its closing reference and a Non-goals reopen line

## Status

Accepted — 2026-10-28

## Context

Issue [2883](https://github.com/mfittko/dev-loops/issues/2883) reports that a judge remedy changed `Closes` to `Refs` in a slice PR. A `Refs`-only PR has no spec authority, so the spec context for the next review round lost the slice linkage.

## Decision

- A slice PR keeps its closing reference (`Closes #N`) and carries a Non-goals line that reopens the issue after the merge. The rule is `SPEC-SLICE-PR-KEEPS-CLOSING-REF` in `skills/docs/artifact-authority-contract.md`.
- `judge-pass.mjs` coerces an `act` disposition whose remedy removes the PR's only closing reference to `reject`, and names the rule ID in `judgeReason`.
- The spec context states the slice-linkage sentence for a PR whose Non-goals hold a reopen line.
- Slices 2 and later of the tracking issue remain open. They cover Refs-only authority through `pr_body`.

## Consequences

A judge cannot weaken a slice PR into a `Refs`-only PR. A genuine linkage change goes through the operator.
