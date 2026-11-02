# 0237. A Copilot review of zero files is not a clean review

## Status

Accepted — 2026-11-02 ([issue 2437](https://github.com/mfittko/dev-loops/issues/2437), operator-approved).

Amends [ADR 0090](./0090-copilot-converged-once-default.md) and [ADR 0215](./0215-copilot-convergence-below-cap.md). Accepted records remain unchanged.

## Context

Copilot sometimes submits a review without a disposition header whose body states that it reviewed no files, for example "Copilot wasn't able to review any files in this pull request". Such a review has no findings, so the carry treats it as converged. The head then passes the Copilot phase although Copilot reviewed none of its files.

The carry also reads the `pre_approval_gate` marker comments to decide whether the Copilot gate has passed. When that read fails, the carry refuses with the same reason as a review that has not converged. The operator cannot tell a read failure from a real finding.

## Decision

A headerless Copilot review whose body states that Copilot reviewed no files classifies as `unrecognized` in `classifyCopilotReviewBodyDisposition`. The zero-file wording covers both "wasn't able to review any files" and "reviewed 0 out of N changed files". Such a review is therefore a body-only review with findings. Below the effective round cap it converges only when an `operator`-form disposition record names it for the current head (ADR 0215). At the cap the existing round-cap fallback applies. Other headerless reviews keep their current classification.

When the read of the `pre_approval_gate` marker comments fails, the carry refuses with a typed reason that starts with `copilot_reviews_unreadable`. This reason is distinct from the not-converged reason.

## Consequences

A zero-file review no longer passes the Copilot phase on its own. A marker read failure names itself in the refusal. The `copilot_reviews_unreadable` refusal is stricter than before. A failed gate-evidence read now blocks the carry even where an operator disposition record would otherwise decide it. This fails closed. The rules are `COPILOT-STATE-CARRIED-CONVERGENCE` and `COPILOT-STATE-CONVERGED-BELOW-CAP` in the Copilot loop state graph.
