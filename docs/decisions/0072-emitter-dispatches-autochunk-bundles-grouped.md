# 0072. Fan-out emitter dispatches auto-chunk bundles grouped, not per-angle

## Status

Accepted — 2026-09-16 (issue 2180)

Relates to ADR 0048 (amends its emitter guidance): 0048's grouped-dispatch-default and
two-knob dispatch bounds are unchanged; this record reconciles
`scripts/github/emit-fanout-dispatch.mjs` to that default, which it had not followed for
an auto-chunk leftover bundle.

## Context

ADR 0048 made grouped fan-out dispatch the default: `resolveFanoutGroups`
(`@dev-loops/core/config`) matches configured `gates.fanout.groups` first, then
auto-chunks the leftover ungrouped angles into dispatch units of at most
`maxAnglesPerGroup` (default 3) instead of one-singleton-per-angle, and the fan-out is
meant to spawn one reviewer per resolved unit — never per angle.

`scripts/github/emit-fanout-dispatch.mjs`'s `expandDispatchUnits` never implemented that
default for the auto-chunk leftover pool: it shared one reviewer only for a unit whose
name matched a CONFIGURED `gates.fanout.groups` entry, and split every other multi-angle
unit — including a `resolveFanoutGroups` auto-chunk bundle (`group:a+b+c`) — back into
one singleton reviewer per angle. On a repo with no `gates.fanout.groups` table
configured at all (the common case for a small-to-medium consumer repo), every resolved
angle became its own reviewer regardless of `maxAnglesPerGroup`, reproducing the
un-bounded one-reviewer-per-angle fan-out ADR 0048 exists to cap. A ~100-LOC change in a
consumer repo observed 25+ reviewers dispatched for a single gate round from this gap.
The reviewer-budget preflight (`reviewerBudgetPreflight`, which counts UNSPLIT
`resolveFanoutGroups` bundles) also diverged from the emitter's actual per-angle
dispatch count as a result, producing a required-vs-actual mismatch at the preflight
boundary.

The singleton-split was deliberate when it was written, guarding against a
`requireFanoutProvenance` breach seen on two prior PRs: a coordinator seeding a shared
reviewer for an ad-hoc group the configured table never named, with no independent
cross-check to catch it. That gap has since closed. The merge-time guard
(`fanoutReviewerPairingError`, `@dev-loops/core/loop/gate-fanin`) now accepts a shared
reviewer identity only when an optional `resolvedGroups` argument places every angle the
identity covers in the SAME resolved unit, and its caller
(`detect-checkpoint-evidence.mjs`) always re-derives that argument by calling
`resolveFanoutGroups` itself — independently of whatever the ledger's own provenance
claims — at both of its ledger-selection sites. `resolveFanoutGroups`'s output already
includes an auto-chunk bundle on equal footing with a configured group, so the guard
already honors a shared identity within an auto-chunk bundle exactly as it does within a
configured group. The emitter's singleton-split was therefore stricter than the
authority that actually enforces the invariant, and that extra strictness is what
caused the over-dispatch.

## Decision

`expandDispatchUnits` dispatches EVERY multi-angle `resolveFanoutGroups` unit — a
configured `gates.fanout.groups` group or an auto-chunked leftover bundle — as one
shared reviewer, capped at `REVIEWER_UNIT_MAX_ANGLES` via the same ordered cap-split an
over-cap configured group already used (`<name>-part1`, `<name>-part2`, ...; each
sub-unit still records the whole unit's own name as its provenance `group`). Only a
genuinely single-angle unit dispatches as a singleton (no shared group).
`configuredGroupNames` is retained on the function signature solely to disambiguate a
generated split sub-unit's name against a configured group's name (and, now, against
every other unit resolved this round) — it is no longer used to classify a unit as
shared vs. singleton.

The merge guard (`fanoutReviewerPairingError`, re-deriving via `resolveFanoutGroups` at
both `detect-checkpoint-evidence.mjs` re-derivation sites) remains the fail-closed
authority for the one-scoped-reviewer-per-angle contract: a shared identity is honored
only when the guard's OWN re-derivation places every angle it covers in the same
resolved unit, so a claimed group spanning angles the re-derivation splits apart (or an
angle it never resolves at all) still fails closed regardless of what the emitter did.
Because the guard already enforces this independently, the emitter no longer needs to
be more conservative than the guard by splitting a sanctioned auto-chunk bundle to
singletons.

Rejected: primer-owned plan grouping, a new plan `dispatchGroups` dimension,
provenance-authority reload from a persisted plan, fingerprint re-verify, or
delta-stability changes — all deferred to the issue's re-scoped quality slice; this
record covers only the count-side reconciliation (dispatch shape) and the contract text
describing it.

## Consequences

- A no-config-table repo's gate round now dispatches at most `ceil(freshAngles /
  maxAnglesPerGroup)` reviewers instead of one per angle, matching the reviewer-budget
  preflight's own unsplit-bundle count (`reviewerBudgetPreflight`) except when
  `maxAnglesPerGroup` is configured above `REVIEWER_UNIT_MAX_ANGLES` (an operator
  misconfiguration), in which case an over-cap auto-chunk bundle still cap-splits into
  more emitted units than preflight-counted bundles — the same residual divergence an
  over-cap CONFIGURED group already produced before this change, unaffected by it.
- `emitted.maxConcurrent` continues to count EMITTED (post-split) dispatch units, so the
  wave-plan / concurrency accounting is unchanged by this record; a coordinator still
  MUST wave by the emitter's `maxConcurrent`, never the artifact's unsplit
  `fanout.wavePlan` (unchanged `GATE-EXEC-FANOUT-DISPATCH-EMIT` invariant).
- The `requireFanoutProvenance` fail-closed guard is unchanged in code; this record
  simply removes a redundant, over-conservative restriction the emitter applied on top
  of it. Issue 2180's adversarial test coverage
  (`packages/core/test/gate-fanin.test.mjs`) re-proves the guard still refuses an
  ad-hoc group `resolveFanoutGroups` never produced, so the emitter change does not
  reopen the fail-open the singleton-split was originally written to guard against.

## References

- `scripts/github/emit-fanout-dispatch.mjs`: `expandDispatchUnits`, `splitSubUnitName`
- `packages/core/src/config/config.mjs`: `resolveFanoutGroups`, `stableAutoChunkUnitName`
- `packages/core/src/loop/gate-fanin.mjs`: `fanoutReviewerPairingError`,
  `reviewerBudgetPreflight`
- `scripts/github/detect-checkpoint-evidence.mjs`: `readLedgerProvenanceInAny`,
  `buildFanoutEnforcement`'s `resolvedGroups` derivation
- `docs/decisions/` ADR 0048 (grouped-dispatch-default this record reconciles the emitter to)
- `skills/docs/gate-review-sub-loop-contract.md`: `GATE-EXEC-FANOUT-DISPATCH-EMIT`,
  "Grouped dispatch (default)"
