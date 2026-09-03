# 0056. Bounded-parallel gate dispatch, and the pinned dispatch discipline

## Status

Accepted — 2026-09-03 ([issue 1907](https://github.com/mfittko/dev-loops/issues/1907))

Amends the concurrency posture ADR 0049 introduced: `gates.fanout.sequential` stays a first-class
knob, but this repo no longer sets it. `gates.fanout.maxConcurrent` (#1601, ADR 0048) is unchanged
— no new mechanism or knob ships.

## Context

A 2026-08-31 session burned 8+ dispatch trees across 3 model tiers and surfaced four recoverable
failure classes: an async parent that ends its turn after dispatching a nested child is never
woken by the child's completion; a provider 429/402 killed a tree outright with no retry or
backoff; one transient 429 pinned reviewers to a fallback provider for the rest of the session;
and a post-merge run re-entered consolidation machinery whose artifacts already existed, aided by
a `2>/dev/null`-swallowed path-probe error. Separately, PR #1908 (2026-09-01) measured that this
repo's `gates.fanout.sequential: true` — a deliberate ADR 0049 workaround for a child-safe
environment SIGTERMing heavy reviewers under parallel overload — starves wall-clock (one reviewer
at a time, ~5-7 min each, blowing the 30-min parent default budget) and invites sleep-poll
improvisation while the parent waits (`ANTIPATTERN-FANIN-WAIT`). The fix for the wall-clock
problem is bounded concurrency plus retry-on-transient, not permanent serialization; the recovery
knowledge for the other four failure classes lived only in operator steering messages, exactly
where durable rules must not live.

## Decision

Flip this repo's `.devloops` from the sequential fan-out workaround to bounded-parallel dispatch,
and pin the validated dispatch discipline as contract prose so it survives session loss:

- **Bounded-parallel default.** `gates.fanout.maxConcurrent: 3` (aligned with `queue.maxParallel`)
  replaces `gates.fanout.sequential: true`; dispatch units run up to 3 concurrent per wave via
  blocking joins. `sequential: true` remains the documented LOAD FALLBACK for an environment that
  still SIGTERMs heavy reviewers under parallel overload — never the default posture
  (`GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`).
- **No mid-chain turn-ending.** The conductor never ends its turn to await a nested child it just
  dispatched; the sanctioned alternatives are a blocking join or `contact_supervisor` before
  ending a turn (`END-TURN-AND-AWAIT-WAKE`).
- **Blocking join for a nested single-child step.** Awaiting a judge, fixer, or single reviewer
  this run dispatched uses a blocking dispatch (`async: false`) or one `bg_wait` nonBlocking
  subscription — never sleep-poll (`agents/dev-loop.agent.md`, dev-loop SKILL guard rules).
- **Retry-on-transient, escalate-on-hard-4xx.** A 429/5xx retries the SAME dispatch unit with
  exponential backoff (30s/60s/120s) — safe because reviewer findings artifacts are idempotent
  single-writes at deterministic paths — and only reduces concurrency after ~3 failed attempts; a
  hard 4xx (e.g. `402 Insufficient Balance`) escalates to the supervisor/operator immediately
  (`GATE-EXEC-DISPATCH-RETRY-BACKOFF`).
- **Per-dispatch provider choice.** A transient failure never pins later dispatches to a fallback
  provider once the cap window passes (`STICKY-PROVIDER-PIN`).
- **Probe hygiene.** An error-swallowed path probe (`2>/dev/null`) is forbidden; every cited path
  must be verified to exist (`SILENT-STDERR-PROBE`).
- **End-of-run contract.** Post-merge, the only remaining steps are the main-green check, one
  board-move attempt, and the final report — never re-running consolidation machinery whose
  artifacts already exist (`GATE-EXEC-END-OF-RUN-CONTRACT`).

## Consequences

- This repo's gate rounds dispatch up to 3 reviewer units concurrently instead of one at a time,
  reducing round-1 fan-out wall-clock while keeping genuine distinct-reviewer fan-in, ledger, and
  provenance unchanged (`requireFanoutEvidence` / `requireFanoutProvenance` still enforced).
- The dispatch-discipline pins are now contract prose in the shared surfaces (anti-patterns, gate
  contract, dev-loop SKILL, dev-loop agent) rather than folklore recoverable only from operator
  steering messages.
- Cross-harness default is unchanged: `gates.fanout.maxConcurrent` (default 4) and
  `gates.fanout.sequential` (default false) are unaffected for other repos/harnesses (#1086).
- Engine-level wake-on-child-completion for an ended async parent, and fan-in/consolidation/
  carry-forward mechanics, are explicitly out of scope — this decision pins dispatch shape and
  error posture only.

## References

- `skills/docs/anti-patterns.md`: `END-TURN-AND-AWAIT-WAKE`, `SILENT-STDERR-PROBE`,
  `STICKY-PROVIDER-PIN`
- `skills/docs/gate-review-sub-loop-contract.md`: `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK`,
  `GATE-EXEC-DISPATCH-RETRY-BACKOFF`, `GATE-EXEC-END-OF-RUN-CONTRACT`
- `skills/dev-loop/SKILL.md` guard rules; `agents/dev-loop.agent.md` Subagent delegation
- ADR 0048 (`gate:full` dispatches grouped; two-knob dispatch bounds) — the `maxConcurrent` / `backoffMaxConcurrent` bounds this record's flip relies on.
- ADR 0049 (serial one-at-a-time heavy-reviewer fan-out dispatch bound) — amended by this record; `sequential: true` is demoted from this repo's default to a documented load fallback.
