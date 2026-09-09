# 0067. Worktree-isolation gate asserts the core-isolation invariant, not the tmp/worktrees path prefix

## Status

Accepted — 2026-09-09 ([issue 2063](https://github.com/mfittko/dev-loops/issues/2063))

Amends the enforcement posture ADR 0014 introduced: the `tmp/worktrees/dev-loops/<kind>-<number>` namespace stays the default, recommended location and the sole `ensure-worktree.mjs` provisioning path is unchanged. What changes is the admit/reject CONDITION the pre-flight gate and startup resolver apply — from a path prefix to the real isolation invariant. ADR 0014's namespace-owned destructive-cleanup safety (`cleanup-worktree.mjs` only ever removing `tmp/worktrees/dev-loops/` paths) is untouched.

## Context

ADR 0014 made `local_implementation` reject any checkout not under `tmp/worktrees/`. Both enforcement sites (`checkWorktreeIsolation` in `scripts/loop/pre-flight-gate.mjs`, and the `local_implementation` block in `scripts/loop/resolve-dev-loop-startup.mjs`) tested the path prefix FIRST and returned `not_in_worktree`/`main_checkout_detected` before the real isolation invariant ran; `isWorktreeCoreIsolated` itself short-circuited to a vacuous `true` for any outside checkout because `resolveContainingWorktreeRoot` filtered to `tmp/worktrees/`-scoped paths. A sibling/linked checkout that already satisfied the real invariant (its `node_modules/@dev-loops/core` realpath equals its own `packages/core` realpath) was rejected on path prefix alone, and the two documented env escapes (`DEVLOOPS_WORKTREE_BYPASS`, `DEVLOOPS_PREFLIGHT_BYPASS`) are unreachable under the Claude auto-mode classifier, which blocks env-prefix commands ([issue 2063](https://github.com/mfittko/dev-loops/issues/2063)).

## Decision

The worktree-isolation gate asserts the real invariant the path prefix only stood in for: a checkout's `node_modules/@dev-loops/core` resolves to its OWN `packages/core`. `resolveContainingWorktreeRoot` resolves any listed worktree root (longest/innermost match), so the invariant is computed for a checkout outside `tmp/worktrees/` instead of vacuously satisfied. A single shared decision, `classifyWorktreeIsolation` (`packages/core/src/loop/worktree-guard.mjs`), is the one source both enforcement sites route through so they cannot diverge: it still rejects the main checkout (`main_checkout_detected`) and a fake `tmp/worktrees/` directory that is not a real git worktree, admits an outside checkout that satisfies core isolation, and fails closed (`not_in_worktree`) for an outside checkout whose core link escapes its own `packages/core`. The relaxed invariant removes the need for an env bypass in the verified-isolation case, so no new bypass flag ships.

## Consequences

A verified core-isolated sibling/linked checkout can run `local_implementation` without an unreachable env escape, while a non-isolated checkout — outside `tmp/worktrees/` with a core link that escapes its own `packages/core`, or the main checkout — is still rejected with actionable `ensure-worktree.mjs` guidance. `tmp/worktrees/` remains the recommended default and the only provisioned layout; ADR 0014's namespace-scoped cleanup safety is unchanged because cleanup still keys on the namespace, not on the admit decision. The gate now depends on a resolvable `git worktree list` plus the checkout's own `packages/core`/`node_modules` link rather than a literal path segment.
