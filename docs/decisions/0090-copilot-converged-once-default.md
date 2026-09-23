# 0090. One converged Copilot review stands for later heads by default, with a strict opt-in

## Status

Accepted — 2026-09-24 ([issue 2427](https://github.com/mfittko/dev-loops/issues/2427))

Amends [ADR 0012](./0012-copilot-round-cap.md): that record opens a new Copilot cycle when a significant change lands after a converged review, even when the round cap is spent. This record replaces that clause with the converged-once default and a strict opt-in. It also changes the merge rule from issue 2392 (PR 2400), which enforces the ADR 0012 clause at merge, by adding the `converged_once` disposition.

## Context

PR 2400 made `copilot_convergence` refuse a head without a current-head Copilot review unless a sanctioned disposition covers it. Below the round cap, only `docs_only_suppression` or, for an internal-only PR, `copilot_gate_disabled` covered it. At the cap, `round_cap_clean_fallback` applied only when the last review did not converge or no significant change landed since. Any code fix after a clean Copilot review therefore needed a fresh Copilot round, forced at the cap.

On 2026-09-23 this cost 10 to 20 minutes per fix round, plus a forced re-request after the cap. PR 2411 received 7 Copilot reviews on 7 distinct heads, and each head also needed a full `pre_approval_gate` fan-out. The head-bound `pre_approval_gate` already reviews every head ([ADR 0006](./0006-two-gate-draft-preapproval-split.md)). PR 2400 was unreleased, so the default could change before `v1.0.4` stable.

## Decision

- A new boolean `refinement.requireCopilotConvergenceAtLatestHead` sits next to `refinement.maxCopilotRounds`. Default `false` selects the converged-once rule. `true` restores the ADR 0012 behavior in loop and merge. Loop and merge read the setting through one resolver, `resolveRequireCopilotConvergenceAtLatestHead` in `@dev-loops/core/config`. Light-dispatched PRs use the same value.
- Converged. The latest submitted Copilot review decides. It is converged when the PR has zero unresolved review threads, no Copilot review request or PENDING Copilot review is outstanding on the current head, and the review body is 🟢, headerless, or 🔵; or the body is 🟡 or unrecognized and that review opened a thread of its own or a trusted copilot-body-disposition record names it.
- Latest review wins. An earlier converged review never holds against a later Copilot review. A later findings review blocks until its threads are resolved or a record names it.
- Later heads. In the default mode, when the latest review is converged and sits on an earlier head, `copilot_convergence` passes for the current head whatever the delta. Ancestry and delta class are not checked. `pre_approval_gate` stays the authority for the current head.
- Still refused. A PR that Copilot never reviewed while the Copilot gate is enabled, a PR whose latest Copilot review is not converged, and a current-head 🟡 or unrecognized review without an operator record still fail `copilot_convergence`. `copilot_gate_disabled` and `round_cap_clean_fallback` for a last review that did not converge are unchanged.
- One predicate. `resolveCarriedConvergence` in `scripts/loop/_copilot-convergence-carry.mjs` decides in both modes. The request tool, the gate coordination detector, the handoff, the checkpoint-verdict gate-entry re-check, and merge all call it. The default mode skips its docs-only delta condition. The strict mode keeps it.
- Loop side. In the default mode the loop opens no new Copilot cycle after convergence. `request-copilot-review.mjs` returns `suppressed_post_convergence` below the cap, at the cap, and under `--force-rerequest-review`. The detector and `copilot-pr-handoff.mjs` skip the round-cap reopen and route to `run_pre_approval_gate`.
- Merge. The merge result keeps the three-state `copilotConvergenceState`. For `no_current_head_review` passed by the default rule, merge pins `converged_once` to the current head and names the converged review in `copilotCarriedConvergence` (`source: "converged_once"`, `sourceReviewId`, `sourceHeadSha`, `bodyDisposition`). Precedence: `copilot_gate_disabled` for cap 0, then `converged_once`, then `round_cap_clean_fallback`, then (strict mode) `docs_only_suppression`, then `copilot_gate_disabled` for an internal-only PR.
- A copilot-body-disposition record clears a current-head Copilot finding only when it names the review that raised the finding. merge-pr reads one review list for the raw convergence state and the body resolver.

Rejected: keeping the per-head Copilot requirement as the default (the churn above); checking ancestry or delta class in the default mode (the head-bound `pre_approval_gate` already covers every head); removing the docs-only machinery now (the strict mode still uses it).

## Consequences

A code fix after a converged Copilot review costs one `pre_approval_gate` round instead of a Copilot round plus a gate round. Copilot reviews a later head only when it reviews on its own (for example the ruleset review when a PR becomes ready), and that review then decides by the latest-review rule. A repository that wants Copilot on every significant head sets `refinement.requireCopilotConvergenceAtLatestHead: true`. The docs-only delta machinery (`resolveConvergenceCarry`, `docs_only_suppression`, `suppressed_post_convergence_docs_only`) stays reachable only through the strict mode and the operator suppression marker.
