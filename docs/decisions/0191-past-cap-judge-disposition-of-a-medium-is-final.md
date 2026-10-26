# 0191. Past the cap the judge's disposition of a medium is final

## Status

Accepted — 2026-10-26 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462))

Amends [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) and [ADR 0189](./0189-draft-round-cap-counts-from-landing.md) for the `severity_disagreement` blocker only. All other decisions of ADR 0185 and ADR 0189 are unchanged. The records of ADR 0185 and ADR 0189 stay unedited.

## Context

On PR 2940, the `draft_gate` round 4 at `c6af3f2223d78dfc7a1d8d75b4b0777cc41f85ed` ended with a judge result of 0 act, 1 defer and 12 reject. The round composed `blocked` with 4 `round_cap_reached` blockers. All 4 blockers were mediums that the judge had closed with a stated reason. No fixer runs past the cap, so no action could clear them. Operator decision of 2026-10-26: past the cap, the judge's disposition of a medium is final.

## Decision

- Final medium. Past the cap, a medium that the judge disposes `reject` with a `judgeReason`, or `defer` with a `followUpIssueNumber` (an integer greater than 0), is final. It raises no blocker. The round composes clean when nothing else blocks.
- Verdict. The posted verdict lists each such medium with its disposition and reason.
- Still blocking. Every `high`, every finding with `failOpen: true` (set by the judge or a reviewer), a `defer` without a target issue, a `reject` without a reason and every `act` item still block. No fixer runs past the cap.
- Reuse. The rule uses the existing cap module and disposition fields. It adds no counter and no parser.

## Consequences

A past-cap round no longer blocks on a medium that the judge closed with a recorded reason or a follow-up issue. A high, a fail-open finding and an unreasoned disposition still stop the round. The judge carries the decision for a medium, and the posted verdict makes it visible.
