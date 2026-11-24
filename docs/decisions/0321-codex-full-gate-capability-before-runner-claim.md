# 0321. Check Codex full-gate capability before claiming the runner

## Status

Accepted — 2026-11-24 ([issue 3549](https://github.com/mfittko/dev-loops/issues/3549)).

## Context

A verified Codex child can acquire the PR runner claim before discovering that its tools lack native reviewer dispatch. The gate must refuse, but the claim and hand-back cycle is avoidable.

## Decision

The running coordinator observes its actual tool surface before ordinary PR handoff. Observed absence of `collaboration.spawn_agent` supplies the internal `--codex-reviewer-spawn-unavailable` signal. At the shared handoff boundary, live gate coordination and the existing dispatch resolver decide whether the route requires full lifecycle fan-out. Only that Codex case returns `FANOUT_UNAVAILABLE` before runner ownership acquisition. The signal grants no authority and persists no capability state.

Tool-present entry keeps its existing path. Inline, non-gate, Pi and Claude routing stay unchanged. The runbook retains its final capability check, and normal identity, ownership, head, CI, role, work-order and evidence rechecks remain authoritative. Recovery is ordinary PR entry in a verified child with the tool, including on the same head.

## Consequences

The refusing entry creates no runner claim or gate evidence to repair. Coordination may still write its normal snapshot or release an existing terminal claim. The observation is supplied by the agent; this adds no native runtime tool enforcement. A head or route change can still reach the final runbook refusal.
