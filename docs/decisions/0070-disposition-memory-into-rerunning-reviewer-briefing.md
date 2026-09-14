# 0070. Carry prior-round dispositions into a re-running reviewer's briefing

## Status

Accepted — 2026-09-14 (https://github.com/mfittko/dev-loops/pull/2183)

## Context

A head-bump re-gate re-runs every angle that is not carried forward, and each
re-running reviewer starts from a fresh briefing with no memory of what the
previous round already judged. On a narrow bump, this repeatedly wastes a
review cycle re-litigating findings the judge already resolved — most
visibly, a reviewer re-raising an already-rejected finding at a shifted
severity to get around the prior disposition. This is the cost problem
tracked in issue [#2175](https://github.com/mfittko/dev-loops/issues/2175),
and disposition memory is its AC3 lever: carry the previous round's settled
findings into the next round's reviewer context so a reviewer can recognize
already-settled ground instead of re-raising it.

The mechanism lands in PR [#2183](https://github.com/mfittko/dev-loops/pull/2183),
which adds a decision-shaped paragraph to
`skills/docs/gate-review-sub-loop-contract.md`, triggering the ADR tripwire
([ADR-0052](./0052-adr-tripwire-fail-closed.md)); this record satisfies it.

## Decision

Add a `--prev-head <A>` seam to `write-gate-context.mjs` (mirroring
`resolve-angle-carry-forward.mjs`'s own `--prev-head` vocabulary) that reads
head A's durable findings-log and seeds prior dispositions into the rendered
volatile tail as a bounded "Prior-round dispositions (do not re-raise a
rejected finding at a shifted severity)" block, one entry per carried
finding (fingerprint, angle, severity, summary, `judgeRationale`), capped
deterministically at a fixed max-entry count with per-field truncation and a
terse overflow line so a large or corrupted prior log cannot make a reviewer
prompt unboundedly large. Only a `clean`/`findings_present` prior verdict is
eligible to seed a hint — any other/missing verdict is treated the same as an
absent prior log. Four choices shape the mechanism:

1. **Only `reject`/`defer` seeded; `act` excluded.** An `act` disposition is
   still-open, live-findings territory — surfacing it as "prior" would
   confuse it with what the round still needs to fix. Only findings the
   judge already settled (rejected outright, or deferred to a follow-up) are
   memory candidates.
2. **Fail-open, not fail-closed.** An absent (first round), unreadable, or
   malformed prior log renders a byte-identical volatile tail to omitting
   `--prev-head` entirely. The seam is purely additive: it never blocks the
   write, never suppresses a finding, and never converts a `reject` into an
   approval. It only hints a reviewer away from re-litigating settled
   ground. Rejected alternative: fail closed on a bad prior log — this would
   let a memory-plumbing defect block gate writes for an orthogonal reason,
   which is disproportionate for an advisory hint.
3. **Attribution scoped to angles that actually re-run this round.** A
   finding is only seeded for an angle present in `--angles` and absent from
   `--carried-angles`; a carried angle's reviewer never re-runs, so it gets
   no hint (it has no fresh briefing to receive one). The implementation
   reuses the existing `fingerprintFinding`, `baseAngleName`, and
   `buildLogPath` helpers rather than introducing a parallel identity or
   path-resolution scheme.
4. **Fail-closed same-head/eligibility guards, fail-open only past them.**
   `--prev-head` is rejected outright when it names the SAME head as
   `--head-sha` (checked in both prefix directions, so a full 64-char head and
   its 40-char prefix are also caught as same-head), and a prior log whose
   `verdict` is not `clean`/`findings_present` (e.g. `blocked`, or missing) is
   treated as ineligible — same as an absent prior log. These two guards are
   the fail-closed boundary; every failure past that boundary (unreadable,
   malformed, identity-mismatched) is fail-open, per (2) above.

## Consequences

- A re-running reviewer on a narrow head-bump sees what the previous round
  already rejected or deferred and is less likely to re-raise it at a
  shifted severity, cutting a category of wasted re-review cycles.
- The hint is advisory only: it never weakens review, never suppresses a
  live finding, and never overrides a reviewer's independent judgment — a
  reviewer can still re-raise a prior finding if new evidence warrants it.
- The mechanism depends on the conductor actually threading `--prev-head`
  into `write-gate-context.mjs` on a head-bump rebuild. This same PR wires
  that call site: the head-bump re-gate procedure step that already
  instructs the conductor to pass `--carried-angles` to that same rebuild
  now also instructs it to pass `--prev-head <A>`, so AC3's disposition
  memory is live via the documented conductor step, at parity with
  `--carried-angles`, rather than sitting dormant.
