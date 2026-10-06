# 0121. The operator records a standing ADR tripwire waiver authorization for the v1.0.6 queue drain

## Status

Accepted — 2026-10-06 ([PR 2676](https://github.com/mfittko/dev-loops/pull/2676))

## Context

Amends [0119](./0119-standing-authorization-for-adr-tripwire-waivers.md): the mechanism stays as 0119 defines it. This record only grants the first authorization. Record 0119 stays unedited.

Record 0119 introduced standing authorizations for ADR tripwire waivers. This repo had none recorded. Every contract-doc tripwire during the v1.0.6 queue drain therefore needed a hand-pasted operator line.

## Decision

- The operator (mfittko) records `standingAuthorizations.adrTripwireWaiver` in `.devloops`: granted 2026-10-06, expiring 2027-01-03 (89 days, under the 90-day cap), reason "Queue drain; waive contract-doc tripwires that record no new decision".
- Waivers are written only by `dev-loops pr waive-adr-tripwire` under the conditions of 0119.
- Renewal or extension needs a new record.

## Consequences

A contract-doc-only tripwire that records no new decision stops needing a manual operator line, under the eligibility conditions of 0119. The exclusions of 0119 stay in force: the record never waives an `extension-defaults.yaml` trigger, a rule-modality reversal or removal, an unresolvable scan, a contract doc the issue's AC / DoD matrix does not name, or a change to the `standingAuthorizations` block. A `standingAuthorizations` change needs a decision record, and its ready flip also needs the repo owner's approval of the current head. Every non-contract trigger still needs a decision record or an operator-written waiver.
