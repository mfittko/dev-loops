# 0256. The PR body is a separate gate read

## Status

Accepted, 2026-11-08 ([issue 3080](https://github.com/mfittko/dev-loops/issues/3080)).

Amends the retirement requirement of `GATE-EXEC-ROUND-RETIREMENT`. Every other decision of the gate round contract stays in force.

Amends [0228](0228-slice-pr-keeps-closing-ref.md) on one point: the judge work order reads the PR body from the pinned `pr-body` read, no longer from the gate-context evidence file. The rest of 0228 stands. Record 0228 stays unedited.

## Context

The shared evidence file rendered the PR body, and the briefing prefix listed that file's sha256. A PR-body-only edit after a gate round therefore changed the prefix bytes. The rebuild guard refused different prefix bytes while a live reviewer sentinel existed, and its only remedy was `retire-gate-round`, which discards every reviewer's work. PR 3075 retired two rounds for body edits. The same edit also made a same-head rerun unsafe without ledger retention, which slice 1 of issue 3080 added.

## Decision

1. The PR body leaves the evidence file and the scoped variants. `write-gate-context.mjs` writes it to the digest-keyed `<gate>-<headSha>.pr-body-<digest12>.md` and binds it as a required `pr-body` read after the prefix render, the same way `known-findings` is bound. The prefix and evidence bytes no longer depend on the body.
2. On a same-head rebuild whose `pr-body` digest differs from the previous context at that head, every angle that reads the body is not complete. An angle reads the body when its configured prompt names the PR body or PR description, when its config entry declares `readsPrBody`, when its surface is `always`, or when it is a verifiedItems angle (`acceptance-criteria`, `pr-checklist`). An angle with no config entry fails closed to body-reading (`readsPrBody` in `write-gate-context.mjs`). The builder retires the completed dispatch units that hold such an angle, and any finished pending unit with a live sentinel (sentinel, dispatch record and findings artifacts, through `retire-gate-round` with named scopes and files), and every other clean unit keeps its clean artifacts and live sentinel. The retirement record names its `scopes`; a work-order pull or unit wait matches the record to a unit by that unit's scope, and a whole-round query never matches a scoped record. The `ANY_SCOPE` callers (the judge pull in `emit-judge-work-order.mjs`, `judge-pass.mjs` and the `--judge-plan` wait of `wait-for-gate-units.mjs`) match any scoped record for the gate and head, so a body-only retirement always retires the judge round. The unit wait ends as `round_retired` when a scoped record names any waited unit. A pending unit that is still running refuses the rebuild, body-reading or not. The known-findings read is digest-keyed like the pr-body read, so a capture that gained a thread never rewrites a pinned file. When the PR body is the spec of record, a body digest change under live sentinels refuses with the retire remedy.
3. `--pending` emission keeps the completed prior units of the round in the persisted emit plan, marked `resumed`, so fan-in provenance covers every angle. The printed dispatch list holds only the units to run.
4. `emit-judge-work-order.mjs` pins the `pr-body` read and refuses with `pr_body_stale` when the live PR body has another sha256, naming both digests. An unreadable live body refuses with `pr_body_unreadable`. The pin is never refreshed silently.
5. The spec-digest check and the `adr-tripwire:allow` marker refusal stay unchanged. A linked-issue body edit keeps the prefix refusal.

6. A carried body-reading angle was proven on an earlier body, so `dropBodyReadingCarriedAngles` drops it from the carried set unless the body digest equals the head's sticky baseline `prBodyBaselineSha256`. The baseline is the digest of the head's first context. It lives in `<gate>-<headSha>.pr-body-baseline` beside the context, so a failed context write that removes the context file keeps it. A body-only rebuild counts a unit as finished only when each findings artifact is newer than the unit's sentinel, parses as findings JSON and names the expected head and angle. It derives unit membership after the carried-angle filter.

## Consequences

A body-only edit costs the re-run of the body-reading units only, with no operator step. The re-run granularity is the dispatch unit, so `input-validation` re-runs beside `correctness` in the default `correctness-input` unit. `acceptance-criteria` re-runs as well, because it copies its verified labels from the body. The first rebuild after upgrade changes the prefix bytes once, because the evidence file loses its body section. A live round at that moment retires through the existing remedy. The judge now needs one GitHub read, and an offline emission refuses `pr_body_unreadable`. `GATE-EXEC-BODY-ONLY-RERUN` in `skills/docs/gate-review-sub-loop-contract.md` records the behavior.
