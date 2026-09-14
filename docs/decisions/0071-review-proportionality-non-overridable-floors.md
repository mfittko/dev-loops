# 0071. Review-proportionality dispatch plan: risk-path denylist and size-outcome as non-overridable floors

## Status

Accepted — 2026-09-14 ([issue 1984](https://github.com/mfittko/dev-loops/issues/1984))

## Context

Gate fan-out did not scale to change size/risk: every PR paid the full multi-angle
draft + pre-approval fan-out, even a 12-logic-LOC docs+test change. The light-mode
inline-single-agent path already existed (`localImplementation.lightMode`,
`resolveGateDispatchMode`), but it was a coarse binary gated only on raw file/line
counts — nothing stopped a tiny diff that happened to touch a security-, gate-, or
release-critical path from taking the light path, and nothing forced full review when
a diff's `check-size-budget.mjs` outcome (escalate/block/T1) said the change was
riskier than its raw line count implied. Proportionality otherwise lived only in the
orchestrator's prompt — a skippable, human-remembered step.

This record documents the two DECISION-SHAPED artifacts issue 1984 introduces: the
exact risk-path denylist (which trees are conservatively over-inclusive) and the rule
that the size-budget outcome is itself a floor, not merely a merge-time signal.
Everything else in the issue (the pure composer, the merge-gate re-verify, the ADR
tripwire wiring) is mechanism, not policy, and is not restated here.

## Decision

- **A hard-coded, union-of-layers risk-path denylist is a floor, not a config
  default.** `RISK_PATH_DENYLIST_DEFAULT` (`packages/core/src/config/config.mjs`)
  ships as a frozen JS constant — never sourced purely from `.devloops`/
  extension-defaults YAML layers — covering seven trees: gate/review (the
  dispatch-decision and fan-out/fan-in machinery itself, including its own
  implementation files), security/auth (path segments naming auth/token/secret/
  credential, plus `scripts/security/**`), contract (`skills/docs/*-contract.md`,
  `test/contracts/**`, `docs/decisions/**`), hook (`.claude/hooks/**`,
  `.githooks/**`, `scripts/**/*hook*`), and release (publish/tag scripts, release CI
  workflows, `package.json`). Every glob is deliberately OVER-inclusive
  (`ambiguity resolves toward MORE review`). A repo may only ADD extra globs via
  `localImplementation.lightMode.riskPaths`; this config field can never remove or
  replace the shipped floor. Rejected: shipping the list itself in
  `extension-defaults.yaml` — that layer's own one-level-shallow merge
  (`mergeConfigLayers`) would let a repo's own `localImplementation.lightMode` block
  (which every `.devloops` opting into light mode already sets, for `maxFiles`/
  `maxLines`) silently drop the shipped list wholesale on merge, defeating "shipped
  default never removable." A hard-coded JS constant, always unioned in at the
  predicate itself (`touchesRiskPath`), has no such hazard — the same pattern
  `DEFAULT_DIFF_EXCLUDE_GLOBS` (`review-dispatch-plan.mjs`) already uses.
- **The size-budget outcome is a dispatch floor, not only a merge-time-only
  signal.** `resolveGateDispatchMode` now forces `full_fanout` whenever the diff's
  `check-size-budget.mjs` outcome is not a clean `pass`, OR its T1-tier slice is
  nonzero — reusing `computeSizeBudget` as-is, no new computation. A diff can be
  trivially small in raw file/line count yet substantial in `logicLoc` (heavy
  comment/whitespace ratio aside) or land inside a configured T1 risk slice; the
  light path must not open for either case.
- **Absence of evidence is ambiguity, and ambiguity is a floor too.** A missing/
  unreadable `changedFiles` list or size-budget outcome forces `full_fanout`
  (`changed_files_unavailable`, `size_outcome_unavailable`) exactly like a real
  risk-path touch or a bad size outcome — never treated as "probably fine."
- **A `.devloops` change to the cap or the risk-path addition field is itself
  decision-shaped.** `check-adr-tripwire.mjs` gains a `devloops-proportionality`
  trigger: a base-vs-head value change (add, modify, or remove) on
  `localImplementation.lightMode.maxFiles`/`maxLines`/`riskPaths` requires an ADR or
  waiver, mirroring the existing `extension-defaults.yaml` gate-config trigger for
  the shipped side of the same fields.

## Consequences

- A genuinely trivial, non-risk-path, size-budget-passing diff still takes the light
  path exactly as before; nothing here narrows that case.
- A tiny diff that touches a risk-path file, or whose size-budget outcome is
  escalate/block/T1, now always pays the full fan-out — a slight increase in review
  cost for that (deliberately rare, over-matched) intersection, which is the
  intended trade: cost scales down only on PROVABLE triviality.
- The risk-path floor's authoritative list lives in one place
  (`RISK_PATH_DENYLIST_DEFAULT`) with its own inline per-category rationale; this
  record and `skills/docs/gate-review-sub-loop-contract.md`'s
  "Review-proportionality dispatch plan" section intentionally point to it rather
  than duplicating the glob list, so the two can never drift.
- A future repo wanting to loosen or tighten the cap, or add its own risk paths, now
  needs an ADR or a `adr-tripwire:allow` waiver for that `.devloops` edit — a small
  new friction, accepted because review rigor is exactly what these fields govern.

## References

- `packages/core/src/config/config.mjs`: `RISK_PATH_DENYLIST_DEFAULT`,
  `touchesRiskPath`, `resolveGateDispatchMode`, `resolveReviewProportionality`
- `scripts/loop/check-size-budget.mjs`: `computeSizeBudget`, `evaluatePrSizeBudget` (reused, unchanged)
- `scripts/github/detect-checkpoint-evidence.mjs`: `buildFanoutEnforcement`'s `scopeUnderThreshold` re-derivation
- `scripts/loop/check-adr-tripwire.mjs`: `devloops-proportionality` / `unresolvable-devloops-scan` triggers
- `skills/docs/gate-review-sub-loop-contract.md`: `GATE-EXEC-PROPORTIONALITY`
- `packages/core/src/loop/review-dispatch-plan.mjs`: `DEFAULT_DIFF_EXCLUDE_GLOBS` (the precedent this record's denylist mechanism follows)
