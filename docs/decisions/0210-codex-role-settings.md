# 0210. Resolve Codex role settings at ordinary native dispatch boundaries

## Status

Accepted — 2026-10-29 ([issue 2914](https://github.com/mfittko/dev-loops/issues/2914), ordinary-role slice).

## Context

ADR 0182 only admits conductor settings. Ordinary workers need persisted model
and effort selection without borrowing Claude/Pi concrete values.

## Decision

Add strict nullable settings objects under `models.harnesses.codex.roles` and
`.tiers`. Merge each object's fields across layers, including null clearing.
Resolve shared role-tier aliases against final merged definitions, preserving
legacy alias validation. Select an explicit role object as a unit, otherwise
the shared/built-in role tier; absent Codex mappings and `inherit` inherit.

Extend `gate resolve-role` with mutually exclusive `--role <name> --harness codex`.
Ordinary callers forward its non-null native overrides unchanged with fresh
context, stopping on config/native failure. Pre-push review remains a role.
The self-host mapping uses gpt-6.1-sol for low and gpt-6-astra for high and
pre-pr-strong; consumer defaults remain inherited. Preserve Claude/Pi behavior.

## Consequences

This partially supersedes ADR 0182's role/tier prohibition. Gate-angle settings
remain invalid. Judge/fixer immutable emitter binding is deferred to the next
slice under issue 2914; resolving those role names does not apply their settings
to emitted work orders. No launcher, root settings or lifecycle authority changes.
Native qualification distinguishes requested/emitted settings from unavailable
observed telemetry and does not claim full harness parity.
