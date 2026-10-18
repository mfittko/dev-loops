# 0154. `pr create` refuses an oversize branch before creation

## Status

Accepted — 2026-10-18 ([PR 2813](https://github.com/mfittko/dev-loops/pull/2813))

## Context

Amends [0123](./0123-adr-tripwire-early-surface.md) and [0084](./0084-grill-clean-requires-recorded-provenance.md). 0123 decides that a block never refuses PR creation and lists refusing creation as a rejected alternative. This record reverses that for the size check only. Record 0084 decides that the zero-iteration `grill_clean` exit requires a shape-clean artifact and recorded provenance. This record adds a third condition: no `size_forecast_*` spec-lint finding. Records 0123 and 0084 stay unedited.

A branch far above the size budget was created as a PR and then needed a split after review rounds were spent. The size is known locally before the PR exists ([issue 2756](https://github.com/mfittko/dev-loops/issues/2756)).

## Decision

`pr create` refuses with `size_split_required_before_pr` when the local `origin/<base>...<head>` whole-PR logic LOC is at or above the resolved default-tier `waiverLoc` (`PRE-PR-SIZE-CHECK`). An `unknown` size does not refuse. No override flag exists. The ADR tripwire block still never refuses creation. The `ADR-TRIPWIRE-EARLY-SURFACE` row in `skills/docs/decision-record-contract.md` states this exception and cites this record.

## Consequences

An oversize branch must be split before a PR exists. Draft creation for legitimate large work needs a split first. The 0123 behavior stays unchanged for the tripwire and for every size outcome below `waiverLoc`.

The forecast matcher in `scripts/loop/spec-lint.mjs` is fail-closed by design. It claims any list item under `## Size forecast` whose first token is `forecast` or that contains `wloc=`, and a claimed line that does not parse reports `size_forecast_malformed`. An unrelated list item under that section therefore blocks `grill_clean`. This cost is accepted. The remedy is to move the item out of the section or fix its form.
