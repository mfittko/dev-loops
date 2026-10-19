# 0160. Lightweight PR create requires the pre-PR review record

## Status

Accepted — 2026-10-19 ([issue 2807](https://github.com/mfittko/dev-loops/issues/2807))

Amends: 0139 ([record](./0139-pr-create-pre-pr-review-record-guard.md)). The record stays unedited.

## Context

[ADR 0139](0139-pr-create-pre-pr-review-record-guard.md) made the pre-PR review record mandatory for `pr create` and exempted a `--lightweight` create from the record check. A lightweight PR uses the PR body as the spec. That is the case where the stale-surface sweep from [ADR 0159](0159-pre-pr-review-runs-stale-surface-sweep.md) matters most, and the exemption let those PRs open without the sweep.

## Decision

- `pr create --lightweight` runs the same record check as the tracker-backed path. It refuses with `pre_pr_review_missing` and names the `loop pre-pr-review` writer when no valid record covers the head.
- The record is keyed by head only, so a record written with `--no-linked-issue` already satisfies a lightweight create.
- The validator resolves the head through `refs/heads/<branch>` and `refs/remotes/origin/<branch>` for both paths, so a same-named tag cannot satisfy the record check.
- The only exempt path is a plan-doc promotion branch whose whole `base...head` diff is `.md` files under `docs/phases/`.

## Consequences

Every `pr create` path needs a review record. Lightweight sessions run the writer once before creating the PR, as the tracker-backed path does.
