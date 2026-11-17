# 0283. Size budget skips vendored and generated hook files

## Status

Accepted — 2026-11-16 ([PR 3231](https://github.com/mfittko/dev-loops/pull/3231)).

Amends the `SIZE-RUNTIME-PIN-ACCOUNTING` rule in the [pre-PR review contract](../../skills/docs/pre-pr-review-contract.md).

## Context

The size budget counted vendored third-party code and generated mirror files as whole-PR logic LOC. The 2442 branch counts 3,863 logic lines. About 2,600 are vendored `sh-syntax` under `.claude/hooks/_vendor/`. About 487 are the generated `.claude/hooks/_bash-command-classify.mjs` mirror. `pr create` refused with `size_split_required_before_pr`, and a split cannot help. See [PR 3231](https://github.com/mfittko/dev-loops/pull/3231).

## Decision

1. `scripts/loop/check-size-budget.mjs` counts 0 logic LOC for a file whose path starts with `.claude/hooks/_vendor/` or equals a `HOOK_BUNDLE` target path. Such a file also leaves the source and unclassified counters.
2. `scripts/claude/generate-claude-assets.mjs` exports `HOOK_BUNDLE_TARGETS`. The generator stays the single owner of the mirror list. The `packages/core` sources of the mirrors keep counting.
3. Paths compare raw, as git prints them. No separator normalization can widen the match.
4. The rule is built in. No config option exists, so a PR-head config cannot widen it.
5. Rejected: a `**/_vendor/**` glob. Any PR could then hide logic LOC by placing a file in a `_vendor` directory. The rule therefore names one fixed prefix and an exact target list.

## Consequences

- A vendored dependency swap under `.claude/hooks/_vendor/` can open a PR.
- Hand-edited files under `.claude/hooks` that are not in `HOOK_BUNDLE`, and a `_vendor` directory elsewhere, keep counting.
- Known limit: a PR that deletes a mirror's `packages/core` source can leave a hand-written file at that mirror path. The deleted source lines still count.
- Known limit: the `_vendor` prefix exempts any file under it. A byte-parity check for those files exists only on the unmerged 2442 branch. Tighten later by reusing that parity file list.
