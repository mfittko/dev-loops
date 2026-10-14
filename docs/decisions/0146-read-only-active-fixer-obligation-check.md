# 0146. Check active full fixer obligations through the existing verifier

## Status

Accepted — 2026-10-14 ([issue 2767](https://github.com/mfittko/dev-loops/issues/2767))

## Context

The operator accepted this consumer decision in issue 2767's implementation dispatch. Gate coordination and Copilot requests previously discovered unverified fixer work from worker-declared tackled entries, allowing missing or empty output to hide an active full obligation. This is the first consumer child of [durable fixer completion](https://github.com/mfittko/dev-loops/issues/2763); the current producer must still pass its own gate.

The numbering check fetched origin on 2026-10-14 and inspected actual `origin/main` at `44f57175a215711923fb128d74e9357b33ff95e9` (records through 0144), all 111 git-listed worktrees and all-ref history. A1's in-flight record reserves 0145; two archived worktrees also hold 0145. No 0146 existed, so this record uses the next free number without renumbering accepted history.

## Decision

Add a read-only `--check` mode to `verify-fixer-disposition.mjs`, reusing its current-protocol evidence, live-state and containment checks, with no writes or GitHub actions. The shared gate/Copilot resolver checks an applicable active canonical full plan before accepting a checkpoint or absence. Missing or invalid evidence blocks with a precise cause. THREAD units require only their digest-bound source's own thread IDs; authentic threadless ACT units retain valid empty dispositions with complete required coverage.

Keep the existing mutating verifier as the completion path and preserve checkpoint/historical tackled-handoff fallback when no active full plan applies, including commit-only index overwrite. The owning procedure is [GATE-EXEC-FIXER-DISPOSITION-BOUNDARY](../../skills/docs/gate-review-sub-loop-contract.md). Requiring new producer fields now would break self-hosting; inferring completion from a worker's empty output would preserve the gap.

## Consequences

An active obligation survives absent or incomplete worker output, while unchanged current-format producer deliveries remain usable. Read-only checking cannot manufacture completion evidence. Deterministic report construction and bounded-out coverage changes remain with [2768](https://github.com/mfittko/dev-loops/issues/2768); producer rollout remains with [2765](https://github.com/mfittko/dev-loops/issues/2765), and A1 recovery remains with [2766](https://github.com/mfittko/dev-loops/issues/2766).
