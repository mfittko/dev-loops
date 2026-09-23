# 0083. Raise the Claude-harness fan-out concurrency cap from 2 to 4

## Status

Accepted — 2026-09-23 ([issue 2366](https://github.com/mfittko/dev-loops/issues/2366))

Amends [0069](./0069-claude-harness-fanout-concurrency-clamp.md): the clamp mechanism <!-- secret-scan:allow relative ADR filename cross-reference links, not credentials -->
(`resolveFanoutEffectiveConcurrency` scoping `CLAUDE_MAX_EFFECTIVE_CONCURRENT` to
`isClaudeHarness(env)`) stands unchanged; this record raises only the constant's value, from 2
to 4, because the retry/backoff policy 0069 itself introduced already absorbs the 429 risk that
motivated the lower value.

## Context

ADR 0069 set `CLAUDE_MAX_EFFECTIVE_CONCURRENT = 2` to keep a single-driver Claude session's
per-wave burst (driver + dispatch units) below the point where it 429s. That record also
introduced `GATE-EXEC-DISPATCH-RETRY-BACKOFF` (`planDispatchRetry`,
`packages/core/src/loop/gate-fanin.mjs`): a 429 or 5xx retries the same dispatch unit on a
30s/60s/120s schedule, safe because each unit's write is idempotent and single-write
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

Rejected: removing the clamp entirely. An operator repo whose configured
`gates.fanout.maxConcurrent` is the shipped default (4) would then dispatch driver + 4 under
Claude with no clamp at all — an unbounded residual risk with no known-safe ceiling. Keeping a
cap, even a wider one, preserves a known bound that the retry policy backstops; removing it
trades a bounded, retry-backstopped risk for an unbounded one. The residual risk this record
does accept: a consumer repo running the shipped default of 4 now dispatches driver + 4 under
Claude, unclamped relative to before (`min(4, 4) = 4` instead of `min(4, 2) = 2`), bounded by
the same retry policy.

### Measured gate round

MEASUREMENT-PENDING: the draft_gate round on this PR at effective concurrency 3 is recorded here before merge.

## Consequences

- This repo's Claude effective concurrency rises from 2 to 3 (driver + 3), reducing the number
  of waves a multi-unit gate round needs (issue 2366's PR-2250 example: 5 units would now run
  as primer + 3 + 2 or similar, fewer waves than before).
- Pi and unknown-harness behavior is unchanged: `resolveFanoutEffectiveConcurrency` returns the
  configured value unclamped for both, exactly as under 0069.
- 0069's retry/backoff policy (`planDispatchRetry`, `backoffMaxConcurrent`,
  `GATE-EXEC-DISPATCH-RETRY-BACKOFF`) is unchanged and still the mechanism that turns a 429 into
  latency instead of a failed drive; this record does not touch it.
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
