# 0266. Claude role models resolve at dispatch time from .devloops

## Status

Accepted — 2026-11-12 ([PR 3189](https://github.com/mfittko/dev-loops/pull/3189))

Amends [0031](./0031-harness-aware-model-tier-policy.md): the Claude mechanism changes from baked agent frontmatter alone to dispatch-time resolution with baked frontmatter as the fallback. Every other decision of that record stays in force, and the record stays unedited. Builds on [0175](./0175-tier-policy-shape-owned-by-the-repo-not-the-model-id.md) and [0176](./0176-tier-distinctness-is-an-operator-model-choice.md).

## Context

The operator chose mechanism A on [issue 3133](https://github.com/mfittko/dev-loops/issues/3133) on 2026-11-09. ADR 0031 names baked agent frontmatter as the Claude mechanism. Asset generation does not read a consumer's `.devloops`, so baked frontmatter cannot carry the consumer's `models.tiers` or `models.roles`. A consumer who retunes a tier sees no effect on Claude.

## Decision

Claude dispatch passes `resolveRoleModel(loadedConfig, { role, harness: "claude" })` as the Agent `model` parameter. Agents get the value from `gate resolve-role --harness claude`. The `dev-loop` and `fixer` roles get it from the work-order emitters. The baked frontmatter stays as the fallback when dispatch passes no model. The built-in default stays `opus`. Pi and Codex resolution is unchanged.

## Consequences

- A consumer's `.devloops` tiers and role overrides take effect on Claude without regenerating assets.
- Dispatchers must pass the resolved value. A dispatcher that omits it falls back to the baked built-in policy.
- A `null` result passes no model, so the baked frontmatter applies.
