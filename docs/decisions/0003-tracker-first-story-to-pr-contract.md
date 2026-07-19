# 0003. Make the tracker issue the source of truth and the PR its deterministic projection

## Status

Superseded by [0018](0018-local-first-default-pr-body-spec.md) — 2026-05-15 ([PR 23](https://github.com/mfittko/dev-loops/pull/23))

## Context

The early harness needed a deterministic answer to where authoritative work state lives when agents, Copilot, and humans mutate GitHub concurrently ([issue 21](https://github.com/mfittko/dev-loops/issues/21)). The contract and its state interpreter landed via [PR 23](https://github.com/mfittko/dev-loops/pull/23) and the MVP state machine and artifact graph via [PR 25](https://github.com/mfittko/dev-loops/pull/25); the companion proposal-first safety contract landed via [PR 22](https://github.com/mfittko/dev-loops/pull/22). The issue explicitly froze this contract first to prevent drift into adapter-first work, generic workflow-engine design, or a broader artifact-model redesign. The contract text lives at `skills/docs/tracker-first-loop-state.md` (with `docs/tracker-story-pr-contract.md` kept as a pointer), the interpreter at `packages/core/src/loop/tracker-pr-state.mjs`, and its CLI at `scripts/loop/detect-tracker-pr-state.mjs`. The later reversal to a local-first default was closed out via [PR 1403](https://github.com/mfittko/dev-loops/pull/1403).

## Decision

We adopt a tracker-first contract: the tracker issue owns intent and planning state, and the PR is a deterministic, idempotent projection of tracker state under the MVP invariant of one tracker work item to one GitHub PR. A single state machine over issue-plus-PR snapshots interprets the whole story-to-PR lifecycle: it maps every snapshot to exactly one current state, its allowed transitions, and a canonical reverse-sync action, and it fails closed into a blocked-needs-user-decision state on contradictory or partial input. Source-of-truth ownership is explicit — the tracker owns work-item identity and planning state, GitHub owns PR lifecycle and merge facts, and the harness owns projection and sync logic only, never business fields. The companion proposal-first safety contract gates external mutation behind explicit, coordinator-approved intake. We reject ad-hoc local branches with heuristic PR mapping, and we equally reject widening into adapter-first abstractions or a generic workflow engine before the MVP path is proven.

## Consequences

As the founding modality, this made every change pay issue ceremony — grill, tracker projection, reverse sync — which proved heavyweight for small work and was later reversed by the local-first default recorded in the superseding record. Tracker-backed work survives only as an input source to the local implementation strategy, and the once-planned tracker-first routed strategy was closed as won't-do rather than built as a peer routing family. What persists everywhere is the idiom this decision introduced: normalize a raw snapshot, interpret it through an exhaustive deterministic state machine, and fail closed on ambiguity instead of guessing. That idiom now underpins the loop's other lifecycle detectors and keeps concurrent mutation from ever being resolved by heuristics.
