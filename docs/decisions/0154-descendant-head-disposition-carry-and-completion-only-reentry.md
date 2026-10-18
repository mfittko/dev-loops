# 0154. Carry a verified fixer disposition to a descendant head and re-enter completion-only

## Status

Accepted — 2026-10-18 ([issue 2787](https://github.com/mfittko/dev-loops/issues/2787))

## Context

Amends [0068](./0068-fixer-disposition-fail-closed-boundary.md): it fails the loop closed unless the fixer disposition was verified at the live PR head (`GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`). It also governs the fixer work order that produces that disposition. Two situations then stall a PR with no safe route forward. A head X is verified, then the PR head moves to a descendant H before the loop advances. A fixer handoff is missing or stale (`result_predates_pull`) after the fixer pushed its work. Record 0068 stays unedited. <!-- secret-scan:allow rule and function identifiers, not credentials -->

## Decision

Descendant-head carry. A fixer disposition verified at head X counts at a live head H when H contains X (`isCommitContainedByHead`, ahead only). The carry binds to the active plan's own after-pull handoff and to its checkpoint `fixer-disposition-<X>.json`. The checkpoint must record every thread the handoff tackled as tackled. The commits it tackled must be contained in H. Each tackled thread must be resolved live. This relaxes `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` from "verified at H" to "verified at X, carried to H". H is still re-reviewed in full. The carry never satisfies a gate verdict.

Completion-only re-entry. `emit-fixer-work-order.mjs --completion-only` re-enters the canonical active full plan whose handoff is missing or stale as an `operation: complete` order with delivery-only authority (no allowed paths). It refuses unless the plan authenticates, the PR head and branch match, the source and required reads are unchanged, the plan's source round is not retired, and the detector binds an active or stale fixer to that plan. The old plan is archived and the stale handoff stays in place.

## Consequences

A PR whose head moved after verification advances without a new fixer round. A stuck handoff recovers without source edits. Neither path grants a gate verdict or widens mutation authority beyond delivery.
