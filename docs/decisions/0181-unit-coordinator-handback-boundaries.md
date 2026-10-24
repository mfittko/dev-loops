# 0181. Derive the unit hand-back boundary from the route, not from the brief

## Status

Accepted — 2026-10-24 ([issue 2532](https://github.com/mfittko/dev-loops/issues/2532), [efficiency epic 2268](https://github.com/mfittko/dev-loops/issues/2268)).

## Context

One coordinator ran a whole dev-loop cycle and its context snowballed: the real-run
audit on PR 2923 measured peaks of 176K and 169K prompt tokens against the existing
150K cap. Splitting the cycle into one fresh unit coordinator per phase only lowers
peak context if every coordinator knows where its own unit ends without having to
carry the previous unit's conversation. A boundary restated in each orchestrator
brief is the context the split exists to remove, and a boundary derived from a
predecessor's prose is the same failure with extra steps.

Three questions had no recorded answer, and each one changes observable behavior:

- Does every route own a phase to hand back from? A route that produces no lifecycle
  gate evidence has no verdict to hand back after, and asserting one contradicts the
  route's own stop rules.
- What identifies a unit that carries no issue, PR or branch? A plan-file, spike or
  lightweight phase has only its phase label.
- What does a unit with more than one applicable boundary stop at, and in what order?

## Decision

Derive a `unitBoundaries` field on the handoff envelope from the envelope's own target
and route, and record three rules.

**Ownership is a property of the route.** Boundaries are emitted only for routes that
own a phase. The public contract already classes `review`, `ui_review` and `wait_watch`
as pure read/observe, so they emit none: a read-only round runs one round and posts no
lifecycle gate evidence, a UI review observes, and a wait routes no unit at all. A
terminal reconciliation envelope emits none either, because its stop rules are already
terminal. Suppression is an explicit, named set: `STATELESS_UNIT_STRATEGIES` in
`packages/core/src/loop/handoff-envelope.mjs` lists those three strategy names, mirroring
the routing contract's ownership exemption (`STRATEGY_OWNERSHIP_GATE` in
`scripts/loop/resolve-dev-loop-startup.mjs`). The two must stay in step by hand, so
classifying a new read-only route means adding it to that list — the field is not derived
from the classification map.

**A resume identity may be a phase.** A target that carries no issue, PR or branch
re-resolves by its phase label. The label is authoritative because it is what the
resolver emitted; it is not a fallback for a missing number. A resume names one identity,
and the phase labels an artifact rather than a startup mode: which mode re-resolves it
(`--plan-file`, `--spike`, the lightweight path) is the successor's own route input, since
the startup CLI has no `--phase` selector and a plan-file and a spike path are
indistinguishable from the label alone.

**`handBackAfter` is an ordered, first-match list.** A unit that owns no PR yet stops
at the draft PR it opens; the verdict boundary then belongs to its successor, which
resumes already owning that PR. A unit that already owns a PR has only the verdict
boundary. PR ownership is read from a bound or linked PR for every target kind, not
only for issue targets, so no route is told to open a draft it already has. The validator
enforces the canonical order, so a reversed list is refused rather than silently
inverting which boundary comes first. A route whose unit runs a gate round but posts no
verdict of its own carries `gate_verdict_posted` as a recorded naming approximation,
never as a boundary it can reach.

The field derives only from the route and target, so it sits inside the byte-stable
envelope prefix and a fresh successor cache-reads it instead of re-billing it. No
successor field derives from a predecessor's conversation, and the predecessor never
writes or summarizes the next brief.

## Consequences

The boundary set is closed. Adding a boundary, or a route that owns one, is a contract
change to the envelope schema, the validator, both harness mirrors and this record —
not an additive field. `final_approval` runs a gate round but posts no verdict of its
own, and an `issue_intake` unit stops at the draft PR it opens, so both currently carry
the verdict boundary as a recorded naming approximation stated in the contract's
`handBackAfter` bullet and in the coordinator's own hand-back rule; giving them a
truthful boundary means extending the closed set, which this decision deliberately
leaves open as follow-up rather than settling by widening it here.

Suppression is maintained by hand against the read/observe classification, not derived
from it: a route newly classed as read-only loses its hand-back boundary only when it is
added to `STATELESS_UNIT_STRATEGIES`, and the two lists drifting apart is the defect this
record now states plainly instead of denying. That is intended: the two lists are the
decision, and the boundary follows them.

The field adds no authority. It names when a coordinator stops; it does not grant
GitHub writes, merge, tagging or publishing, and it does not replace human approval.
Peak-context compliance remains measured on real runs, and a missing native
measurement is reported as unavailable rather than zero.
