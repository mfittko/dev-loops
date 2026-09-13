# 0069. Claude-harness-scoped fan-out concurrency clamp and a testable dispatch-retry policy

## Status

Accepted — 2026-09-13 ([issue 1971](https://github.com/mfittko/dev-loops/issues/1971))

Amends [0056](./0056-bounded-parallel-gate-dispatch.md) (which itself amended
[0049](./0049-sequential-fanout-dispatch-bound.md)): the bounded-parallel default and the <!-- secret-scan:allow relative ADR filename cross-reference links, not credentials -->
retry-on-transient discipline it introduced stand; this record adds a Claude-harness-scoped
concurrency clamp on top and turns the retry schedule/classification into a pure, tested
function instead of prose the conductor re-derives. `gates.fanout.maxConcurrent` (default 4,
ADR 0048) and this repo's `.devloops` override (3) are unchanged; no config surface or schema
change ships.

## Context

Gate fan-out review under the Claude Code harness trips the single-driver session's aggregate
model-call budget (HTTP 429) and the whole drive dies: a wave's burst is the driver's own call
plus up to `maxConcurrent` concurrently dispatched reviewer units, and this repo's shipped
`.devloops` `maxConcurrent: 3` (from ADR 0056) means a full wave is 4 concurrent high-tier
streams on a harness whose session budget cannot sustain that. `resolveFanoutEffectiveConcurrency`
(`packages/core/src/config/config.mjs`) is the single choke point both dispatch callers
(`scripts/github/write-gate-context.mjs`, `scripts/github/emit-fanout-dispatch.mjs`) route
through, but it was not harness-aware — nothing scoped the value to the Claude harness, so the
only prior mitigation (lowering `.devloops` or setting `sequential: true`) is an
operator-imposed manual throttle, not a safe default (issue 1971, AC1/AC3).

Separately, ADR 0056's retry-on-429 discipline (`GATE-EXEC-DISPATCH-RETRY-BACKOFF`) was
contract/prompt-driven only: reviewers are spawned by the conductor agent via the plain Agent
tool, with no script seam to hold a retry loop, so the 30s/60s/120s schedule and the
transient-vs-hard-4xx classification existed only as prose the conductor could skip or
misremember — the root cause of the retry "not reliably held" (issue 1971, AC2).

## Decision

- **`CLAUDE_MAX_EFFECTIVE_CONCURRENT = 2`, applied only under `isClaudeHarness(env)`.**
  `resolveFanoutEffectiveConcurrency(config, env = process.env)` now clamps its base result
  (`resolveFanoutMaxConcurrent`, or `1` when `gates.fanout.sequential`) to
  `Math.min(base, CLAUDE_MAX_EFFECTIVE_CONCURRENT)` when the Claude harness marker
  (`CLAUDECODE=1`, `isClaudeHarness`) is present in `env`; every other harness (pi, unknown, no
  marker) returns the configured value unchanged. This bounds a Claude session's wave burst to
  driver + 2 (3 concurrent high-tier streams), strictly below the driver + 3 = 4 that still
  429s, as the DEFAULT — no `.devloops` override or `sequential: true` fallback required. The
  shipped `gates.fanout.maxConcurrent` zod default (4) and this repo's `.devloops` override (3)
  are byte-unchanged; the clamp fires at resolve time, not at the config surface. Rejected: a
  lower global default (regresses every other harness/repo, forbidden by issue 1971's
  non-goals) and a new tunable `gates.fanout.claudeMaxConcurrent` knob (YAGNI — one internal
  constant is the smaller fix; add a knob only when an operator needs to tune it).
- **`planDispatchRetry(attempt, errorClass)`** (`packages/core/src/loop/gate-fanin.mjs`, next to
  `backoffMaxConcurrent`) encodes `GATE-EXEC-DISPATCH-RETRY-BACKOFF` as a pure, tested function:
  a transient error (429 or any 5xx) retries the same unit on delays `[30000, 60000, 120000]`ms
  and signals `reduceConcurrency: true` starting at the 3rd exhausted attempt (deferring the
  actual halving to `backoffMaxConcurrent`); a hard 4xx (e.g. `402`) returns
  `{ retry: false, escalate: true }` — never retried into the same wall. The retry never aborts
  the round on a transient failure. The idempotent single-write guarantee
  (`GATE-EXEC-COLLECTABLE-DISPATCH`) that makes a same-unit retry safe already existed and is
  unchanged; this record adds only the confirming test, not new write-path code.

## Consequences

- A single-driver Claude session completes a full gate round at the shipped default with no
  operator-imposed manual throttle; other harnesses/repos see byte-identical
  `resolveFanoutEffectiveConcurrency` behavior (cross-harness non-regression, issue 1971 AC3).
- The retry-on-transient discipline is now mechanically testable
  (`packages/core/test/gate-fanin.test.mjs`), though adherence stays partly behavioral: reviewer
  dispatch is still agent-spawned with no script seam forcing the conductor to call
  `planDispatchRetry`; the reduced burst (fewer 429s to begin with) is the primary mitigation,
  and the doc's MUST wording now names the helper explicitly.
- If a heavy round still 429s at driver + 2 on Claude, the clamp value is the thing to revisit
  (dropping to 1 would serialize fan-out on Claude) — a follow-up record, never a silent edit of
  this one (`ADR-SUPERSEDE-NOT-REWRITE`).

## References

- `packages/core/src/config/config.mjs`: `CLAUDE_MAX_EFFECTIVE_CONCURRENT`,
  `resolveFanoutEffectiveConcurrency`
- `packages/core/src/loop/gate-fanin.mjs`: `planDispatchRetry`, `backoffMaxConcurrent`
- `packages/core/src/loop/run-context.mjs`: `isClaudeHarness` (the existing harness-detection seam)
- `skills/docs/gate-review-sub-loop-contract.md`: `GATE-EXEC-DISPATCH-RETRY-BACKOFF`,
  effective-concurrency paragraph
- ADR 0056 (bounded-parallel gate dispatch) — amended by this record
- ADR 0048 (`gate:full` dispatches grouped; two-knob dispatch bounds) — `maxConcurrent` /
  `backoffMaxConcurrent` bounds this record clamps on top of, unchanged
