# 0159. The full pre-PR review runs the stale-surface sweep

## Status

Accepted — 2026-10-18 ([issue 2807](https://github.com/mfittko/dev-loops/issues/2807))

Extends: 0139 ([record](./0139-pr-create-pre-pr-review-record-guard.md)) and 0141 ([record](./0141-delta-review-changed-line-lens-and-stale-surface-check.md)). Both records stay unedited.

## Context

[ADR 0141](0141-delta-review-changed-line-lens-and-stale-surface-check.md) added a stale-surface check to the pre-push delta review. The full pre-PR review had no such check. A branch could remove or rename a sentence or identifier and open a PR with stale copies in other tracked files. A PR body could also drift from the linked issue's scope, acceptance criteria and definition of done. [ADR 0139](0139-pr-create-pre-pr-review-record-guard.md) made the pre-PR review record mandatory for `pr create`, but the record writer did not check either drift.

## Decision

- `dev-loops loop pre-pr-review --scan` runs the delta review's stale-surface scan over `base...HEAD`, from the merge-base of the base and HEAD to HEAD. It reuses `gitStaleSurfaceHits` and `collectStaleSurface` and writes nothing. The developer passes `staleSurfaceHits`, `staleSurfaceTruncated` and `truncatedNeedles` to the reviewer in the review brief (`PRE-PR-STALE-SURFACE-SWEEP` in the [pre-push review contract](../../skills/docs/pre-pr-review-contract.md)).
- With `--body-file` and `--issue`, the sweep also compares the PR body's In scope, Acceptance criteria, Definition of done and Non-goals items with the linked issue body (`diffPrBodyAgainstIssue`). A PR item missing from the issue and an issue item missing from the PR are hits. PR-side sites are `pr-body/<section>:<n>` and issue-side sites are `issue-body/<section>:<n>`.
- Record mode rescans at the current head. It requires `--body-file` with `--issue`, or `--no-linked-issue` when the PR body is the spec. It refuses with `pre_pr_stale_surface_unaddressed` while a hit is neither fixed nor skipped with a non-empty reason in `--skips-file`. A truncated scan needs a skip for `stale-surface-hits-truncated`.
- The scan fails closed. A git error fails it, and so does an empty scan range, where the merge-base equals HEAD.
- The record file format and the `pr create` validation stay unchanged. The sweep is not gate evidence (`PRE-PR-NOT-GATE-EVIDENCE`).

## Consequences

Stale copies of removed text and PR body drift from the linked issue now surface before the PR opens. The record command changed shape: the old form without `--body-file` and `--issue`, or `--no-linked-issue`, exits 1. A `--no-linked-issue` declaration is self-reported, and nothing binds it to the later PR body. The gate stays the authority for review evidence.
