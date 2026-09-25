# 0095. Single-wave gate fan-out without a primer barrier

## Status

Accepted — 2026-09-25 ([issue #2414](https://github.com/mfittko/dev-loops/issues/2414))

Amends [0086](0086-gate-fanout-reference-seeded-work-orders.md).
Amends [0048](0048-gate-full-dispatches-grouped-two-knob-dispatch-bounds.md). <!-- secret-scan:allow ADR file link, not a credential -->
Amends [0056](0056-bounded-parallel-gate-dispatch.md).

It amends 0086's decision that "the primer stays mandatory for ordering", 0048's `maxAnglesPerGroup` default of 3, and 0056's repo value `maxConcurrent: 3` aligned with `queue.maxParallel`. It supersedes the mandatory-primer contract-rule assumption of [issue #1462](https://github.com/mfittko/dev-loops/issues/1462) and [issue #1468](https://github.com/mfittko/dev-loops/issues/1468) by reference. The rest of those records stays unchanged.

## Context

`GATE-EXEC-PRIME` required every gate fan-out to build the shared prefix, dispatch a lead reviewer or a dedicated primer, wait for an observable barrier, and only then release the remaining reviewers. On completion-only harnesses the default lead-reviewer form serialized one full review before the rest of the wave. A dedicated primer avoided that wait but added one model spawn. Issues #1462 and #1468 justified the barrier when the shared provider-visible prefix carried the expensive common corpus.

ADR 0086 moved the bulk evidence behind `requiredReads`. Reviewer prompts became bounded work orders of at most 30 KB, and each reviewer loads the large evidence after spawn. A primer can now warm only the compact shared request prefix. It cannot establish reuse for the post-spawn tool reads that dominate evidence loading. ADR 0086 already recorded the primer as non-load-bearing.

A typical round also needed more than one wave. Measured with `resolveFanoutGroups` and the emitter cap-split under this repo's `.devloops` and the shipped group table, a draft round of 10 to 12 angles emitted 5 units, a preApproval round of 10 angles 6 units, and one of 12 angles 7 units. With `maxConcurrent: 3` that is two or three waves.

## Decision

The primer barrier is removed. After the round context is built and validated and the emitter writes the bounded work orders, the gate coordinator releases the first reviewer wave immediately, bounded only by `resolveFanoutEffectiveConcurrency` (`GATE-EXEC-FIRST-WAVE-RELEASE`). No primer spawn or lead reviewer precedes that wave. `GATE-EXEC-PRIME` and `GATE-EXEC-PRIMER-EVIDENCE` are retired, and the primer-only evidence module and the fan-in primer flags are removed.

Cache priming is optional and non-semantic. A harness or execution adapter may prime only when its capability and measured economics justify it. Priming never changes review semantics or evidence, never reduces reviewer independence, and never becomes a fan-in or verdict precondition. Opaque or unavailable cache telemetry records `cacheReuseVerified: false`: it is never described as verified reuse, and missing telemetry never fails the gate. Recorded telemetry stays an optional measurement input under `GATE-EXEC-CACHE-TELEMETRY`.

A typical round fits one wave. `REVIEWER_UNIT_MAX_ANGLES` and `REVIEWER_UNIT_BUDGET.maxAngles` are 5. The `gates.fanout.maxAnglesPerGroup` default is 5. The shipped `holistic` singleton group is removed: `holistic` stays a mandatory angle with its own prompt, findings artifact and provenance entry, joins the leftover auto-chunk pool, and may share a reviewer unit with other leftover angles. A repo restores the `holistic` singleton unit by adding `{ name: holistic, angles: [holistic] }` to its `gates.fanout.groups` override, with no code change. The pairing guard re-derives groups over the ledger's fresh and carried angles, so a unit with a carried angle keeps its emitted boundaries. The `REVIEWER_UNIT_BUDGET` turn and tool-call limits (45 and 50) stay unchanged. This repo sets `gates.fanout.maxConcurrent: 4` and keeps `queue.maxParallel: 3`. The combined peak is 3 runners x 4 units = 12 concurrent reviewer units, plus one driver and one gate coordinator per runner. `GATE-EXEC-DISPATCH-RETRY-BACKOFF` absorbs transient 429s. If 429s rise, lower `queue.maxParallel` first and keep `maxConcurrent` at 4 so a single round stays one wave.

Cross-harness decision: the unit bound 5, the `maxAnglesPerGroup` default 5 and the `holistic` singleton removal apply to every repo and harness. The `maxConcurrent` default 4, `sequential: false` and the Claude cap 4 (`CLAUDE_MAX_EFFECTIVE_CONCURRENT`) stay unchanged. Pi keeps one `runs.all([...])` call per wave, so a typical round is one call. A consumer that overrides `gates.fanout.groups` wholesale keeps its own table. A consumer that set `maxAnglesPerGroup` above 3 was cap-split at 3 and is now cap-split at 5.

A non-zero count of `reviewer_budget_exhausted` blockers on 5-angle units stops the PR for an operator decision on `REVIEWER_UNIT_BUDGET`.

This record also corrects ADR 0086's stated reason for the unhashed `context` read. ADR 0086 says the `context` entry carries no hash "because the context JSON embeds the prefix identity". That reason is wrong: the context artifact embeds no prefix identity, and the prefix hash lives only in the request plan (`sharedPrefixHash`) and on sentinels. The actual reason: `write-gate-context.mjs` writes the context JSON last as the completion marker, and the JSON contains the `requiredReads` manifest itself and a per-write `loggedAt`, so the prefix cannot hash it. Consequence: the context JSON and its `.adjacentCode` are not tamper-bound.

We rejected keeping the barrier as an optional config flag, because a gate phase whose only effect is a possible cache write adds a model-mediated serialization step with no correctness value. We rejected raising the unit bound alone, because the `holistic` singleton still forced a fifth unit. We rejected raising `queue.maxParallel`, because the combined peak would grow without shortening a round.

## Consequences

A typical 10-to-12-angle round emits at most 4 units and releases them in one wave, under both the Claude clamp and a Pi env. A full 20-angle draft pool emits 6 units and needs two waves, which is accepted. Reviewer breadth is unchanged: the resolved angle set, per-angle findings artifacts, fresh-context isolation, carry-forward proof and the gate verdict rules stay the same; only the number of angles per unit and the unit count change. The prefix-hash, required-read hash, sentinel, same-head rebuild and retirement, and fan-in provenance guards stay load-bearing. Each reviewer unit now spends the same 45-turn, 50-tool-call budget on up to 5 angles, so the transcript measurement tracks `reviewer_budget_exhausted` counts. `test/github/fanout-single-wave.test.mjs`, `packages/core/test/reviewer-unit-bound.test.mjs`, `packages/core/test/config.test.mjs` and `test/contracts/gate-reviewer-work-order-contract.test.mjs` pin the single-wave plan, the bound, the `holistic` placement and the contract wording.
