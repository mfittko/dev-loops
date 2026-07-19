# 0009. Prove gate passage only by fail-closed, head-SHA-keyed PR-comment evidence

## Status

Accepted

## Context

Draft and pre-approval gates started as procedural prose in skill files: an agent could claim to have run them, nothing machine-checkable proved a gate happened on the current head, and PRs advanced or merged on stale or absent review evidence ([PR 170](https://github.com/mfittko/dev-loops/pull/170), [PR 193](https://github.com/mfittko/dev-loops/pull/193)). Merge suggestions slipped through without current-head `pre_approval_gate` evidence ([PR 235](https://github.com/mfittko/dev-loops/pull/235), [PR 431](https://github.com/mfittko/dev-loops/pull/431)), and subagents merged without gate evidence three separate times by simply omitting the opt-in enforcement flag ([issue 436](https://github.com/mfittko/dev-loops/issues/436), [PR 438](https://github.com/mfittko/dev-loops/pull/438)). Small and docs-only PRs skipped gates entirely ([issue 579](https://github.com/mfittko/dev-loops/issues/579), [PR 581](https://github.com/mfittko/dev-loops/pull/581)), the draft gate was reused across heads instead of recorded once at the draft transition ([issue 285](https://github.com/mfittko/dev-loops/issues/285)), and PRs opened non-draft bypassed the boundary altogether ([issue 339](https://github.com/mfittko/dev-loops/issues/339)). The evidence predicate lives in `packages/core/src/loop/pr-gate-coordination.mjs` (the always-on detector shipped as `detect-gate-review-evidence.mjs`), with the comment field contract in `skills/docs/gate-review-comment-contract.md`.

## Decision

We prove gate passage only by a visible PR comment keyed to the current head SHA — gate name, reviewed head, verdict, findings summary, next action — and runtime routing fails closed without it: if the required comment cannot be posted, the gate boundary is not crossed. PRs are created draft-first with a gate-guarded ready transition, `draft_gate` is a one-time boundary closed once per PR at the reviewed head, and merge suggestions and final-approval readiness are blocked without current-head `pre_approval_gate` evidence. Enforcement is always-on — we removed the opt-in enforcement flag once agents discovered omitting it — and no PR scope is exempt, docs-only and one-line changes included. A comment for an older head never satisfies the current head; each new head requires a fresh `pre_approval_gate` pass. We rejected trusting agent self-reports of gate passage: three evidence-free merges proved any skippable check gets skipped.

## Consequences

The gate comment became the durable, mechanically checked artifact that every later feature extends — fan-out provenance, hooks, findings carry-forward, and the server-side gate-evidence CI check all key off the same head-SHA-scoped comment. State claims without on-PR evidence are worthless by design: routing and merge readiness are computed from what is visible on the PR, not from what an agent asserts. The costs are comment noise on every PR, evidence-detection machinery on every routing decision, and idempotence rules so same-head reruns update the existing marker instead of stacking duplicates.
