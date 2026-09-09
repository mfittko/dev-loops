# 0066. PR pickup integrates the base branch FIRST; never CI-wait on a CONFLICTING/DIRTY branch

## Status

Accepted — 2026-09-09 ([issue #2096](https://github.com/mfittko/dev-loops/issues/2096), [PR 2104](https://github.com/mfittko/dev-loops/pull/2104))

Adds two rules to the "Conflict reconciliation path" of `skills/docs/public-dev-loop-contract.md`: `FACADE-PICKUP-INTEGRATE-BASE-FIRST` and `FACADE-NEVER-CI-WAIT-WHILE-DIRTY`. Complements `FACADE-CONFLICT-REVALIDATE-NEW-HEAD` (re-gate at the new head) without changing it.

## Context

When a dev-loop picks up an existing PR (continue / fix / merge route), the loop interpreted state and could route to a Copilot-review / CI wait without ever reading the PR's `mergeable` / `mergeStateStatus`. GitHub does not dispatch `pull_request` CI on a conflicted PR: a PR that is behind or diverged from its base reports `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY`, and no CI run is ever created. A loop that proceeds to wait for CI on such a branch waits forever with no signal and no progress — a hard deadlock, observed picking up a PR left behind post-epic `main`.

The pre-flight PR handoff existed but did not deterministically (a) integrate the base first and (b) refuse to CI-wait on a branch whose merge state means CI can never dispatch. The snapshot the loop interprets did not even carry merge state.

## Decision

Base-branch integration is the deterministic FIRST action of the PR-pickup preflight, ahead of any gate run or CI-wait. The rule lives in the sanctioned pickup path (`runBasePickupPreflight` in `scripts/loop/copilot-pr-handoff.mjs`), so every coordinator does it the same way without re-deriving it:

1. Read the PR's `mergeable` / `mergeStateStatus` (carried on the snapshot by `detect-copilot-loop-state.mjs`, from the existing `gh pr view`).
2. When the branch is behind base or `CONFLICTING`/`DIRTY`, integrate `origin/<base>` via the sanctioned `resolve-pr-conflicts.mjs` (merge, additive-CHANGELOG auto-resolve, else fail closed) and push, then re-baseline the snapshot at the new head so the gate/CI re-runs there.
3. NEVER enter a CI/review wait while `mergeStateStatus` is `DIRTY` / `mergeable` is `CONFLICTING`. The preflight integrates first, or fails closed with a clear actionable stop; a fail-closed backstop at the watch decision refuses to route a conflicted head to a wait. A watch-refresh re-entry never auto-merges on every poll but still refuses to re-enter a wait while conflicting.

`FACADE-PICKUP-INTEGRATE-BASE-FIRST` and `FACADE-NEVER-CI-WAIT-WHILE-DIRTY` are registered in `skills/docs/required-rules.json` and runtime-enforced (their IDs appear in the preflight refusal messages).

## Consequences

The pickup deadlock is closed: a conflicted or behind PR is integrated and re-gated at the new head, or the loop stops with an actionable message, instead of waiting on CI that can never dispatch. Integration reuses the existing sanctioned resolver, so semantic conflicts that need human judgment still fail closed (no new auto-resolution). CI configuration/dispatch, force-push semantics, and the gate/merge base-resolution are unchanged. The seam is a single chokepoint (`runHandoff`) plus three passthrough snapshot fields; the contract prose and generated `.claude/` mirror are updated in lockstep, and a rehearsal in `test/loop/copilot-pr-handoff.test.mjs` asserts no CI-wait is entered while `DIRTY` (plus base-integrated-first, behind-integration, fail-closed-on-unresolvable, and watch-refresh no-auto-merge paths).
