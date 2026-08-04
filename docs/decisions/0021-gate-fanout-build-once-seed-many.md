# 0021. Run gate reviews as a fan-out/fan-in of scoped per-angle reviewers over one build-once, hash-enforced context bundle

## Status

Accepted — 2026-06-25 ([PR 881](https://github.com/mfittko/dev-loops/pull/881))

## Context

Gate reviews began as single-agent passes contaminated by the implementing agent's loaded context, so [issue 463](https://github.com/mfittko/dev-loops/issues/463) added fresh-context enforcement via [PR 468](https://github.com/mfittko/dev-loops/pull/468), and [issue 867](https://github.com/mfittko/dev-loops/issues/867) escalated to an epic because nothing proved multi-angle review actually ran — angles could be silently grouped or skipped. [PR 875](https://github.com/mfittko/dev-loops/pull/875) shipped opt-in fan-out evidence enforcement, [PR 881](https://github.com/mfittko/dev-loops/pull/881) implemented the scoped-reviewer fan-out/fan-in, and [PR 882](https://github.com/mfittko/dev-loops/pull/882) flipped enforcement default-on the same day. Each reviewer still rebuilt its own view of the diff, wasting tokens and breaking reproducibility ([issue 895](https://github.com/mfittko/dev-loops/issues/895)), which [PR 899](https://github.com/mfittko/dev-loops/pull/899) fixed with a build-once neutral bundle; [issue 1207](https://github.com/mfittko/dev-loops/issues/1207), [PR 1214](https://github.com/mfittko/dev-loops/pull/1214), [PR 1229](https://github.com/mfittko/dev-loops/pull/1229), and [PR 1249](https://github.com/mfittko/dev-loops/pull/1249) then made briefings invariant-prefix-first with per-gate hash enforcement. Dispatching reviewers into isolated worktrees was tried and failed — a fresh worktree checks out `main`, not the PR head, and cannot see the gitignored bundle ([issue 1135](https://github.com/mfittko/dev-loops/issues/1135), reversed by [PR 1139](https://github.com/mfittko/dev-loops/pull/1139)). The enforcement seams live in `skills/docs/gate-review-sub-loop-contract.md`, `scripts/github/write-gate-context.mjs`, and `scripts/github/verify-briefing-prefixes.mjs`.

## Decision

Each gate pass forks one scoped, read-only, fresh-context reviewer per resolved angle and fans the per-angle findings into a consolidated verdict with a disposition ledger; fan-out evidence is enforced fail-closed by default, and an inline single-agent run requires a declared reason. A deterministic context-builder script builds ONE neutral bundle per gate pass — the full diff plus each changed file's 1-hop adjacent code, with size guards — and every reviewer is seeded with that bundle verbatim (`GATE-EXEC-BUILD-ONCE-SEED`); reviewers never inherit the orchestrating agent's conversation, and each verifies its own freshness at startup. Briefings compose invariant-prefix-first, and fan-in compares cross-reviewer prefix hashes fail-closed (`GATE-EXEC-BRIEFING-PREFIX`) so byte-identity is proven, making prompt-cache reuse possible; the cost win is work-dedup first, cache reuse as bonus. We rejected the status quo of grouped or single-agent review as unprovable and biased, rejected per-reviewer context rebuilding as wasteful and irreproducible, and — after trying it — prohibited worktree isolation for per-angle reviewers: they are read-only, so they run in the PR's actual worktree at head, where the bundle exists.

**Superseded in part by [0047](./0047-grouped-fanout-dispatch-default.md):** the
one-reviewer-per-angle cardinality this decision fixed, and the "unprovable and biased"
rejection of grouped review below, no longer hold — grouped dispatch is now the shipped
default, made provable by a static config table and a narrowed, still fail-closed pairing
floor. Every other decision here (build-once bundle, invariant-prefix-first, worktree
prohibition, fail-closed hash comparison) is unchanged.

## Consequences

The gate subsystem's cost and consistency model is fixed: reviewer independence wins over token economy, context is built exactly once, and provenance is checkable from on-disk artifacts (gate-context JSON, briefing-prefix records, reviewer sentinels, disposition ledger). Anyone adding an angle or reviewer builds against the bundle, ledger, and prefix-hash machinery rather than inventing a private context path, and a consumer tunes coverage through the angle-pool config instead of the execution shape. Re-introducing worktree isolation for per-angle reviewers is a known-rejected path — it silently reviews stale `main` without the bundle. The fail-closed hash comparison means any drift in briefing composition breaks the gate loudly instead of silently degrading cache reuse or independence. "Reviewer independence wins over token economy" is qualified by 0047: a grouped reviewer is still independent of the other groups and of the orchestrator, just not of the other angles in its own group.
