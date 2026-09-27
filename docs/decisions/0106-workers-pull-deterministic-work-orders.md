# 0106. Workers pull deterministic work orders by compact reference

## Status

Accepted — 2026-09-27 ([issue #2282](https://github.com/mfittko/dev-loops/issues/2282), first slice [issue #2416](https://github.com/mfittko/dev-loops/issues/2416))

Amends [ADR 0086](./0086-gate-fanout-reference-seeded-work-orders.md): the conductor no longer relays the emitted work order bytes to the reviewer. It keeps the rest of that decision unchanged: reference seeding, the `requiredReads` manifest, the 30 KB work-order bound and the inline invariant prefix at the head of the emitted work order. It also amends section 4 of [ADR 0081](./0081-harness-mediated-agent-io-context-contained.md): the rule that a path-only reviewer request is non-compliant no longer holds for a compact reference that the worker verifies and pulls through the sanctioned pull CLI.

## Context

ADR 0086 bounded each reviewer work order, but the coordinator still copied every work order into an agent-authored tool argument. On Claude Code that relay is the coordinator's own output, so it grows with the number of units per round and with the number of rounds. The relay is also unobservable: the layout check proves that the recorded prompt matches the emitted file, never that the delivered task matches it. Judge, fixer and refiner dispatches have the same shape and the same gap.

## Decision

Every worker role receives only a compact dispatch envelope: a one-line instruction to run the pull CLI with the concrete `workOrderRef`, `workOrderDigest` and `executionIdentity` and follow the printed work order, capped once at `DISPATCH_POINTER_MAX_BYTES` (499 bytes). The envelope is self-describing, so a worker whose agent definition lags still pulls, and carries no task prose. A deterministic emitter writes the work order; no model authors it, and a model-authored brief is never a sanctioned fallback.

The worker runs `pull-work-order.mjs` first. The CLI selects a role adapter by the ref's role prefix, verifies the reference against the canonical emitted unit, prints the exact emitted bytes and writes a pull receipt under the main checkout's `tmp/work-order-receipts/`. Its only write is that receipt, so a read-only role pulls through the sanctioned command without an unrestricted shell. It refuses by name: `dispatch_reference_mismatch` (retryable; re-dispatch the same unit, never retire the round), `dispatch_identity_mismatch`, `stale_dispatch` (a retired or superseded round is never retargeted to the newest one), `unknown_role`, `invalid_work_order`, `semantic_identity_mismatch` and `local_materialization_integrity_failure`.

`workOrderDigest` is the sha256 of the canonical semantic work order. Absolute checkout, worktree, tmp and output paths are local materialization and are excluded; repository-relative paths stay semantic. `materializationHash` is the sha256 of the local work-order bytes. Result consumers call one receipt-verification API. A missing or mismatched receipt fails closed, and a receipt without a result is an interrupted worker, never a success.

The gate reviewer slice lands now (#2416). The judge (#2419) and fixer (#2420) register their own role adapters on the same interface later. Regenerating a missing or corrupt local work order is out of scope here (#2418); this slice classifies and refuses it. Until #2418 re-derives the work order from canonical inputs, the `semantic_identity_mismatch` check proves plan self-consistency only: the emitted work order still reproduces the digest recorded beside it in the emit plan.

We rejected keeping the byte relay, because its cost grows with every dispatch and it proves nothing about delivery. We rejected a generic store for authored briefs, because it would bless model-authored work orders.

## Consequences

Coordinator output per dispatch is bounded by the envelope cap, and the pull receipt turns delivered-task identity into checked evidence. A worker whose harness cannot run the pull CLI cannot take part in this protocol. The transcript audit reports `agentDispatch` bytes per dispatch for Claude coordinators, so the reduction stays measurable. `test/github/pull-work-order.test.mjs` pins the pull behavior and `test/loop/consolidate-fanin.test.mjs` pins the fan-in receipt checks.
