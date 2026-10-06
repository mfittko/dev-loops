# 0120. A JSON statechart is the runtime policy source for conductor routing

## Status

Accepted — 2026-10-06 ([issue 2668](https://github.com/mfittko/dev-loops/issues/2668))

## Context

Amends [0004](./0004-conductor-ownership-and-routing-authority.md): `evaluateConductorRouting` stays the one routing authority and every orchestration surface still routes through it. Where the routing policy lives changes. Record 0004 stays unedited.

A spike expressed the routing policy as a JSON chart in the XState v5 key vocabulary and tested it differentially against the evaluator. Over 24,480 inputs the two agreed, and every chart arrow was reachable. The spike recommended keeping the chart as a test-only drift guard. That recommendation left the policy in two places: the evaluator's `if` ladder and the chart.

## Decision

- The chart at `packages/core/src/loop/conductor-routing-statechart.json` is the routing policy source. It ships in the `@dev-loops/core` package (`src/**/*.json` in `files`) and loads through a static JSON import attribute.
- `evaluateConductorRouting` keeps its name, input fields, return shape and reason texts. It normalizes the input, runs a first-match runner over the chart arrows with guard predicates defined in `conductor-routing.mjs`, and builds the envelope. The `if` ladder is deleted. Reason texts stay in JavaScript, keyed by arrow rule.
- A golden fixture generated from the pre-switch evaluator pins every result over the full input product. A freshness test fails when the hand-written contract priority table differs from the chart arrows.
- The decision reverses the spike's test-only recommendation: the chart is neither a shadow check nor a test-only guard.

Rejected: a test-only drift guard (two policy copies). Rejected: the `xstate` dependency (a new runtime dependency for first-match selection). Rejected: generating the evaluator or the contract table from the chart (a generator and a build step for one table).

## Consequences

A routing rule change edits the chart and its guard or reason, and the golden fixture shows exactly the changed rows. Callers see no change. The core package ships one more file type. The inner Copilot and reviewer tables stay in their current format.
