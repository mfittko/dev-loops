# 0158. A judge-keyed round cap ends the draft_gate round sequence

## Status

Accepted — 2026-10-18 ([issue 2462](https://github.com/mfittko/dev-loops/issues/2462))

Extends the round-count policy of [0109](./0109-cumulative-prior-dispositions-within-one-gate.md) and the judge act list of [0089](./0089-judge-act-list-drives-review-verdict.md). Slice 1b of the same issue adds the `delta_verified` evidence kind and the amendments to [0089](./0089-judge-act-list-drives-review-verdict.md) and [0094](./0094-pre-push-reviewer-delta-mode.md). This record changes neither. <!-- secret-scan:allow ADR file links, not a credential -->

## Context

Across 49 PRs with 2 or more draft rounds, 50, 70, 81 and 89 percent of new judge `act` findings were first seen by the end of round 1, 2, 3 and 4. Rounds 4 and later added 99 first-seen act findings, and 25 of 63 such rounds found none. The posted `round=` marker also drifted from the real round count: one PR posted round 14 after 6 real rounds.

## Decision

`gates.draft.maxReviewRounds` sets the cap for `draft_gate`. The default is 4, `0` disables the cap, and an invalid value fails config resolution. `pre_approval_gate` is not capped.

- Count. One completed round is one durable `draft_gate` ledger of the PR with verdict `clean` or `findings_present`. The round being posted counts. An in-range ledger that fails to parse to an object counts. A parseable ledger with absent or mismatched identity fields or an invalid verdict is dropped and does not count. A round is past the cap when its count is at or above the cap. The posted `round=` marker counts every `<gate>-<full-sha>.json` findings log. The cap additionally drops blocked and identity-mismatched ledgers.
- New act. A judge `act` item is new unless it carries `resurfaces: <fingerprint>` and the fingerprint is an act fingerprint of a closed prior round. `judge-pass.mjs` and the findings-log writer drop every other mark.
- Convergence stop. A round with no new act item ends the sequence, unless it is below the cap and a re-surfaced `high` or `medium` act item is open.
- Past the cap, and at a convergence stop, every open act item composes `blocked` with a `round_cap_reached` blocker through `composeCheckpointVerdict`. No fixer runs. This slice applies the rule to `low` and `nit` too, with no carry, because it fails closed.
- Past the cap, a judge `defer` or `reject` is recorded as `capClosed` and needs no commit. A reviewer `high` or `medium` that the judge defers or rejects, a missing disposition and an unknown severity join the verdict as `severity_disagreement` blockers. A `question` with a file and line stays open. The verdict comment and the merge-ready result list every `capClosed` item.
- Ledger only. Cap logic, the convergence stop and `capClosed` run on a judged ledger (`--findings-ledger`). A `--findings-json`-only post that needs a cap decision (`draft_gate`, `maxReviewRounds` above 0, round at or past the cap) is refused with an error that names the ledger path, as is a ledger post whose `--findings-json` carries an act item the ledger does not list. Below the cap, a plain `--findings-json` post is unchanged.

Rejected: cap-closing a judge `act` (it hides a finding the judge wants fixed), and a per-category severity floor (more policy than the measured evidence supports).

## Consequences

A PR whose round 4 still has an open act item stops with `blocked` and goes to the operator instead of starting round 5. A `low` or `nit` act item past the cap also stops until slice 1b adds the verified fix path. Retrospectives measure cap quality against the v1.0.6 baseline (`RETRO-ROUND-CAP-QUALITY`).
