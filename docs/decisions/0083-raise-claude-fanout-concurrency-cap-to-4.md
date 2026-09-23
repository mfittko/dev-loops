# 0083. Raise the Claude-harness fan-out concurrency cap from 2 to 4

## Status

Accepted — 2026-09-23 ([issue 2366](https://github.com/mfittko/dev-loops/issues/2366))

Amends [0069](./0069-claude-harness-fanout-concurrency-clamp.md): the clamp mechanism <!-- secret-scan:allow relative ADR filename cross-reference links, not credentials -->
(`resolveFanoutEffectiveConcurrency` scoping `CLAUDE_MAX_EFFECTIVE_CONCURRENT` to
`isClaudeHarness(env)`) stands unchanged; this record raises only the constant's value, from 2
to 4, because the retry/backoff policy 0056 introduced and 0069 turned into a tested function is
expected to absorb the 429 risk that motivated the lower value, backed by the measured round
below.

## Context

ADR 0069 set `CLAUDE_MAX_EFFECTIVE_CONCURRENT = 2` to keep a single-driver Claude session's
per-wave burst (driver + dispatch units) below the point where it 429s. ADR 0056 introduced the
retry-on-transient discipline (`GATE-EXEC-DISPATCH-RETRY-BACKOFF`); ADR 0069 turned it into the
tested pure function `planDispatchRetry` (`packages/core/src/loop/gate-fanin.mjs`): a 429 or 5xx
retries the same dispatch unit on a 30s/60s/120s schedule, safe because each unit's write is
idempotent and single-write
(`GATE-EXEC-COLLECTABLE-DISPATCH`), and from the third failed attempt the conductor halves the
active batch via `backoffMaxConcurrent`. A 429 under that policy costs latency, not a dead
drive.

With the retry policy in place, the cap of 2 now serializes gate rounds more than the 429 risk
requires. On PR 2250 a 5-unit `draft_gate` round ran as primer + 2 + 2: three waves where the
retry policy would tolerate a wider single wave. This repo's `.devloops`
`gates.fanout.maxConcurrent` stays 3 (ADR 0056); under the old cap of 2 this repo's Claude
effective value was `min(3, 2) = 2`, one below its own configured intent.

## Decision

Raise `CLAUDE_MAX_EFFECTIVE_CONCURRENT` from 2 to 4 in
`packages/core/src/config/config.mjs`. `resolveFanoutEffectiveConcurrency` keeps clamping only
under `isClaudeHarness(env)`; every other harness (Pi, unknown, no marker) is unaffected. This
repo's `.devloops` `gates.fanout.maxConcurrent` stays 3 (unchanged, not this record's concern),
so this repo's Claude effective value becomes `min(3, 4) = 3`: a driver plus a 3-unit wave.

A driver + 3 wave is the same burst size 0069 observed 429ing at driver + 3 = 4 concurrent
streams. The cap's remaining job is not preventing a 429 outright — the retry/backoff policy
already turns an isolated 429 into a delayed retry on the same unit, and `backoffMaxConcurrent`
halves the batch after repeated failures. The cap's job is bounding the steady-state burst so a
Claude session is not routinely dispatching an unbounded number of concurrent high-tier streams
per wave. A cap of 4 keeps that bound while removing the over-serialization the retry policy
made unnecessary.

Rejected: removing the clamp entirely. An operator repo configuring
`gates.fanout.maxConcurrent` above 4 (for example 8) would then dispatch driver + 8 under
Claude with no clamp at all — an unbounded residual risk with no known-safe ceiling. Keeping a
cap, even a wider one, preserves a known bound that the retry policy backstops; removing it
trades a bounded, retry-backstopped risk for an unbounded one. The residual risk this record
does accept: a consumer repo running the shipped default of 4 now dispatches driver + 4 under
Claude, unclamped relative to before (`min(4, 4) = 4` instead of `min(4, 2) = 2`), bounded by
the same retry policy.

Adherence to the retry helper remains conductor-behavioral: ADR 0069's Consequences already note
that no script seam forces the conductor to call `planDispatchRetry`, so the measured gate round
below is the evidence that the backstop holds in practice, not a mechanical guarantee.

### Measured gate round

The `draft_gate` round 1 on PR 2384 at head `ec831c65808ec3a9fe4d73486a5ad2a1f875e369`, run under
the Claude harness with this branch's code, is the measured evidence:

- Emitter `maxConcurrent` 3 (`min(3, 4)`); 6 dispatch units covering 10 config-resolved angles.
- Executed as primer (1 unit, serialized per `GATE-EXEC-PRIME`) + 3 + 2: never more than 3
  reviewers in flight.
- Wall clock 2026-09-23T05:59:41Z to 06:18:13Z, 1112s total; reviewer critical path about 341s
  (108 + 108 + 125s agent runtime). The remainder was conductor overhead relaying the per-unit
  prompt, which is serial per wave and independent of concurrency.
- 429 failures: 0; 5xx failures: 0; retries: 0; backoff halving: none. All 6 units completed on
  the first attempt, with no unrecovered 429.

One round with zero 429s is limited evidence: it shows driver + 3 did not 429 in this round; it
does not prove it never will. The retry policy remains the backstop.

## Consequences

- This repo's Claude effective concurrency rises from 2 to 3 (driver + 3), reducing the number
  of waves a multi-unit gate round needs. The measured round above (PR 2384, 6 units) ran as
  primer + 3 + 2; at the old cap of 2 the same round would have run as primer + 2 + 2 + 1.
- Pi and unknown-harness behavior is unchanged: `resolveFanoutEffectiveConcurrency` returns the
  configured value unclamped for both, exactly as under 0069.
- The retry/backoff policy (`GATE-EXEC-DISPATCH-RETRY-BACKOFF`, introduced by 0056 and turned
  into the tested `planDispatchRetry`/`backoffMaxConcurrent` by 0069) is unchanged and still the
  mechanism that turns a 429 into latency instead of a failed drive; this record does not touch
  it.
- A consumer repo at the shipped default `gates.fanout.maxConcurrent: 4` now dispatches driver +
  4 under Claude (previously driver + 2). That is an accepted residual risk, bounded by the
  unchanged retry/backoff policy rather than by the clamp; if it proves insufficient, the fix is
  a further ADR revisiting the constant, never a silent edit of this one
  (`ADR-SUPERSEDE-NOT-REWRITE`).

## References

- `packages/core/src/config/config.mjs`: `CLAUDE_MAX_EFFECTIVE_CONCURRENT`,
  `resolveFanoutEffectiveConcurrency`
- `packages/core/src/loop/gate-fanin.mjs`: `planDispatchRetry`, `backoffMaxConcurrent`
- `skills/docs/gate-review-sub-loop-contract.md`: effective-concurrency paragraph
- ADR 0069 (Claude-harness-scoped fan-out concurrency clamp and a testable dispatch-retry
  policy) — amended by this record
- ADR 0056 (bounded-parallel gate dispatch) — `.devloops` `gates.fanout.maxConcurrent: 3`,
  unchanged
