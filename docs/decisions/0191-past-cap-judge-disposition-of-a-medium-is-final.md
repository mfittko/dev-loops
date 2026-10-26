# 0191. Past the cap the judge's disposition of a medium is final, and one closure round follows the cap round

## Status

Accepted — 2026-10-26 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462))

Amends [ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) and [ADR 0189](./0189-draft-round-cap-counts-from-landing.md) for the `severity_disagreement` blocker only. All other decisions of ADR 0185 and ADR 0189 are unchanged. The records of ADR 0185 and ADR 0189 stay unedited.

## Context

On PR 2940, the `draft_gate` round 4 at `c6af3f2223d78dfc7a1d8d75b4b0777cc41f85ed` ended with a judge result of 0 act, 1 defer and 12 reject. The round composed `blocked` with 4 `round_cap_reached` blockers. All 4 blockers were mediums that the judge had closed with a stated reason. No fixer runs past the cap, so no action could clear them. Operator decision of 2026-10-26: past the cap, the judge's disposition of a medium is final.

On PR 2944, the `draft_gate` round 4 at `e869fb2f8f8ac9c425bd703ea4bbe8aa0e158623` composed `blocked` with 6 `round_cap_reached` blockers. All 6 were judge-acted mediums with a specified remedy, and some regressed from the round 3 fix. No fixer runs past the cap, so the PR could not continue without an operator line. Operator decision of 2026-10-26 ([issue 2937](https://github.com/mfittko/dev-loops/issues/2937) S4a): the cap round may fix judge-specified remedies, followed by one closure round.

## Decision

- Final medium. Past the cap, a medium that the judge disposes `reject` with a `judgeReason`, or `defer` with a `followUpIssueNumber` (an integer greater than 0 that differs from the PR number), is final. A defer to the PR itself is not a target (AC15 of [issue 2937](https://github.com/mfittko/dev-loops/issues/2937)). A final medium raises no blocker. The round composes clean when nothing else blocks.
- Verdict. The posted verdict lists each such medium with its disposition, defer target and reason.
- Still blocking. A `high` the judge defers or rejects, a `medium` `defer` without a `followUpIssueNumber` other than the PR, a `medium` `reject` without `judgeReason`, a `failOpen: true` finding that the judge rejects or defers (the flag is set by the judge or a reviewer), a missing disposition and an unknown severity join the blocker with reason `severity_disagreement`. Every `act` item blocks, except an all-low/nit act list, which follows `GATE-EXEC-LOW-FIX-UNTIL-CAP` ([ADR 0188](./0188-low-nit-never-block.md)); past the cap that rule coerces a low/nit `act` to `defer` or `reject`, so such an item never blocks. The `failOpen` flag is the judge's mark on a disposition entry; `applyJudgeDispositions` stamps it on the cluster's findings so the ledger carries it. No fixer runs past the cap.
- Closure round. At the cap round (count equal to the cap) an act item with a judge-specified remedy (`judgeFix`) raises no blocker, so the round composes `findings_present` and the fixer fixes only the act items. `judge-pass.mjs` refuses an act disposition without a `fix`, so every judge-acted item at the cap round carries a specified remedy. A ledger act item without `judgeFix` (hand-built or legacy) blocks. The next round (count cap+1) is a closure round: its gate context diffs from the head of the last closed ledger and ignores any `--base` the caller passes, its judge work order carries `closureRound: true` and the prior act items, and a finding outside the fix delta that does not resurface a prior act item is a judge `defer` with a target issue for a `medium` or `low` and a `reject` for a `nit`. A `high` or a `question` cannot be deferred, so it stays `act` and blocks. In a closure round or any later round, any `high` or `medium` act item or a mixed act list blocks with `round_cap_reached`. Every round whose count equals cap+1 is a closure round: a blocked ledger does not count, so a further round after a blocked closure round is again counted cap+1. It runs only on operator instruction, no fixer order follows a blocked verdict, and any `high` or `medium` act item blocks. A fail-open finding the judge rejects or defers and a judge-closed high block at the cap round. A fail-open act item with a `judgeFix` at the cap round raises no blocker and goes to the fixer. It blocks as `new_act` or `resurfaced` when it is still open in the closure round.
- Reuse. The rule uses the existing cap module and disposition fields. It adds no counter and no parser.

## Consequences

A past-cap round no longer blocks on a medium that the judge closed with a recorded reason or a follow-up issue. A high, a fail-open finding the judge rejects or defers and an unreasoned disposition still stop the round. The judge carries the decision for a medium, and the posted verdict makes it visible. A PR at the cap with judge-specified remedies continues through one fixer pass and one closure round without an operator line, and the continuation stays bounded: a closure round with any act item escalates.
