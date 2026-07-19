# 0026. Let micro-PRs pass gates via a single inline check with fail-closed scope re-derivation and mandatory escalation

## Status

Accepted

## Context

The local-implementation loop's multi-reviewer gate fan-out is correct for phase-level work but heavy for a 2-file/20-line fix, and [issue 448](https://github.com/mfittko/dev-loops/issues/448) asked for a light-mode variant for small scoped changes. [Issue 1043](https://github.com/mfittko/dev-loops/issues/1043) wired the already-present `localImplementation.lightMode` config into gate dispatch via [PR 1080](https://github.com/mfittko/dev-loops/pull/1080), which added `resolveGateDispatchMode` and the `gate:full` label override. That left a gap: `gates.requireFanoutEvidence` (on by default) rejected any non-`fanout_fanin` verdict, so a light-dispatched PR's inline verdict was unmergeable — observed live on a 1-file/11-line PR and reported as [issue 1174](https://github.com/mfittko/dev-loops/issues/1174). [PR 1185](https://github.com/mfittko/dev-loops/pull/1185) closed it by making the pre-merge evidence check (`buildPreMergeGateCheck` in `scripts/github/detect-checkpoint-evidence.mjs`) light-mode-aware; the rules are codified in `skills/docs/gate-review-sub-loop-contract.md` and the config surface lives in `packages/core/src/config/config.mjs`.

## Decision

Opt-in `localImplementation.lightMode` collapses the gate to one `inline_single_agent` check for under-threshold changes; built-in defaults ship `enabled: false` with `maxFiles: 3` / `maxLines: 200`, and this repo's `.devloops` caps at `maxFiles: 2` / `maxLines: 20`. The pre-merge evidence check accepts such a verdict only when all of the following hold, failing closed otherwise: light mode is enabled, the merge-base diff is re-derived at merge time and genuinely under threshold (underivable scope rejects), no `gate:full` label is present, and the verdict records a non-empty inline reason. Any finding at a blocking severity mandates escalation to the full fan-out (rule `GATE-EXEC-LIGHT-ESCALATION`) — the inline verdict never absorbs a blocking finding — and a findings-log ledger is still required for the reviewed head. We rejected the blunt alternative of disabling `requireFanoutEvidence` repo-wide, which would drop enforcement for every PR, and rejected trusting the dispatch-time scope claim, re-deriving scope from the diff at merge instead. Light mode changes HOW the gate runs, never WHETHER the draft boundary exists: `workflow.requireDraftFirst` is honored regardless.

## Consequences

This is a deliberately bounded review-economics carve-out: a sanctioned cheap path exists for micro-PRs, and it is the reason inline verdicts are ever accepted by the evidence machinery at all. Cheap review cannot be smuggled onto large changes, because scope is re-checked at merge time from the merge-base diff rather than trusted from claims, and the `gate:full` label lets an operator force the full fan-out at any size. The fan-out path itself is untouched — `fanout_fanin` verdicts, ledger, and provenance enforcement remain byte-identical — while a light-accepted inline verdict is exempt from fan-out provenance because it is already scope-bounded and carries no multi-reviewer trail. The cost is a per-repo tuning knob: thresholds set too high would widen the carve-out, which is why this repo holds them well below the shipped defaults.
