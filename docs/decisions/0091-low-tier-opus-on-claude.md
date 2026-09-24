# 0091. Run the built-in low tier on Opus on Claude

## Status

Accepted — 2026-09-24 ([PR 2433](https://github.com/mfittko/dev-loops/pull/2433))

Amends the built-in Claude value of the `low` tier of [0031](./0031-harness-aware-model-tier-policy.md). It keeps the rest of that decision unchanged: the tier mechanism, `models.tiers`, `models.roleTiers` and `resolveRoleModel`, the low/high split, the precedence order, and the Pi-null zero-config default.

## Context

ADR 0031 set the built-in `low` tier to `sonnet` on Claude. The `low` tier runs the `developer`, `docs`, `fixer` and `quality` roles.

A consumer soak run of `1.0.4-pre.2` was measured with `dev-loops loop audit-session`. The sonnet fixer ran 158 turns. Its prompt grew from 18k to 167k tokens, a 9.1x growth. It used 16M tokens in total. That is more than every opus review agent in the same run combined. Opus 5.5 is currently the most cost-efficient Claude model per task.

## Decision

`BUILTIN_TIERS.low.claude` becomes `opus`. The low/high split stays. An operator can move `low` back with one line: `models.tiers.low.claude`.

We rejected keeping `sonnet`: the measured run shows it costs more per task. We also rejected removing the low/high split: both tiers now resolve to the same Claude model, but the split keeps a one-line override for an operator whose economics differ.

## Consequences

Routine roles on Claude cost less per task in the measured run. The generated `.claude/agents/{developer,docs,fixer,quality}.md` files carry `model: "opus"`. Tier-provenance tests set a distinct `low` id, because the built-in low and high values are now equal on Claude. `packages/core/test/config.test.mjs` pins that a `models.tiers.low.claude: "sonnet"` override moves all four routine roles back to `sonnet`. The built-in value drifts with model generations and needs retuning when the per-task economics change.
