# 0049. Serial (one-at-a-time) heavy-reviewer fan-out dispatch bound

## Status

Accepted — 2026-08-15 ([issue 1726](https://github.com/mfittko/dev-loops/issues/1726))

Amends the dispatch-concurrency half of [0048](./0048-gate-full-dispatches-grouped-two-knob-dispatch-bounds.md): it keeps the two knobs (`maxAnglesPerGroup`, `maxConcurrent`) and adds `gates.fanout.sequential` as the serial heavy-reviewer bound so a genuine multi-angle fan-out completes instead of SIGTERMing N heavy reviewers at once.

## Context

PR #1725 / issue #1669 reproduced a hard failure in the child-safe subagent environment: the gate fan-out dispatched **five heavy reviewer subagents in parallel**, and all five **SIGTERM'd** under resource overload before writing their per-angle evidence artifacts — no per-angle evidence, so fan-in could not consolidate and the gate stalled. A single trivial subagent completed, confirming this was **parallel overload**, not a per-reviewer defect. #1723 restored real-fan-out-required (a gate needs distinct-reviewer fan-out evidence), so this concurrency bug now blocks every PR's gate: the gate correctly requires evidence the parallel fan-out cannot produce in this environment.

`gates.fanout.maxConcurrent` (default 4, #1601/ADR 0048) already bounds fan-out to M dispatch units per wave, but **4 heavy reviewers in one wave is still too much** for this environment. The fix direction (operator, 2026-08-15): dispatch heavy reviewers **sequentially (one at a time)** or with a small explicit cap (1-2), keep genuine distinct reviewers (real fan-in / provenance / findings-ledger), and make the bound a **gate fan-out config/mechanism that holds for all PRs** — never a per-run luck, never a regression to inline single-agent.

## Decision

Add `gates.fanout.sequential` (boolean, default `false`) as a first-class fan-out dispatch bound:

- When `true`, effective fan-out concurrency is **one dispatch unit per wave**, regardless of `maxConcurrent` — the conductor dispatches heavy reviewers one at a time, so each completes and writes its evidence artifact before the next starts.
- The wave plan is built from `resolveFanoutEffectiveConcurrency(config)` (`@dev-loops/core/config`): returns `1` when `sequential` is set, else `resolveFanoutMaxConcurrent`. `write-gate-context.mjs` emits both `artifact.fanout.sequential` and `artifact.fanout.effectiveConcurrency` alongside the configured `maxConcurrent`, so the gate-context artifact records the applied serial posture.
- It bounds **concurrency only**: dispatch units, per-angle findings artifacts, distinct-reviewer provenance, the findings-ledger, and fan-in consolidation are all unchanged. This is a genuine multi-reviewer fan-out (real fan-in), never a collapse to inline single-agent.
- The default stays `false` for **cross-harness non-regression** (#1086): other harnesses/repos keep the existing `maxConcurrent` behavior. A repo opts in via `.devloops` (this repo sets `gates.fanout.sequential: true`) so the bound holds for **all its PRs**.

`maxConcurrent` remains the "small parallel cap" knob for a repo that wants bounded parallelism (e.g. `maxConcurrent: 2`, `sequential: false`) rather than full serialization.

## Consequences

- Heavy reviewer fan-out no longer SIGTERMs under parallel overload; each heavy reviewer completes and writes evidence, real fan-in consolidates a genuine multi-distinct-reviewer verdict.
- Gate latency rises for multi-angle rounds (reviewers run one at a time), which is the accepted trade for reliability in this environment.
- Cross-harness default is unchanged (`sequential` defaults false), so no other harness/repo regresses.
