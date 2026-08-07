# 0047. Grouped fan-out dispatch is the default; one-reviewer-per-angle is opt-in

## Status

Accepted — 2026-08-04 ([issue 1572](https://github.com/mfittko/dev-loops/issues/1572))
Partially amended by [0048](./0048-gate-full-dispatches-grouped-two-knob-dispatch-bounds.md) — the `gate:full` per-angle restoration clause is superseded; `gate:full` now dispatches grouped. The grouped default, static grouping table, and `mode: per-angle` opt-in are unchanged.

## Context

This partially amends [0021](./0021-gate-fanout-build-once-seed-many.md), which rejected
grouped review as "unprovable and biased" and forked one reviewer per resolved angle
unconditionally — that dispatch-cardinality clause is superseded below; 0021's build-once
bundle, invariant-prefix, and fail-closed hash-comparison decisions are untouched.

[0039](./0039-one-gate-reviewer-per-fresh-angle.md) fixed a self-approval gap by requiring
one independent reviewer per fresh angle, unconditionally, at both write and read time. It
closed the gap it targeted, but its no-grouping stance also means every angle pays the full
briefing cost regardless of how much its signal overlaps a sibling angle's. [PR 1571](https://github.com/mfittko/dev-loops/pull/1571)
measured the resulting cost directly: 27 reviewer dispatches across three fan-outs for one
PR (~3.5M subagent tokens), and in draft round 2, six of the ten dispatched reviewers
independently reported the same must-fix. Each reviewer pays the same fixed briefing cost
(the byte-identical prefix plus its angle prompt), so per-angle dispatch multiplies that
fixed cost for angles whose reading surface — and therefore whose findings — heavily
overlap. The operator (mfittko) ordered grouped dispatch in scope for [issue 1572](https://github.com/mfittko/dev-loops/issues/1572)
and, on reviewing the PR 1571 evidence, amended the decision: grouped dispatch becomes the
DEFAULT, with full one-reviewer-per-angle available as an explicit opt-in.

## Decision

`gates.fanout.mode` defaults to `grouped`: a static, config-declared table
(`gates.fanout.groups`, e.g. doc-surface angles together, process-read angles together,
bug-hunting angles kept least grouped) maps each round's resolved angles onto reviewer
groups via `resolveFanoutGroups` (`@dev-loops/core/config`) — never dynamic packing, so the
grouping is auditable and reviewable as config, not inferred at dispatch time. In grouped
mode the conductor spawns ONE scoped reviewer per group, briefed with every angle in that
group (each angle's own prompt, all after the shared byte-identical prefix), and that
reviewer still writes ONE findings artifact PER ANGLE at the existing per-angle paths — fan-in,
the disposition ledger, coverage checks, and the head-stamp guard are all unchanged, because
none of them observe how many reviewer processes produced the artifacts they read. The
provenance write-time floor from 0039 (`fanoutReviewerPairingError`: no two fresh angles may
share a reviewer identity) is narrowed, not removed: fresh angles sharing one reviewer
identity are valid exactly when every entry sharing that identity declares the SAME `group`
name AND (when the caller supplies the round's resolved dispatch groups — both write and
read call sites do, each threading a `fullLabel`/`--full-label` signal into `resolveFanoutGroups`
so a gate:full round resolves the same per-angle singletons on both sides) every one of those
angles is a member of that SAME configured dispatch unit, so a collision across DIFFERENT declared groups, an undeclared group, or a fabricated
group label the config never actually groups those angles into still fails closed exactly as
0039 requires. The `requireFanoutProvenance` `distinctReviewers` floor (`FANOUT_PROVENANCE_MIN_REVIEWERS`
scaled up) also had to move from counting fresh ANGLES to counting fresh DISPATCH UNITS
(`countFreshDispatchUnits`: one unit per declared group, one per ungrouped angle) — the
floor is the other half of 0039's guarantee, and left angle-scaled it would reject every
honest grouped round (M reviewers for N grouped angles, M < N) that the pairing exception
above is designed to accept. `gate:full` (label or `gates.fanout.mode: per-angle`) keeps
0039's original one-reviewer-per-angle behavior verbatim — a group of one per angle — so a
reviewer who wants the un-grouped signal, or a PR the operator wants maximally scrutinized,
opts back in without a config edit beyond the label. Rejected: dynamic/heuristic grouping
(defeats the auditability a static table gives a reviewer of the contract); removing the
pairing floor instead of narrowing it (reopens the exact self-approval gap 0039 closed, just
inside a bigger group); keeping one-reviewer-per-angle as the default and grouping as the
opt-in (the PR 1571 evidence shows the common case is the redundant one, so defaulting to the
expensive path optimizes for the exception).

## Consequences

A typical fan-out now costs one reviewer per declared group instead of one per angle, cutting
the redundant-signal tax PR 1571 measured while leaving every downstream artifact, ledger, and
enforcement check untouched — they were already angle-keyed, not reviewer-keyed. A grouped
reviewer's briefing is larger (it carries every angle in its group), so the token savings come
from fewer fixed-prefix payments, not from any one reviewer reading less. The `gate:full`
label remains the sanctioned full-scrutiny escalation, now serving double duty: it forces the
untriered angle set (pre-existing) AND ungroups every angle back to 0039's original shape.
Groups are static config, so a reviewer who wants to change how angles are batched edits
`gates.fanout.groups`, not a heuristic; a misconfigured or unbalanced group is a config-review
concern, not a runtime one.
