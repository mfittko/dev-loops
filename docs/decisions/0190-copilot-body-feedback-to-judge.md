# 0190. Copilot body feedback goes to the judge; the operator marker stays optional

## Status

Accepted — 2026-10-26 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937))

Amends [ADR 0090](./0090-copilot-converged-once-default.md) for gate coordination only: that record lets a trusted `copilot-body-disposition` record clear a 🟡 or unrecognized Copilot review body. Gate coordination no longer requires that record before `pre_approval_gate` runs. The merge path, `detect-copilot-loop-state.mjs` and `request-copilot-review.mjs` keep the 0090 rule until a later slice. The records that introduced 0090 stay unedited.

## Context

In the v1.0.8 drain, a Copilot body-only finding on PR 2932 blocked `run_pre_approval_gate` until an operator posted a marker. The operator then had to edit the marker, because it named a numeric review id and the resolver silently ignored it. The judge already disposes every cluster (ADR 0183).

## Decision

- The judge is the prime authority for a Copilot body-only finding at the current head or an earlier head. Gate coordination reports `copilotBodyConvergence` as ok, sets `copilotBodyJudgeFinding`, and does not block gate entry. Unresolved review threads still block.
- The detector writes the finding to a derived file and the judge emit pins it automatically (`--copilot-body-file` overrides). The judge work order carries the finding as a pinned `copilot-body-feedback` read and adjudicates it like an inline finding. The finding never blocks by itself.
- The operator marker stays optional and overrides. A trusted marker that clears the review leaves `copilotBodyJudgeFinding` null.
- The marker path applies one more rule: a trusted marker for the current head whose `review=` is a numeric id while the review id is a GraphQL node id (`PRR_...`) is refused with the typed reason `review_id_mismatch`, which names both ids. The emitted marker line carries the node id.
- The rule ID is `GATE-EXEC-COPILOT-BODY-TO-JUDGE` in `skills/docs/gate-review-sub-loop-contract.md`.

## Consequences

A PR with only Copilot body feedback reaches `pre_approval_gate` without an operator line. Merge still demands the marker or an equivalent disposition until the merge path moves to the judge.
