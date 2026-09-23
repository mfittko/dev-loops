# 0082. Run the Claude pre-PR reviewer on Opus 5.5 instead of Fable

## Status

Accepted — 2026-09-23 ([issue #2367](https://github.com/mfittko/dev-loops/issues/2367), [PR 2373](https://github.com/mfittko/dev-loops/pull/2373))

Amends the Claude-harness model choice of [0079](./0079-pre-pr-review-phase.md). It keeps the rest of that decision unchanged: the pre-PR review phase, its config-resolved model seam, and the Pi-harness value.

## Context

ADR 0079 opted this repo's Claude-Code harness pre-PR reviewer into Fable, so `.devloops` sets `models.tiers.pre-pr-strong.claude: fable`. The pre-PR reviewer is a single code-review dispatch before the first push.

Anthropic's Opus 5.5 announcement (https://www.anthropic.com/claude-opus-5-5) states that Opus 5.5 performs at the level of Fable 5.1 on most work, at lower cost. On code review it caught 72% of bugs at the lowest effort level, against 56% for Opus 5 at high effort. The page gives no direct Fable 5.1 against Opus 5.5 code-review number. The operator accepted the vendor comparison as sufficient evidence (grill results on issue #2367).

## Decision

This repo sets `models.tiers.pre-pr-strong.claude` to `opus`. On current Claude Code the `opus` token resolves to Opus 5.5 (identity `claude-opus-5-5`), and it follows the Opus family alias on a Claude Code upgrade. The token is a member of the Agent-tool `model` enum (`sonnet|opus|haiku|fable`), so the harness-token rule from 0079 still holds.

The pin stays explicit. We rejected removing the Claude value so the reviewer inherits the session model: a session started on another model would silently change the reviewer. We also rejected a before/after benchmark gate round; the vendor comparison is the accepted evidence.

## Consequences

The one pre-PR review call per tracker-backed run costs less, with review strength the vendor reports as equal to Fable. The reviewer model now moves with the Opus family alias, so a Claude Code upgrade can change it without a `.devloops` edit. An operator who wants Fable back sets the Claude value to `fable` again, as `skills/docs/pre-pr-review-contract.md` documents. `test/contracts/devloops-tier-config.test.mjs` pins the new value.
