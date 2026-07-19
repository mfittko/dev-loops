# 0033. Enforce single-contributor ownership: claim at pickup, fail closed on foreign or unclaimed artifacts

## Status

Accepted

## Context

Startup routing and Next Up pickup acted on any issue or PR regardless of assignee, so in a multi-contributor repo the loop could silently hijack a teammate's in-flight work or run on unclaimed items with no recorded owner. That broke the run-singleton and idempotency assumptions the conductor and board-sync model depend on: two operators pointing loops at the same board could both advance the same item with neither run visible to the other. The correction landed 2026-07-17 as a shared ownership classifier plus fail-closed gates at both entry seams ([PR 1378](https://github.com/mfittko/dev-loops/pull/1378)); see `packages/core/src/github/ownership-helpers.mjs`, `scripts/loop/resolve-dev-loop-startup.mjs`, and `scripts/projects/resolve-active-board-item.mjs`.

## Decision

We classify assignee ownership once, in core: `classifyOwnership` distinguishes assigned_to_me / assigned_to_other / assigned_to_copilot / unassigned from the assignee list and the viewer's login, and both the startup resolver and Next Up pickup enforce it through the same classifier. Routing toward implementation or continuation requires assigned_to_me: assigned_to_other fails closed naming the foreign assignees, unassigned fails closed naming the exact claim command, a PR whose linked issue is foreign-owned is treated as foreign too, and viewer-login resolution failure itself fails closed. Next Up pickup claims (`@me`) the first unassigned or viewer-owned item before handing it to the loop, re-reads to confirm the claim stuck, and skips foreign items with the reason surfaced. We rejected membership-based classification (viewer merely among the assignees counts as mine): `--add-assignee` is not compare-and-swap, so two racing loopers can end up co-assigned and membership would wave both through — assigned_to_me requires the viewer to be the sole human assignee, and a contested claim resolves by deterministic tiebreak with the loser self-unassigning. Copilot assignment is exempt and checked first, so it never needs viewer-login resolution; read-only inspection opts out via `DEVLOOPS_OWNERSHIP_BYPASS` since it only previews routing and never starts or claims anything.

## Consequences

The dev loop is safe to run concurrently by multiple contributors against one repo and board: each run only ever advances items its operator has explicitly claimed, and claiming is a deliberate act surfaced in the fail-closed message rather than an implicit side effect. New pickup or continuation paths must route through the shared classifier rather than re-deriving ownership from raw assignee reads. Read-only tooling stays usable on foreign items via the explicit bypass, at the cost of one more environment variable to know about. The non-atomic claim leaves accepted residual races — a racer can complete its claim and proceed before the other's claim lands — bounded by the tiebreak and best-effort self-unclaim rather than eliminated.
