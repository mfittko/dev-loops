# 0107. The fixer mutates only within its pulled work order's authority

## Status

Accepted — 2026-09-28 ([issue #2420](https://github.com/mfittko/dev-loops/issues/2420))

Amends [ADR 0106](./0106-workers-pull-deterministic-work-orders.md): the fixer registers its role adapter on the pull protocol, and a current fixer pull now also bounds what the fixer may mutate. The rest of ADR 0106 stays unchanged.

## Context

ADR 0106 moved the gate reviewer onto compact dispatch and left the fixer for a later slice. The fixer still received a prose brief. Its disposition handoff reached `verify-fixer-disposition.mjs` through caller-supplied `--dispositions` or `--dispositions-file` inputs. Nothing tied a fixer's edits, commits or pushes to the task it was given. Nothing tied the handoff to a delivered work order either.

## Decision

The fixer registers the `fixer` role adapter in `scripts/loop/emit-fixer-work-order.mjs`. The work order pins typed sources: the judge-pass act list or the unresolved review threads, plus an optional pre-push delta result. It pins the phase, `commit_only` or `full`. It pins `mutationAuthority` as `{ repo, pr, branch, allowedPaths }`, and these fields are semantic input to `workOrderDigest`. The branch comes from the PR head. Every emission uses the PR head SHA (`headRefOid`), and a different head refuses.

`allowedPaths` defaults to the whole repository, so today's fixer policy is unchanged.

The emitter prints a per-harness dispatch payload for Claude and Pi, built from the fixed compact pointer only. An unsupported harness refuses. The Claude payload names `fixer` in a dev-loops source checkout (the `dev-loops-run` checkout rule) and the plugin install's `dev-loops:fixer` elsewhere; the hooks normalize both. `assertFixerDispatchPayload` is a test-time shape check of that payload. No dispatch seam runs it at runtime, so compactness rests on the coordinator dispatching the emitted payload unchanged.

On Claude, the PreToolUse Edit/Write guard bounds fixer file writes to a current pull. It grants authority only from a fixer pull receipt in the main checkout. The receipt's plan must lie under `<main>/tmp/gate-fixer`, must still reproduce its digest and must pass the pull's own staleness checks: unchanged required reads, no retired gate round, and an authority branch that still contains the work order head. Spec staleness means a changed required read (the act list or threads, plus the delta result); the pinned contract digests and `configSha256` are digest identity only, as in the shared judge and reviewer adapters. The write grant's outputRef is derived from the plan location and execution identity, never read from the plan's outputRefs field. A grant binds to the subagent that pulled it: the Bash gate records the fixer's hook `agent_id` when it runs the sanctioned pull line, and the Edit/Write guard honors a receipt only for that `agent_id`, so a replacement fixer must re-pull and a call without `agent_id` gets no grant. The guard runs its git calls with `GIT_DIR` and `GIT_WORK_TREE` removed from the environment.

The Edit/Write guard denies writes outside the grant branch and `allowedPaths`. It denies writes to the main checkout's `tmp/` except the work order's outputRef. A target outside every listed checkout is scratch space and stays allowed.

The Bash gate applies no fixer-specific git check. The fixer's Bash commit/push boundary is owned by [issue #2534](https://github.com/mfittko/dev-loops/issues/2534).

Pi has no tool-gating surface. On Pi, the boundary is the pull contract plus the consumer checks.

`verify-fixer-disposition.mjs` requires `--fixer-plan`. The `--dispositions` and `--dispositions-file` inputs are removed. The consumer re-digests the plan and verifies a matching fixer pull receipt whose recorded plan path is the `--fixer-plan` path, so a copied plan refuses. It reads the handoff only from the outputRef derived from the plan location, refuses a plan whose outputRef differs, and reads it only when its mtime is not older than the receipt file's mtime. The handoff must name the observed live PR head.

The canonical digest moved to `@dev-loops/core/loop/work-order-digest`, so the hook bundle reuses the one serializer. Digests are unchanged.

We rejected keeping prose fixer briefs, because they bless model-authored work orders. We rejected a caller-supplied disposition handoff, because it proves nothing about delivery. We rejected a fixer-specific receipt or reader, because ADR 0106 owns one shared protocol.

## Consequences

On Claude, a fixer dispatched without a work order can no longer Edit or Write a repository file outside its authority. The consumer no longer trusts a disposition list that the caller supplies.

The boundary has known ceilings. Fixer Bash commands keep only the general Bash gate rules until [issue #2534](https://github.com/mfittko/dev-loops/issues/2534) lands: a fixer can commit or push any branch, and a redirect, `cp`, `sed -i` or an interpreter writes any path, including the main checkout's `tmp/` receipts and binding markers, which the Edit/Write guard alone protects. The full closure is process-owned worker I/O ([#2343](https://github.com/mfittko/dev-loops/issues/2343)), outside this decision. OutputRefs stay local material outside the digest, so the Edit/Write guard and the consumer derive the outputRef instead of trusting the field.

`test/loop/emit-fixer-work-order.test.mjs`, `test/github/verify-fixer-disposition.test.mjs` and `packages/core/test/claude-hook-decisions.test.mjs` pin this behavior.
