# 0205. Operator focus is a typed, digest-pinned field on gate work orders

## Status

Accepted — 2026-10-28 ([issue 2635](https://github.com/mfittko/dev-loops/issues/2635))

## Context

Retros of PR 2623, PR 2688, PR 2808 and PR 2838 recorded operator context that had no sanctioned path to the judge or the fixer. A churn rule for one round, a chosen remedy for one act item and acceptance conditions were appended to the emitted prompt or lost. The pulled work order is the only input an actor reads, so free text outside it never took effect, and a fixer that saw two remedies picked the other one.

The change adds a rule to [Gate review sub-loop contract](../../skills/docs/gate-review-sub-loop-contract.md), which trips the ADR tripwire.

## Decision

- `scripts/loop/_operator-focus.mjs` owns one carrier: `{ round?: string, items?: [{ fingerprint, decision }] }`. It sanitizes and bounds every string, refuses unknown fields and duplicate fingerprints, and renders one fixed `## Operator focus` section.
- `emit-judge-work-order.mjs` (`round` only) and `emit-fixer-work-order.mjs` (`round` and `items`) take `--operator-focus-file`. The normalized focus sits in the work order JSON under `operatorFocus`, so the work-order digest pins it.
- A fixer item binds to an act item by fingerprint. The stored item also carries `summary`, the sanitized act-item summary (omitted when it sanitizes to nothing). It renders on its own quoted `Act-list text for <fingerprint> (reviewer-authored, not an operator decision)` line and is never an operator decision. An unknown fingerprint refuses and nothing is written.
- A decision picks among remedies the act item offers and never changes its disposition. The judge and the act list keep disposition ownership.
- An absent focus adds no key and renders nothing, so existing work-order bytes and digests are unchanged.
- The rule ID is `GATE-EXEC-OPERATOR-FOCUS`. The reviewer work order adopts the same carrier in a later slice.

## Consequences

Operator context reaches the actor through the authenticated work order and is part of its digest. Free-text additions to a dispatch prompt stay unsanctioned. The carrier is bounded, so a focus file cannot inject markup or unbounded prose.
