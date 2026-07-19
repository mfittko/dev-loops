# 0002. Control every loop with deterministic, fail-closed state machines over authoritative GitHub state

## Status

Accepted — 2026-05-13 ([PR 6](https://github.com/mfittko/dev-loops/pull/6))

## Context

Early agent loops drifted: agents inferred their loop position from transcript memory and ad-hoc `gh` reads, producing non-reproducible routing, duplicate PRs, and phantom progress. The first correction landed 2026-05-13 as a deterministic Copilot-loop state machine with read-only current-state detection ([PR 6](https://github.com/mfittko/dev-loops/pull/6)), immediately mirrored on the reviewer side ([PR 8](https://github.com/mfittko/dev-loops/pull/8)). Status reporting had the same disease — local checkpoints diverged from real GitHub state — and was forced onto authoritative-state-first, fail-closed reconciliation ([PR 94](https://github.com/mfittko/dev-loops/pull/94)); async startup likewise learned to fail closed when no inspectable Pi-managed run was visible ([PR 196](https://github.com/mfittko/dev-loops/pull/196), [PR 207](https://github.com/mfittko/dev-loops/pull/207)). The pattern later hardened into an exported contract when the 13-state PR lifecycle table was promoted into core as the single source for the docs atlas and the conformance harness ([PR 1216](https://github.com/mfittko/dev-loops/pull/1216)); see `scripts/loop/detect-copilot-loop-state.mjs`, `packages/core/src/loop/pr-lifecycle.mjs`, and `scripts/pages/build-state-atlas.mjs`.

## Decision

We model every loop — the Copilot dev loop, the reviewer loop, the PR lifecycle — as an explicit deterministic state machine: a frozen state vocabulary plus a transition table, with current state detected read-only from canonical live GitHub facts and local artifacts serving only as supplements. Detection follows a snapshot-normalize-interpret pipeline (`buildSnapshotFromPrFacts` → `normalizeSnapshot` → `interpretLoopState`), so the same snapshot always yields the same state, allowed transitions, and next action. Ambiguous, contradictory, or partial snapshots fail closed into `blocked_needs_user_decision` or a stop instead of guessing, and agent memory is never the routing authority. We rejected freeform LLM interpretation of raw reads as the router: it is exactly the non-reproducible inference the machines exist to replace. We also export the lifecycle as a frozen single-source table in core so the docs atlas and the conformance harness consume the same data the runtime does, rather than prose that can drift.

## Consequences

Nearly everything in the repo is now a detector plus a transition table, and "error out" beats "best guess" system-wide: a loop that cannot prove its state stops and reports rather than fabricating progress. Adding or changing a state means editing the exported table, which automatically propagates to the rendered state atlas and is checked by the conformance harness, so documentation cannot silently diverge from behavior. Routing decisions are reproducible and debuggable from a captured snapshot alone, without replaying a transcript. The cost is machinery: every new loop family must ship its own snapshot-normalize-interpret pipeline before it can participate, and legitimate-but-unmodeled situations surface as blocked states requiring a human decision.
