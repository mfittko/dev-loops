# 0160. The coordinator execution identity uses the `c` prefix

## Status

Accepted — 2026-10-18 ([issue 2483](https://github.com/mfittko/dev-loops/issues/2483))

Amends [ADR 0115](./0115-dispatch-pointer-carries-the-execution-identity-alone.md): that record fixes `EXECUTION_IDENTITY_RE` at `/^[rjf]\d+-[0-9a-f]{8}(?:-u\d+)?$/` and lists only the `r`, `j` and `f` minted shapes. Record 0115 stays unedited.

## Context

The coordinator work order is pulled through `pull-work-order.mjs` like the review, judge and fixer orders. Its dispatch pointer carries an execution identity, and that identity needs a prefix that names the coordinator role.

## Decision

- The coordinator emitter mints `c<ms>-<8 hex>` for a coordinator execution.
- `EXECUTION_IDENTITY_RE` in `packages/core/src/loop/work-order-digest.mjs` widens to `/^[rjfc]\d+-[0-9a-f]{8}(?:-u\d+)?$/`. It stays the one execution identity pattern.
- The pull maps the `c` prefix to the `coordinator` role in its identity role table. An identity whose prefix role differs from its index entry's ref role is `dispatch_identity_mismatch`, as for the other prefixes.
- Every other rule of ADR 0115 applies to the `c` identity unchanged.

## Consequences

A reader who needs the identity grammar reads ADR 0115 together with this record. The generated hook mirror carries the widened pattern.
