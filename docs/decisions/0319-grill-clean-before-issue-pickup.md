# 0319. An issue pickup needs a clean grill with a simplicity review

## Status

Accepted, 2026-11-22 ([issue 3462](https://github.com/mfittko/dev-loops/issues/3462)). Builds on [0281](0281-regrill-on-spec-change.md), ADR 0084 and ADR 0154.

## Context

`DESIGN-SIMPLEST-FIRST` has existed since 2026-10-20 and nothing enforced it where work starts. `loop startup` derived readiness from an acceptance-criteria heading, and the local-first route never read it. Startup stopped only a spec that changed after a grill, so a never-grilled issue started work. 16 of the last 20 merged PRs closed an issue with no grill results comment and no `## Simplest design` section. The grill had no simplicity check, and the author of a design was its only simplicity judge. The shipped `refinement.roles` setting listed `kiss` and no caller read it.

## Decision

`GRILL-SUBLOOP-SIMPLICITY-REVIEW` in [the public dev-loop contract](../../skills/docs/public-dev-loop-contract.md) owns the rule.

- The grill detector returns `grill_clean` for an issue only with recorded provenance, a `## Simplest design` section outside code fences and a `simplicity-review:` line in the latest results comment (latest by `createdAt`, findings equal to corrected plus rejected). `buildGrillFactsSnapshot` is the one reader of these facts and of the open-gap check for startup and the grill, and with `--repo` and `--number` the detector takes the fetched comments. The pr and plan surfaces keep their route.
- An issue pickup in `loop startup` stops before any claim write, on every target preference, unless that detector returns `grill_clean`. The stop prints the grill command. A failed read stops with the `loop startup --issue <n>` retry command, with the caller's `--claim` and `--lightweight`. An issue assigned to another human keeps its ownership refusal.
- Four routes keep their behavior: resuming an issue or PR with an open PR, `--lightweight` without an issue, `prefer_local` with the `phase-docs` input source, and local plan files.
- The grill gives its spec to one fresh `review` agent that did not write it. The shipped default of `refinement.roles` changes from `scope`, `coverage`, `dry`, `kiss` to `kiss` and `yagni`, and these are the prompts of that review.
- `kiss` and `yagni` are mandatory draft gate angles in this repository from round 1.

## Consequences

- Consumers: the shipped defaults are `strategy: local-first` and `inputSource: tracker`. Each consumer issue pickup without a clean grill stops and prints the grill command.
- An issue grilled before this change needs one more grill, because it has no `simplicity-review:` line.
- Work with an open PR keeps its route.
- The grill adds one fresh reviewer per issue.
- Who wrote a results comment stays outside the check (ADR 0084, amended by ADR 0154).
- Cutover: `kiss` and `yagni` become mandatory draft angles, and `buildFanoutEnforcement` checks an older draft ledger against the mandatory angles of the current head config. A ready PR that passed `draft_gate` before this change then fails with `fan-out provenance is missing mandatory angle(s): kiss, yagni` once it merges main. This change merges after the ready PRs 3447, 3456 and 3449, so they pass under the old config. A PR still below the round cap can run `dev-loops pr convert-to-draft` for the repo and PR and then a new draft round at its current head. At the round cap no new round can run, so that route is no general recovery. This change makes no enforcement change.
- The growth stop during fix rounds is [issue 3464](https://github.com/mfittko/dev-loops/issues/3464).
