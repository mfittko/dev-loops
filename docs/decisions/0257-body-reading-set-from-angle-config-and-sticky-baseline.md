# 0257. The body-reading set derives from the angle config, with a sticky body baseline

## Status

Accepted, 2026-11-08 ([issue 3080](https://github.com/mfittko/dev-loops/issues/3080)).

Amends [0256](0256-pr-body-is-a-separate-gate-read.md) on decision 2 and adds a decision 6. The rest of 0256 stands. Record 0256 stays unedited.

Amends [0190](0190-copilot-body-feedback-to-judge.md) on one point: a disposed `act` Copilot cluster is an open act item. The rest of 0190 stands. Record 0190 stays unedited.

## Context

Record 0256 fixed the body-reading angles as a list. A list drifts when an angle config gains a prompt that reads the PR body. A carried angle proven on an earlier body also stayed carried after a body edit. The judge disposition of the Copilot body finding needed a stable cluster id to count an `act` disposition as an open item. See [issue 3080](https://github.com/mfittko/dev-loops/issues/3080).

## Decision

2. (Amends 0256 decision 2.) On a same-head rebuild whose `pr-body` digest differs from the previous context at that head, every angle that reads the body is not complete. An angle reads the body when its configured prompt names the PR body or PR description, when its config entry declares `readsPrBody`, when its surface is `always`, or when it is a verifiedItems angle (`acceptance-criteria`, `pr-checklist`). An angle with no config entry fails closed to body-reading (`readsPrBody` in `write-gate-context.mjs`). The retirement mechanics of 0256 decision 2 are unchanged: the builder retires the completed dispatch units that hold such an angle, and any finished pending unit with a live sentinel, and every other clean unit keeps its clean artifacts and live sentinel. The retirement record names its `scopes`; a work-order pull or unit wait matches the record to a unit by that unit's scope, and a whole-round query never matches a scoped record. The `ANY_SCOPE` callers (the judge pull in `emit-judge-work-order.mjs`, `judge-pass.mjs` and the `--judge-plan` wait of `wait-for-gate-units.mjs`) match any scoped record for the gate and head, so a body-only retirement always retires the judge round.
6. (New.) A carried body-reading angle was proven on an earlier body, so `dropBodyReadingCarriedAngles` drops it from the carried set unless the body digest equals the head's sticky baseline `prBodyBaselineSha256`. The baseline is the digest of the head's first context, and the first write wins. It lives in `<gate>-<headSha>.pr-body-baseline` beside the context, so a failed context write that removes the context file keeps it. A body-only rebuild counts a unit as finished only when each findings artifact is newer than the unit's sentinel, parses as findings JSON and names the expected head and angle. It derives unit membership after the carried-angle filter.
7. (Amends 0190.) The pinned `copilot-body-feedback` cluster carries `copilotBodyClusterId`. A disposed `act` Copilot cluster is an open act item like any other act item, so the finding blocks by itself in that case. 0190 still holds for every other disposition.

## Consequences

A new body-reading angle needs only its prompt or a `readsPrBody` attribute. An unknown angle re-runs on a body edit, never silently carries. A body-only edit that is reverted to the baseline digest keeps the carried angles. Records 0190 and 0256 keep their text, so `ADR-SUPERSEDE-NOT-REWRITE` holds. `GATE-EXEC-BODY-ONLY-RERUN` and `GATE-EXEC-COPILOT-BODY-TO-JUDGE` in `skills/docs/gate-review-sub-loop-contract.md` record the behavior.
