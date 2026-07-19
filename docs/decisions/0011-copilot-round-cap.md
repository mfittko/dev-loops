# 0011. Cap Copilot review rounds, accept the clean fallback, and allow opting out

## Status

Accepted

## Context

The loop's coupling to GitHub Copilot review could ping-pong indefinitely: each re-request cycle drip-feeds findings serially at external-reviewer latency and cost, with no defined end state ([issue 361](https://github.com/mfittko/dev-loops/issues/361), implemented in [PR 365](https://github.com/mfittko/dev-loops/pull/365)). Once a cap existed, its edges surfaced as follow-up defects: a head accepted at the cap deadlocked against gate exemption enforcement ([issue 587](https://github.com/mfittko/dev-loops/issues/587)) and against the Copilot gate itself ([PR 854](https://github.com/mfittko/dev-loops/pull/854)). Repos without Copilot configured had no documented way to skip the forced review round at all ([PR 835](https://github.com/mfittko/dev-loops/pull/835)). Later, issue-less lightweight dispatch needed an even tighter budget than the full-PR cap ([issue 1210](https://github.com/mfittko/dev-loops/issues/1210), [PR 1215](https://github.com/mfittko/dev-loops/pull/1215)). The cap lives at `refinement.maxCopilotRounds` in `packages/core/src/config/config.mjs`; this repo's `.devloops` sets it to `2`.

## Decision

We cap automated Copilot review rounds with the configurable `refinement.maxCopilotRounds` (shipped default 5; this repo runs 2; `0` disables the Copilot review gate entirely by reusing the existing internal-only routing). A head accepted via the round-cap clean fallback passes the gate chain cleanly rather than deadlocking — convergence with unexhausted review is a sanctioned terminal state. Significant post-convergence changes (new or changed product, test, config, or CI content) open a new cycle regardless of the spent cap, while a provably docs-only head bump is suppressed fail-closed through the convergence carry-forward seam, so prose edits never force a fresh blocking round. Light-dispatched PRs compose a tighter effective cap, the minimum of the lightweight cap (default 1) and the full cap. We rejected unbounded re-requesting (the status quo the cap replaces), a separate boolean disable flag (overloading the cap at zero reuses tested routing instead of adding a switch), and treating a capped-out head as a merge-blocking anomaly requiring manual override.

## Consequences

The only third-party reviewer in the loop now has bounded cost and latency, and every PR reaches a defined end state instead of an open-ended re-request cycle. Convergence despite unexhausted review is evidence-clean by construction, so the gate chain needs no manual exemptions at the cap. Several later gate contracts — round-cap deadlock handling, post-cap head routing, and the docs-only suppression guard — exist purely to keep this policy's edges closed, which is ongoing maintenance surface. The composed lightweight cap only binds when every round-cap-consuming helper is invoked with the lightweight flag, a consistency obligation the skills must carry.
