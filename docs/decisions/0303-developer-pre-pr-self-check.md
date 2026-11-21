# 0303. The developer records a pre-PR self-check against past gate findings

## Status

Accepted — 2026-11-21 ([issue 3395](https://github.com/mfittko/dev-loops/issues/3395))

Extends: 0139 ([record](./0139-pr-create-pre-pr-review-record-guard.md)) and 0159 ([record](./0159-pre-pr-review-runs-stale-surface-sweep.md)). Both records stay unedited.

## Context

The first draft_gate round repeatedly finds the same classes of defect: missing tests for a failure path, a PR body out of sync with the code, stale help or docs, and unhandled edge cases. The developer had no input that named those classes before the pre-PR review.

## Decision

- `dev-loops gate finding-classes` reads the durable findings logs offline and reports the top angles of act-judged findings from the first draft_gate round of each PR.
- `loop implementation-brief` carries a `selfCheck` object: the draft_gate angles that apply to the touched paths, the top 3 classes (one example each) and four fixed generic items (`tests`, `description`, `surface-text`, `edge-cases`). Without logs, `classes` is empty and the generic items remain.
- The record writer requires `--self-check-file` in record mode: a JSON array of `{ id, status, evidence }` that covers every item id with non-empty evidence. It refuses with `pre_pr_self_check_missing` and stores the entries in the record (`PRE-PR-DEVELOPER-SELF-CHECK`).
- The record `integrity` digest and the `pr create` validation stay unchanged. The self-check is not gate evidence (`PRE-PR-NOT-GATE-EVIDENCE`).

## Consequences

The developer sees the most frequent first-round finding classes before the first push, and the evidence of the self-check is stored with the record. The record command gains a required flag, so callers of the writer pass it in record mode. The evidence is self-reported and the gate stays the authority.
