# 0273. The GitHub Actions bot is a trusted comment author

## Status

Accepted — 2026-11-12

## Context

Source: [issue 3198](https://github.com/mfittko/dev-loops/issues/3198).

ADR 0238 admits only maintainers and the sanctioned Copilot reviewer as comment authors. Workflows in this repo post findings and evidence under the `github-actions` bot identity. The predicate treated that Bot as untrusted, so those comments were skipped.

## Decision

`isTrustedCommentAuthor` trusts the exact GitHub Actions bot: a Bot whose login is `github-actions` or `github-actions[bot]`. The match is exact, like the Copilot reviewer match, and needs no opt-in flag. Lookalike logins and `User` accounts stay judged by association. `emit-fixer-work-order.mjs` checks `isSanctionedCopilotReviewerLogin` before its Copilot branch, so a `github-actions[bot]` review body still takes the existing refusal for another bot.

## Trust ceiling

A `pull_request_target` workflow can echo attacker-controlled text under the `github-actions` identity. That text can therefore reach these surfaces:

- gate evidence comments
- round inputs
- deferral markers
- carried heads
- Copilot body-disposition records

Merge approval is unaffected, because `isNonHumanLogin` excludes Bots.

## Alternatives rejected

- An opt-in flag or config list. The trusted set has no configuration surface under ADR 0238.
- A prefix match on `github-actions`. A lookalike Bot would gain trust.

## Consequences

- Comments from the GitHub Actions bot reach agents as data on every trust-filtered surface.
- Workflows that echo untrusted input carry the ceiling above and must not do so.
