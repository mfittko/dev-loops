# 0213. Complete fixer checkpoints carry and authenticated sequences close before push

## Status

Accepted — 2026-10-29 ([issue 2787](https://github.com/mfittko/dev-loops/issues/2787), slice 3a split approved on the issue).

Amends ADR 0166, ADR 0155, ADR 0107, ADR 0131, ADR 0143 and ADR 0149. Accepted records remain unchanged.

## Context

A later developer commit made an authentic disposition appear stale. A no-commit pass removed a marker without authenticating its owner, while a foreign commit stranded the sequence behind a stale coverage refusal.

## Decision

Normal verification stamps a checkpoint `complete: true` only after successful final evaluation. Earlier incomplete writes and legacy unstamped checkpoints remain usable at their exact head, but cannot carry. The detector authenticates the active delivery at its original head, binds the checkpoint to that execution and report, requires an explicit `ahead` relation to the live head, and rechecks every tackled fixing commit, evidenced reply and live resolution. Current-head evidence takes precedence. No gate verdict carries with the disposition.

The THREAD full emitter binds the clearing delta's `candidateHead` to the actual committed worktree candidate. The verifier retains its independent pushed-head guard.

The coordinator's pre-push delta check uses the existing canonical plan, pull receipt, materialization and source authentication before closing a matching ungranted branch marker. HEAD equal to the baseline yields `no_commit`; a different HEAD from an authenticated handback yields `head_moved`. Both return `nextStep: push_to_gate`. Missing or malformed evidence never proves a foreign commit. The genuine fixer-commit delta path remains strict.

## Consequences

ACT, THREAD, Pi, Claude and Codex retain their existing authority boundaries. Open-thread full-gate admission and post-push head movement remain slice 3b work. Their conformance gaps remain registered; this decision does not establish whole-loop liveness, re-arm the advisory boundary or introduce general abandoned-marker recovery.
