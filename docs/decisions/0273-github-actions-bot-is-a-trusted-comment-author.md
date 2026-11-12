# 0273. The GitHub Actions bot is a trusted comment author

## Status

Accepted — 2026-11-12

## Context

Source: [issue 3198](https://github.com/mfittko/dev-loops/issues/3198).

ADR 0238 admits only maintainers and the sanctioned Copilot reviewer as comment authors. ADR 0240 set the exact-login precedent for the Copilot reviewer. Workflows in this repo post findings and evidence under the `github-actions` bot identity. The predicate treated that Bot as untrusted, so those comments were skipped.

## Decision

`isTrustedCommentAuthor` trusts the exact GitHub Actions bot: a Bot whose login is `github-actions` or `github-actions[bot]`. The match is exact, like the Copilot reviewer match, and needs no opt-in flag. Lookalike logins such as `github-actions-fan` stay judged by association. The exact login with a non-Bot type is untrusted, even with a maintainer association, like the exact Copilot login. `emit-fixer-work-order.mjs` checks `isSanctionedCopilotReviewerLogin` before its Copilot branch, so a `github-actions[bot]` review body still takes the existing refusal for another bot.

## Trust ceiling

A workflow that runs on fork-controlled input, for example `pull_request_target` or `workflow_run`, can echo attacker-controlled text under the `github-actions` identity. That text can therefore reach these surfaces:

- gate evidence comments
- round inputs
- deferral markers
- carried heads
- Copilot body-disposition records

Merge approval is unaffected, because `isNonHumanAuthor` (login `[bot]` suffix or type Bot) in `packages/core/src/loop/merge-approval.mjs` excludes Bots.

## Alternatives rejected

- An opt-in flag or config list. The trusted set has no configuration surface under ADR 0238.
- A prefix match on `github-actions`. A lookalike Bot would gain trust.

## Consequences

- Comments from the GitHub Actions bot reach agents as data on every trust-filtered surface.
- Review threads from `github-actions`, skipped before, now count in `summary.unresolvedThreads` and block gate close and merge until resolved. A repo whose CI posts informational review threads must resolve them.
- Workflows that echo untrusted input carry the ceiling above and must not do so.
