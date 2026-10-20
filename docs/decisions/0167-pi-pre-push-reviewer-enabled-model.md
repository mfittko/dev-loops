# 0167. Pin the Pi pre-push reviewer to the enabled Codex model

## Status

Proposed

## Context

[Issue #2854](https://github.com/mfittko/dev-loops/issues/2854) records that this repo's `models.tiers.pre-pr-strong.pi` selects `openai-codex/gpt-6-sol`, which is absent from the operator's Pi `enabledModels`. Reviewer dispatch consequently fails as a transport error and retries instead of starting. The enabled replacement is `openai-codex/gpt-6.1-sol`.

## Decision

Amend the Pi model choice in [ADR 0079](./0079-pre-pr-review-phase.md) under the config-resolved policy of [ADR 0031](./0031-harness-aware-model-tier-policy.md): set this repo's `.devloops` `models.tiers.pre-pr-strong.pi` to `openai-codex/gpt-6.1-sol`. Keep the explicit tier pin, the `pre-push-reviewer` role mapping and the Claude `opus` value unchanged.

Reject retaining the unavailable id or removing the Pi override to inherit an arbitrary session model. Neither preserves an explicit, usable reviewer choice.

## Consequences

The Pi pre-push reviewer selects the enabled model without changing Claude capabilities, shipped defaults or resolver precedence. The config contract test pins the corrected id. This is a repo-specific correction, not runtime validation of `enabledModels`; typed model refusal and retry classification remain outside this slice.
