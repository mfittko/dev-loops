# 0272. A clean draft_gate derives its next action from the closed set

## Status

Accepted — 2026-11-12 ([PR 3202](https://github.com/mfittko/dev-loops/pull/3202))

## Context

Source: [issue 3197](https://github.com/mfittko/dev-loops/issues/3197).

A clean `draft_gate` verdict carried the caller prose "Request Copilot review while the PR stays draft". `request-copilot-review.mjs` refuses that request on a draft PR (`suppressed_draft`). The verdict therefore pointed at a step the harness rejects.

## Decision

For a clean `draft_gate`, `upsert-checkpoint-verdict.mjs` derives the next action `mark ready for review` from the closed next-action set and ignores the caller value. This is the same pattern as the non-clean derivation in `GATE-COMMENT-DRAFT-REQUIREMENTS`. An `evidence_only` act finding renders with its label and is not an open act item.

## Alternatives rejected

- Allow the Copilot request on a draft PR. This contradicts the ready-before-Copilot rule in the dev-loop skill.
- Add a resolved-by-validation-record marker for evidence findings. No such marker exists, and the mechanism choice is operator-owned, so it stays out of scope.

## Consequences

- A clean `draft_gate` verdict always names a next action the harness accepts.
- Caller prose for the next action of a clean `draft_gate` has no effect.
