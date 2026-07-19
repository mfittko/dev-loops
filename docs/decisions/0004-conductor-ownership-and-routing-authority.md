# 0004. Centralize run ownership, idempotency, and outer-loop routing authority in the conductor

## Status

Accepted — 2026-05-18 ([PR 55](https://github.com/mfittko/dev-loops/pull/55))

## Context

Multiple concurrent sessions could start or resume loops against the same issue or PR, producing duplicate live owners and conflicting actions, because ownership was inferred from ad hoc local state instead of one shared policy surface ([PR 55](https://github.com/mfittko/dev-loops/pull/55)). Even once ownership and family-local lifecycle state were known, no single bounded evaluator answered which loop family owns the next step — routing logic was scattered across skill prose and ad-hoc orchestration scripts ([PR 66](https://github.com/mfittko/dev-loops/pull/66)). Watcher presence also needed to be encoded explicitly as non-owning so read-only sessions could not be mistaken for owners. The resulting contracts live in `skills/docs/conductor-routing-contract.md` and, historically, `packages/core/src/loop/conductor-ownership.mjs` and `docs/conductor-ownership-contract.md`.

## Decision

We make a conductor layer the single authority over run identity and outer-loop routing. It owns normalized singleton ownership keys per target, live-owner predicates with watcher-only state as non-owning, an idempotency policy for repeated start/kickoff/resume/watch invocations, and a closed outcome taxonomy — with authoritative live state taking precedence over provisional local state. `evaluateConductorRouting` is the one routing authority for outer-loop actions: it derives one of seven closed outcomes (including `stay_with_current_live_owner` and fail-closed `needs_reconcile`) directly from normalized state inputs. Rejected alternative: an evaluator that remaps a pre-computed outer-loop action — `decideOuterAction` survives only as a thin backward-compat adapter with no branch logic of its own. Also rejected: leaving routing decisions distributed across skill prose and orchestration scripts, and inferring ownership from whatever local state a session happened to hold.

## Consequences

Runner locks, queue pickup, one-runner-per-PR coordination (`scripts/loop/_pr-runner-coordination.mjs` with its `active_run_exists` / `ownership_lost` error taxonomy), and duplicate-owner suppression all assume this ownership contract. Any new orchestration surface must route through `evaluateConductorRouting` rather than inventing its own arbitration, and fail-closed outcomes never carry a live handoff envelope. The standalone ownership evaluator module was later retired in a cleanup wave; `ownershipState` remains an optional caller-supplied input to the routing evaluator, so the ownership-aware branches stay implemented and tested but dormant until a caller resolves ownership. The routing contract and its seven-outcome taxonomy remain the binding surface that downstream loop families build against.
