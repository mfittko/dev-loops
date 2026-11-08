# 0256. The PR body is a separate gate read

## Status

Accepted, 2026-11-08 ([issue 3080](https://github.com/mfittko/dev-loops/issues/3080)).

Amends the retirement requirement of `GATE-EXEC-ROUND-RETIREMENT`. Every other decision of the gate round contract stays in force.

Amends [0228](0228-slice-pr-keeps-closing-ref.md) on one point: the judge work order reads the PR body from the pinned `pr-body` read, no longer from the gate-context evidence file. The rest of 0228 stands. Record 0228 stays unedited.

## Context

The shared evidence file rendered the PR body, and the briefing prefix listed that file's sha256. A PR-body-only edit after a gate round therefore changed the prefix bytes. The rebuild guard refused different prefix bytes while a live reviewer sentinel existed, and its only remedy was `retire-gate-round`, which discards every reviewer's work. PR 3075 retired two rounds for body edits. The same edit also made a same-head rerun unsafe without ledger retention, which slice 1 of issue 3080 added.

## Decision

1. The PR body leaves the evidence file and the scoped variants. `write-gate-context.mjs` writes it to the digest-keyed `<gate>-<headSha>.pr-body-<digest12>.md` and binds it as a required `pr-body` read after the prefix render, the same way `known-findings` is bound. The prefix and evidence bytes no longer depend on the body.
2. On a same-head rebuild whose `pr-body` digest differs from the previous context at that head, the angles with surface `always` and the verifiedItems angles (`acceptance-criteria`, `pr-checklist`) are not complete. The builder retires the completed dispatch units that hold such an angle, and any finished pending unit with a live sentinel (sentinel, dispatch record and findings artifacts, through `retire-gate-round` with named scopes and files), and every other clean unit keeps its clean artifacts and live sentinel. The retirement record's `scopes` retire only the named units for every consumer. A unit that holds a body-reading angle and is still running refuses the rebuild. When the PR body is the spec of record, a body digest change under live sentinels refuses with the retire remedy.
3. `--pending` emission keeps the completed prior units of the round in the persisted emit plan, marked `resumed`, so fan-in provenance covers every angle. The printed dispatch list holds only the units to run.
4. `emit-judge-work-order.mjs` pins the `pr-body` read and refuses with `pr_body_stale` when the live PR body has another sha256, naming both digests. An unreadable live body refuses with `pr_body_unreadable`. The pin is never refreshed silently.
5. The spec-digest check and the `adr-tripwire:allow` marker refusal stay unchanged. A linked-issue body edit keeps the prefix refusal.

## Consequences

A body-only edit costs the re-run of the body-reading units only, with no operator step. The re-run granularity is the dispatch unit, so `scope` and `pr-checklist` re-run beside `pr-description` in the default `process` unit. `acceptance-criteria` re-runs as well, because it copies its verified labels from the body. The first rebuild after upgrade changes the prefix bytes once, because the evidence file loses its body section. A live round at that moment retires through the existing remedy. The judge now needs one GitHub read, and an offline emission refuses `pr_body_unreadable`. `GATE-EXEC-BODY-ONLY-RERUN` in `skills/docs/gate-review-sub-loop-contract.md` records the behavior.
