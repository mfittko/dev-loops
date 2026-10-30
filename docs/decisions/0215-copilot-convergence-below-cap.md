# 0215. A Copilot review with findings does not converge below the round cap

## Status

Accepted — 2026-10-30 ([issue 2445](https://github.com/mfittko/dev-loops/issues/2445), operator-approved).

Amends [ADR 0090](./0090-copilot-converged-once-default.md). Accepted records remain unchanged.

## Context

ADR 0090 treats a review with findings as converged once the threads it opened are resolved. The Copilot phase then ends after round 1 and the fix commit never receives a Copilot review, even when the effective round cap allows more rounds.

## Decision

In the default converged-once mode, a latest Copilot review with findings does not converge below the effective round cap while the Copilot gate has not passed. A review has findings when its body is body-only changes-recommended or unrecognized, or when it opened a thread of its own. The loop re-requests Copilot on the current head.

Below the cap, only two shapes converge: a review without findings, and a body-only review with no thread of its own that an `operator`-form disposition record names for the current head. A `fix`-form record does not converge below the cap. At the cap it keeps its role of clearing the prior-head body feedback for the round-cap fallback. An `operator` record does not converge a mixed review, that is a review with a thread of its own (mixed-review rule).

The Copilot gate has passed when a `pre_approval_gate` marker exists on the PR for any head. From then on, a later head never reopens a Copilot round and the ADR 0090 latest-review rule decides. At or above the cap the ADR 0090 carry applies unchanged.

The predicate `isBelowCopilotRoundCap` reuses the shared round-cap rule of [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md), the one the draft gate reads. The detector, the request tool, the handoff and merge pass the same inputs: the snapshot round count and the effective cap, composed for a light-dispatched PR. Strict mode and the operator withdrawal marker are unchanged.

## Consequences

Copilot reviews the fix commit while rounds remain. The zero-files review case and a same-head body edit are tracked separately. The rule is `COPILOT-STATE-CONVERGED-BELOW-CAP` in the Copilot loop state graph.
