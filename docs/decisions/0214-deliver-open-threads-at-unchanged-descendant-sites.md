# 0214. Deliver open threads at unchanged descendant sites and recover through a full gate

## Status

Accepted — 2026-10-28 ([operator decision on C19](https://github.com/mfittko/dev-loops/issues/2787#issuecomment-6475481888))

## Context

[Issue 2787](https://github.com/mfittko/dev-loops/issues/2787), criterion C19, requires an exit when a fixer pushes candidate X and another commit moves the live head to H while gate threads remain open. The [accepted slice 3b plan](https://github.com/mfittko/dev-loops/issues/2787#issuecomment-6511051678) scopes that exit and five post-push `head_moved` edges; [PR 2991](https://github.com/mfittko/dev-loops/pull/2991) implements it.

This record extends ADR 0166, “Liveness-first fixer lifecycle requirements”, and ADR 0213, “Complete fixer checkpoint carry and pre-push closure”, with the open-thread delivery and full-gate admission decisions that ADR 0213 left to slice 3b. Their accepted bodies remain unchanged. The implementation changes the gate-review and pre-push contracts, so those earlier records alone do not satisfy the ADR tripwire for this slice.

## Decision

The verifier may deliver an authenticated ACT or THREAD report at descendant H when X is contained by H (`ahead` only). It preserves X, the original report, source, pull, Delta and fixing commit identities. It observes H's CI and retains the existing authentication and exact-head checks.

Before any checkpoint write, reply or resolution, it binds historical REST coordinates to each authenticated review root ID and PR, maps the original RIGHT-side range through linear history to X, and checks every intervening commit in X..H. Same-file changes outside the site and earlier-line offsets pass. Any overlap refuses with `thread_site_changed`, including a touch later reverted. LEFT-side or missing coordinates, deleted or binary files, nonlinear history and unavailable evidence refuse conservatively with `thread_site_unverifiable`.

Both refusals name the open thread and direct a full `pre_approval_gate` round to receive its full bodies through the existing hash-bound `--known-findings` input. Recovery assesses the thread under its existing ID. Authenticated `head_moved` and `no_commit` sequence closures use the same full-round input without requiring a Delta whose baseline equals the live head. Existing draft-boundary admission and gate ordering still apply.

The state graph includes `head_moved` exits from `pushed`, `ci_red`, `ci_green`, `delivery_incomplete` and `disposition_complete`. C19 replay evidence promotes only `head_moved -> full_gate_round` and `no_commit -> full_gate_round` from known gaps. CI-source intake, delta residue intake and completion re-entry remain later-slice gaps.

Requiring a new live-head-baseline Delta would recreate the recovery cycle. Rewriting the authenticated candidate to H would discard the provenance being checked. Comparing only the final file contents would miss a touch followed by a revert. A new recovery protocol is unnecessary because the existing full-gate input supplies the fallback authority.

## Consequences

Open threads can complete at a descendant head when every intervening change leaves their sites intact; uncertain or changed sites remain visible to a full gate without operator intervention. Site-history checks are conservative and may require the full-round fallback for histories they cannot verify.

Disposition delivery never supplies or carries a gate verdict. This slice does not re-arm the advisory disposition boundary, claim whole-loop liveness, change cap-round behavior, add emitter authority, or implement slices 4 to 6 or abandoned-marker recovery.

The acceptance evidence records the operator's policy decision. PR 2991's lifecycle gates require separate completion evidence. The ADR number must be checked again against the default branch before merge.
