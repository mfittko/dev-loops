# 0341. ADR 0074 delivered parts and withdrawn sections

## Status

Accepted — 2026-11-28 ([issue 3476](https://github.com/mfittko/dev-loops/issues/3476)).

Amends [ADR 0074](./0074-deterministic-reconciliation-owns-mechanical-transitions.md): sections 5 and 19 to 24 are withdrawn. The record that introduced them stays unedited.

## Context

ADR 0074 has more than 1,200 lines. A search of `packages`, `scripts` and `skills` finds no citation of it. Its sections 5 and 19 to 24 require an action envelope, a contract and policy identity, in-flight compatibility rules, typed steering input, a supervisor seam and a fixture-first cutover. None of them exists in code or in a contract. A reader of the ADR cannot tell which parts shipped.

## Decision

The direction of sections 1 to 4, 6 to 18 and 25 stays accepted. Mechanical lifecycle decisions come from deterministic code over refreshed authorities, and a model decides only where judgment is needed. The parts that shipped, each under its own owner:

- Carry-forward proof and pre-dispatch enforcement: `packages/core/src/loop/gate-carry-forward.mjs` and `packages/core/src/loop/base-merge-verdict-carry.mjs`.
- Validation identity before expensive validation: `scripts/loop/resolve-validation.mjs` and `scripts/loop/validation-record.mjs`.
- Single-owner waits: `packages/core/src/loop/watcher-exclusivity.mjs`.
- Bounded reviewer units and compact execution records: `packages/core/src/loop/reviewer-unit-bound.mjs` and `packages/core/src/loop/execution-record.mjs`.
- Typed routing and gate selection: `packages/core/src/loop/public-dev-loop-routing.mjs` and `packages/core/src/loop/conductor-routing.mjs`.

Sections 5 and 19 to 24 are withdrawn and not scheduled:

- Section 5, the typed `NextAction` envelope.
- Section 19, contract and policy identity.
- Section 20, in-flight policy compatibility.
- Section 21, steering and cancellation as typed reconciliation input. Steering runs under `docs/steering-contract.md`.
- Section 22, the supervisor seam.
- Section 23, fixture-first migration and shadowing.
- Section 24, exclusive cutover and rollback.

The ADR 0074 consequences that depend on these sections are withdrawn with them: "Software upgrades do not require draining active runs", "A future supervisor has a clear seam", "Delivery is intentionally aggressive" and "Verification and cutover criteria are correctness-first".

A new proposal for any of them needs its own record.

## Consequences

ADR 0074 reads as an architecture direction with a named delivered set. No contract or code cites a withdrawn section. The role budget bound and the child launch bound that issue 3476 deletes were never part of the delivered set.
