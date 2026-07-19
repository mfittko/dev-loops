# 0005. Steer running loops through a bounded, schema-validated event layer with safe-point classification

## Status

Accepted

## Context

Operators needed to tighten or redirect a running dev loop — for example, ask it to stop before its next mutation gate — without killing and restarting the run. The obvious mechanism, injecting free-form text into the running agent's prompt, leaves no auditable record of what was changed and can interrupt non-interruptible GitHub mutations such as the multi-step reply-and-resolve pass, leaving review threads half-resolved. The contract landed with the first implementation slice in [pull 47](https://github.com/mfittko/dev-loops/pull/47) for [issue 46](https://github.com/mfittko/dev-loops/issues/46), targeting the async Copilot review/fix loop as the proving loop family. The canonical rules live in `docs/steering-contract.md`, implemented by `packages/core/src/loop/steering.mjs` (core) and `scripts/loop/steer-loop.mjs` (CLI).

## Decision

We steer running loops through schema-validated events carrying monotonically increasing `seq` numbers, persisted to a durable JSON state file (`.pi/steering/...`) and applied only at safe points: `classifySafePoint` maps each loop state to IMMEDIATE (applied now), NEXT_POINT (durably queued, promoted at the next safe point), or TERMINAL (rejected), and every submitted event receives exactly one deterministic acknowledgement class. We narrow the external v1 submit contract to a single directive kind, `stop_at_next_safe_gate`, rejecting `hard_constraint`, `preference`, and `clarification` on the operator-facing path even though the core state model supports them. We split observation from control — `inspect-run` owns the read-only snapshot and steering readback, `steer-loop` owns bounded mutation — and live-steering availability fails closed: a steering file's presence never implies steering is usable unless inspection evidence is authoritative and marker-free. We explicitly rejected free-form prompt injection into a running child (unauditable, no acknowledgement) and rejected mutation rewrites mid-way through non-interruptible actions.

## Consequences

Every future steerable loop family must adopt the same durable event log and safe-point classification, which keeps steering auditable (full history is inspectable at any time) and mutation-safe (directives arriving during atomic GitHub mutations queue instead of interrupting). The narrow v1 scope means richer operator directives require deliberate contract extension — new kinds, new acknowledgement semantics — rather than ad-hoc strings smuggled into prompts. Fail-closed advertisement adds friction: operators may see steering as unavailable in degraded or snapshot-only inspection modes even when a steering file exists, which is the intended trade against acting on untrusted state.
