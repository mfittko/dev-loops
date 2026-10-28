# 0206. A slice PR keeps its closing reference and a Non-goals reopen line

## Status

Accepted — 2026-10-28

## Context

Issue [2883](https://github.com/mfittko/dev-loops/issues/2883) reports that a judge remedy changed `Closes` to `Refs` in a slice PR. A `Refs`-only PR has no spec authority, so the spec context for the next review round lost the slice linkage.

## Decision

- Interim rule until Refs-only `pr_body` authority ships in a later slice of the tracking issue: a slice PR keeps its closing reference (`Closes #N`) and carries a Non-goals line that reopens the issue after the merge. The rule is `SPEC-SLICE-PR-KEEPS-CLOSING-REF` in `skills/docs/artifact-authority-contract.md`. The `Refs` plus verbatim slice body shape (dod:3) stays open for that later slice.
- `judge-pass.mjs`, with `--spec-file`, coerces an `act` disposition whose `judgeFix` removes a closing reference to `reject`, and names the rule ID in `judgeReason`. The reopen line comes from the `--spec-file` Non-goals, or from the PR body through `--pr-body-file` when the spec comes from the linked issue.
- The spec context states the slice-linkage sentence for a PR whose Non-goals hold a reopen line, and the judge work order renders it from the spec or `--pr-body-file` Non-goals.
- Slices 2 and later of the tracking issue remain open. They cover Refs-only authority through `pr_body`, and they retire the interim scope of this rule.

## Consequences

A judge cannot weaken a slice PR into a `Refs`-only PR. A genuine linkage change goes through the operator.
