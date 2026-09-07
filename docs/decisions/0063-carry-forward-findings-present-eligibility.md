# 0063. Extend gate angle carry-forward eligibility to findings-present angles

## Status

Accepted — 2026-09-07 ([issue #2017](https://github.com/mfittko/dev-loops/issues/2017), [PR 2019](https://github.com/mfittko/dev-loops/pull/2019))

Amends the eligibility half of [0030](./0030-angle-carry-forward-fail-closed.md): it keeps that decision's fail-closed seam and surface-mapping model unchanged and only widens which prior verdict may be carried, from clean-only to `clean` or `findings_present`.

## Context

ADR 0030 established the fail-closed carry-forward seam but carried only a previously-*clean* angle. Any prior finding, at any severity, forced every angle to re-run on the next head bump — so the moment a gate round was non-clean (the common iterative case), the seam stopped bounding cost and `GATE-EXEC-REGATE-MANDATORY` re-imposed a full re-fan on every retry until the round went clean. That is the exact unbounded iterative cost ADR 0030 set out to bound, still paid on precisely the PRs that iterate most. Issue #2017 / PR 2019 relaxes the eligibility check so an untouched-surface angle carries forward regardless of whether its prior verdict was clean or findings-present, while preserving every guard.

## Decision

We extend carry-forward eligibility from clean-only to a `CARRY_FORWARD_ELIGIBLE_VERDICTS = {clean, findings_present}` set in `packages/core/src/loop/gate-carry-forward.mjs`, and wire the three gate CLIs that build, consolidate, and durably record a carry-forward round (`scripts/github/resolve-angle-carry-forward.mjs`, `scripts/loop/consolidate-fanin.mjs`, `scripts/github/write-gate-findings-log.mjs`) to carry a findings-present angle's OPEN findings forward unchanged. When the two-dot delta provably misses the angle's review surface, its prior findings carry forward verbatim and the round still blocks on them exactly as a fresh review would — carry-forward never converts an open finding into a pass. Per-angle `prevVerdict` is derived from the prior findings-log's own per-angle findings, not the round's overall verdict; a carried entry now records `carriedVerdict` (`clean` | `findings_present`) alongside `carriedFromHead`, and the findings themselves stay recorded only in the findings array, never fabricated. We rejected carrying findings on an ambiguous attribution: a finding matching more than one provenance `perAngle` row keeps ADR 0030's conservative always-rerun behavior, so a finding can never be silently dropped off one sibling or double-counted onto both.

## Consequences

Every fail-closed guard from ADR 0030 is retained and is now pinned by tests against a findings-present prior verdict, not just clean: ambiguous attribution, mandatory and `ALWAYS_INCLUDE` angles, a config-source-touching or unclassifiable delta, a rename, and an angle with no mapped surface all still force re-run. Iterative non-clean PRs now pay re-review cost proportional to real change instead of commit count, closing the gap where a single lingering finding re-fanned the whole gate every retry. The rule of record `GATE-EXEC-ANGLE-CARRY-FORWARD` (and its `GATE-EXEC-REGATE-MANDATORY` cross-reference) in `skills/docs/gate-review-sub-loop-contract.md` is updated in lockstep so the durable contract and the shipped code agree; the immutable core principle of ADR 0030 — carry only when the delta provably misses the surface — is unchanged, extended to non-clean angles without softening any guard.
