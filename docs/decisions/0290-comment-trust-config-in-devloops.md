# 0290. Comment trust is configurable in `.devloops` and read from the default branch only

## Status

Accepted, 2026-11-17 ([issue 3198](https://github.com/mfittko/dev-loops/issues/3198)).

Extends [ADR 0238](./0238-comment-text-from-non-maintainers-never-reaches-an-agent.md) as amended by [ADR 0240](./0240-copilot-reviewer-matched-by-exact-login.md), and [ADR 0273](./0273-github-actions-bot-is-a-trusted-comment-author.md). Those records stay unedited.

## Context

Source: [issue 3198](https://github.com/mfittko/dev-loops/issues/3198).

ADR 0238, as amended by ADR 0240, fixes the trusted comment authors in the predicate. ADR 0273 adds the exact GitHub Actions bot with no opt-in and defers a configuration allowlist to part 2. Repos also post review threads from review apps such as reviewdog, and some repos must turn the GitHub Actions bot trust off because of the `pull_request_target` echo ceiling that ADR 0273 records.

## Decision

`.devloops` accepts a strict `trust` block: `githubActionsBot` (boolean, default true) and `reviewers` (a list of GitHub logins with an optional `[bot]` suffix). The match is exact and case-insensitive. A `[bot]` entry also requires type Bot. A plain entry matches that login, and with a Bot type also the `<login>[bot]` form. The list only adds trust. Maintainer associations, the viewer's own comments and the sanctioned Copilot reviewer stay trusted. `githubActionsBot: false` removes only the ADR 0273 trust.

The config is read only from `.devloops` on `origin/<default branch>` through `readDefaultBranchConfig`, never from the worktree, the PR head or `.pi/dev-loop/defaults.*`. A PR cannot grant itself trust.

`comment-trust.mjs` holds a process-scoped config, set once through `setCommentTrustConfig`. `scripts/github/_comment-trust-config.mjs` loads and validates it, and each entry script that reads trust-filtered text calls it once in its direct-run block before the first trust read.

Load outcomes fail closed. No `.devloops` or no `trust` key applies the built-in defaults. An unresolved default branch, a failed fetch, an unreadable file or an invalid `trust` block refuses the run with a typed error, because defaults would silently undo a `githubActionsBot: false` opt-out.

The read fetches `origin/<default branch>` first, because a stale local ref would undo a `githubActionsBot: false` opt-out. The cost is one network round trip per entry-script start, and an offline run refuses.

## Alternatives rejected

- Reading `trust` from the PR head or the worktree. A PR could grant itself trust.
- A trust option on every predicate call. A missed call site would silently ignore an opt-out.
- A lazy git read in the core predicate. It would fetch from unit tests and from paths with no checkout.
- Falling back to defaults when the read fails. It would undo an opt-out.

## Consequences

- A repo trusts its review apps without a maintainer association, and can opt out of the GitHub Actions bot trust.
- `isNonHumanAuthor` in merge approval still excludes every Bot, so a `trust.reviewers` login never approves a merge.
- The review-body fixer rule is unchanged.
