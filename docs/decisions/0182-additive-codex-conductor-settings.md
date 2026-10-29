# 0182. Add Codex conductor settings at existing native dispatch boundaries

## Status

Accepted — 2026-10-23 ([issue 2913](https://github.com/mfittko/dev-loops/issues/2913)).

Partially superseded by [ADR 0210](0210-codex-role-settings.md) for Codex role and tier settings and ordinary role dispatch; conductor and immutable emitter behavior remain unchanged.

## Context

[Issue 2015](https://github.com/mfittko/dev-loops/issues/2015) specifies a canonical
harness-scoped model/effort destination and a wider migration. This slice makes
only the Codex conductor usable without coupling every role and gate consumer.

## Decision

Add `models.harnesses.codex.conductor` with optional nullable `model` and
`reasoningEffort` fields. Reject empty settings and unknown fields. Merge fields
across layers, with explicit null clearing; select this object as a unit and
never borrow legacy concrete settings. Keep existing Claude/Pi behavior.

Use the existing config export, `gate resolve-role --conductor --harness codex`
selector and coordinator emitter. Translate effort to `reasoning_effort` only
at native dispatch. Omit null fields, use `fork_turns: "none"`, and stop on
configuration or native rejection without a default replacement. Settings stay
outside work-order identity/digests and grant no authority. Native calls are
agent-driven; qualification records requested, emitted and observed settings
separately, with unknown telemetry explicit.

This is additive to 2015, not its migration: legacy settings remain supported
for Claude/Pi. Codex worker, role, tier and gate-angle fields remain invalid.
No shipped production policy, root-session/global settings change or full
installation/headless support is claimed.

## Consequences

Operators opt in only for separately spawned Codex conductors. Existing pull
consumers receive identical semantic orders; native spawn consumers must accept
the optional native fields and preserve the pointer. The canonical procedure
and opt-in example live in the [main-agent contract](../../skills/docs/main-agent-contract.md#codex-coordinator-dispatch).
