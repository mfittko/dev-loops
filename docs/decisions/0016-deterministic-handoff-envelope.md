# 0016. Make a deterministic handoff envelope the delegation contract between agents

## Status

Accepted

## Context

Agent-to-subagent handoffs were hand-composed prose: every dispatch re-derived scope, stop rules, acceptance criteria, `cwd`, and required reads from state the resolver and settings had already computed, so task text drifted from actual state and delegated runs started inconsistently ([issue 536](https://github.com/mfittko/dev-loops/issues/536)). The prior `workflow-handoff-template.md` was still prose consumed by agents, not a machine-populated contract. The envelope function shipped in [PR 537](https://github.com/mfittko/dev-loops/pull/537); building it became the agent's mandatory first action before any delegation in [issue 615](https://github.com/mfittko/dev-loops/issues/615) ([PR 636](https://github.com/mfittko/dev-loops/pull/636)); consumer-side validation on receipt followed via [issue 621](https://github.com/mfittko/dev-loops/issues/621) ([PR 637](https://github.com/mfittko/dev-loops/pull/637)). The derivation contract lives in `skills/docs/workflow-handoff-contract.md`, the implementation in `packages/core` (`handoff-envelope.mjs`).

## Decision

Every delegation derives its envelope through `buildDevLoopHandoffEnvelope()` — a pure function over resolver output, settings, and gate state that returns a deep-frozen envelope, with acceptance criteria, evidence requirements, and control timeouts looked up from a static per-strategy-and-gate template table that throws on unknown combinations. The dispatching agent builds the envelope as its mandatory first action before delegating, and the receiving consumer validates the envelope's schema on receipt, rejecting malformed handoffs. Every field is derived from an authoritative source (resolver bundle, settings, gate detectors, the sanctioned-command map); no field is a hard-coded magic string or prose template. We rejected continuing with prose handoff templates: they had already proven to drift and forced two redundant resolution passes, with the parent resolving state into prose that the child re-resolved.

## Consequences

The envelope is the inter-agent interface of the system: later features — `specSource` for PR-body-as-spec runs, `retrospectiveFindings`, the mandatory `sanctionedCommands` operation-to-wrapper map — shipped by adding envelope fields rather than new prose, and spawned subagents receive them by default without the briefer composing anything. Unknown strategy-plus-gate combinations fail loudly at build time instead of producing improvised handoffs, so adding a strategy forces an explicit acceptance template. The cost is that new delegation shapes require touching the template table and contract doc before they can run at all.
