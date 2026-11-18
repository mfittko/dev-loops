# 0290. Comment trust is configurable in `.devloops` and read from the default branch only

## Status

Accepted, 2026-11-17 ([issue 3198](https://github.com/mfittko/dev-loops/issues/3198)).

Extends [ADR 0238](./0238-comment-text-from-non-maintainers-never-reaches-an-agent.md) as amended by [ADR 0240](./0240-copilot-reviewer-matched-by-exact-login.md), [ADR 0248](./0248-detector-evidence-trust-filter.md) and [ADR 0273](./0273-github-actions-bot-is-a-trusted-comment-author.md). Those records stay unedited.

## Context

Source: [issue 3198](https://github.com/mfittko/dev-loops/issues/3198).

ADR 0238, as amended by ADR 0240, fixes the trusted comment authors in the predicate. ADR 0273 adds the exact GitHub Actions bot with no opt-in and defers a configuration allowlist to part 2. Repos also post review threads from review apps such as reviewdog, and some repos must turn the GitHub Actions bot trust off because of the `pull_request_target` echo ceiling that ADR 0273 records.

## Decision

`.devloops` accepts a strict `trust` block: `githubActionsBot` (boolean, default true) and `reviewers` (a list of GitHub logins with an optional `[bot]` suffix). The match is exact and case-insensitive. The `[bot]` suffix is stripped from the entry and from the author login, because GraphQL returns a Bot login without it and REST returns it with it. A `[bot]` entry also requires type Bot. A plain entry matches that login, and with a Bot type either login form. The list only adds trust. Maintainer associations, the viewer's own comments and the sanctioned Copilot reviewer stay trusted. `githubActionsBot: false` removes only the ADR 0273 trust.

The config is read only from `.devloops` on the local `origin/<default branch>` ref through `readDefaultBranchConfig`, never from the worktree, the PR head or `.pi/dev-loop/defaults.*`. A PR cannot grant itself trust.

`comment-trust.mjs` holds a process-scoped config, set once through `setCommentTrustConfig`. `scripts/github/_comment-trust-config.mjs` loads and validates it, and each entry script that reads trust-filtered text, directly or through a `_`-prefixed helper, calls it once in its direct-run block before the first trust read. An entry script that makes no trust read, such as `pull-work-order.mjs`, does not load it, so it needs no `origin/HEAD` and no ref.

Load outcomes fail closed. No `.devloops` or no `trust` key applies the built-in defaults. An unresolved default branch, an absent local `origin/<default branch>` ref, an unreadable file or an invalid `trust` block refuses the run with a typed error, because defaults would silently undo a `githubActionsBot: false` opt-out.

The read never runs `git fetch`. It reads the local `origin/<default branch>` ref only, so it needs no network and cannot race another entry script on the ref lock. The trade-off is staleness: a checkout whose local ref predates a merged change keeps the old trust set, so a removed `trust.reviewers` login stays trusted and a merged `githubActionsBot: false` has no effect until the operator runs `git fetch origin`. Refreshing the ref is the operator's, and the load cannot detect a stale ref. The `gate-evidence` workflow publishes `origin/HEAD` with `git remote set-head origin` from the event's default branch before each detector step, with no guessed default name.

A refused load prints one JSON line `{ "ok": false, "error": "<message>", "state": "<typed state>" }` on stderr, the shared CLI error envelope plus the typed `state`, and exits 3. Exit 3 is free in every loading script, and each loading script that documents exit codes lists it in its `--help` Exit codes. Exit 0, 1 and 2 stay each entry script's own (2 is an invalid `--jq` filter in most of them and a usage or IO error in the work-order emitters), so callers key on the stderr `state` field. Every refusal names its remedy: `git remote set-head origin --auto` for an unset `origin/HEAD` and `git fetch origin` for an absent local ref. An invalid or unreadable file is fixed on the default branch first, then `git fetch origin`. A `--help` or `-h` run makes no trust read, so the load is skipped.

## Alternatives rejected

- Reading `trust` from the PR head or the worktree. A PR could grant itself trust.
- A trust option on every predicate call. A missed call site would silently ignore an opt-out.
- A lazy git read in the core predicate. It would fetch from unit tests and from paths with no checkout.
- Falling back to defaults when the read fails. It would undo an opt-out.

## Consequences

- A repo trusts its review apps without a maintainer association, and can opt out of the GitHub Actions bot trust.
- `isNonHumanAuthor` in merge approval still excludes every Bot, so a `trust.reviewers` login never approves a merge. The size-budget human approval counts only entries with a maintainer association.
- A `trust.reviewers` login is not a review-body fixer source. Only a trusted human by maintainer association or the sanctioned Copilot reviewer is.
- The trust read binds to the origin of the cwd checkout, or to `--repo-root` where a script has that option. It does not bind to the `--repo` argument, so run a script from a checkout of the repo it inspects.
- `packages/core/bin/parse-review-threads.mjs` runs with the built-in defaults and does not load the config.
- A `trust.reviewers` login is a trusted author on every gate-evidence surface that calls the shared predicate: verdict comments, round inputs (`filterTrustedRoundInputs`), deferral markers, the carried-heads record and Copilot body-disposition records. This is the same ceiling ADR 0273 records for the GitHub Actions bot, so list only an app or person you accept as an author of gate evidence.
